/**
 * /v1/messages Route Handler for Cloudflare Worker (Anthropic API compatible)
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    MODEL_FALLBACK_MAP,
    isThinkingModel
} from '../constants.js';
import { buildCloudCodeRequest, buildHeaders } from '../cloudcode/request-builder.js';
import { streamSSEResponse } from '../cloudcode/sse-streamer.js';
import { getCachedAccessToken } from '../cloudcode/oauth.js';
import { convertGoogleToAnthropic } from '../format/index.js';
import {
    getAvailableAccounts,
    setAccountCooldown,
    updateAccountLastUsed,
    recordUsage,
    validateApiKey,
    getSetting
} from '../db/queries.js';

export async function handleMessages(c) {
    const db = c.env.DB;
    const body = await c.req.json();

    // 1. Validate API Key if client sent an Authorization header or x-api-key
    const authHeader = c.req.header('authorization') || '';
    const apiKeyHeader = c.req.header('x-api-key') || '';
    const clientKey = apiKeyHeader || authHeader.replace(/^Bearer\s+/i, '');

    let keyRecord = null;
    if (clientKey) {
        keyRecord = await validateApiKey(db, clientKey);
        // If PROXY_API_KEY environment variable is set and matches, allow it
        if (!keyRecord && c.env.PROXY_API_KEY && clientKey === c.env.PROXY_API_KEY) {
            keyRecord = { id: 'env_master', name: 'Master Key' };
        } else if (!keyRecord && c.env.PROXY_API_KEY) {
            return c.json({ error: { type: 'authentication_error', message: 'Invalid API key' } }, 401);
        }
    } else if (c.env.PROXY_API_KEY) {
        return c.json({ error: { type: 'authentication_error', message: 'Missing API key' } }, 401);
    }

    let requestedModel = body.model || 'claude-3-7-sonnet';
    const isStream = Boolean(body.stream);
    const fallbackSetting = await getSetting(db, 'fallback_enabled', c.env.ENABLE_FALLBACK || 'true');
    const fallbackEnabled = fallbackSetting === 'true';

    // 2. Fetch available accounts from D1
    let accounts = await getAvailableAccounts(db);

    if (accounts.length === 0) {
        return c.json({
            error: {
                type: 'rate_limit_error',
                message: 'All configured accounts are currently rate-limited or on cooldown. Please retry shortly.'
            }
        }, 429);
    }

    // Account rotation retry loop
    const maxAttempts = Math.max(accounts.length * 2, 4);
    let currentModel = requestedModel;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Re-check available accounts
        accounts = await getAvailableAccounts(db);
        if (accounts.length === 0) {
            if (fallbackEnabled && MODEL_FALLBACK_MAP[currentModel]) {
                currentModel = MODEL_FALLBACK_MAP[currentModel];
                accounts = await getAvailableAccounts(db);
            }
            if (accounts.length === 0) {
                return c.json({
                    error: {
                        type: 'rate_limit_error',
                        message: 'All accounts exhausted or rate-limited.'
                    }
                }, 429);
            }
        }

        // Select account (round-robin / least recently used)
        const account = accounts[0];
        await updateAccountLastUsed(db, account.id);

        let accessToken;
        try {
            accessToken = await getCachedAccessToken(account);
        } catch (authErr) {
            await setAccountCooldown(db, account.id, 300); // 5 min cooldown for bad auth
            continue;
        }

        const effectiveRequest = { ...body, model: currentModel };
        const payload = buildCloudCodeRequest(effectiveRequest, account.project_id, account.email);

        // Try Google endpoints
        let success = false;
        let response = null;

        for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
            const isThinking = isThinkingModel(currentModel);
            const url = isStream || isThinking
                ? `${endpoint}/v1internal:streamGenerateContent?alt=sse`
                : `${endpoint}/v1internal:generateContent`;

            const acceptHeader = (isStream || isThinking) ? 'text/event-stream' : 'application/json';
            const headers = buildHeaders(accessToken, currentModel, acceptHeader, payload.request.sessionId);

            try {
                response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(payload)
                });

                if (response.status === 429 || response.status === 403) {
                    const errText = await response.text();
                    lastError = { status: response.status, text: errText };
                    if (accounts.length > 1) {
                        await setAccountCooldown(db, account.id, 60);
                    }
                    break; // Switch to next account
                }

                if (!response.ok) {
                    const errText = await response.text();
                    lastError = { status: response.status, text: errText };
                    if (response.status === 401) {
                        if (accounts.length > 1) {
                            await setAccountCooldown(db, account.id, 120);
                        }
                        break;
                    }
                    continue; // Try next endpoint
                }

                success = true;
                break;
            } catch (netErr) {
                lastError = { status: 503, text: netErr.message };
                continue;
            }
        }

        if (!success || !response) {
            if (fallbackEnabled && MODEL_FALLBACK_MAP[currentModel] && currentModel === requestedModel) {
                currentModel = MODEL_FALLBACK_MAP[currentModel];
                continue;
            }
            continue; // Retry next account
        }

        // 3. Handle Streaming Response
        if (isStream) {
            const sseGenerator = streamSSEResponse(response, currentModel);
            const encoder = new TextEncoder();

            let totalInputTokens = 0;
            let totalOutputTokens = 0;

            const stream = new ReadableStream({
                async pull(controller) {
                    try {
                        const { value, done } = await sseGenerator.next();
                        if (done) {
                            controller.close();
                            // Async log usage to D1
                            if (c.executionCtx) {
                                c.executionCtx.waitUntil(recordUsage(db, {
                                    keyId: keyRecord ? keyRecord.id : null,
                                    model: currentModel,
                                    inputTokens: totalInputTokens,
                                    outputTokens: totalOutputTokens
                                }));
                            }
                            return;
                        }

                        if (value) {
                            if (value.usage) {
                                totalInputTokens = value.usage.input_tokens || totalInputTokens;
                                totalOutputTokens = value.usage.output_tokens || totalOutputTokens;
                            }
                            const chunk = `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
                            controller.enqueue(encoder.encode(chunk));
                        }
                    } catch (streamErr) {
                        controller.error(streamErr);
                    }
                }
            });

            return new Response(stream, {
                headers: {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                }
            });
        }

        // 4. Handle Non-Streaming Response
        if (isThinkingModel(currentModel)) {
            // Aggregate SSE chunks into a complete Anthropic message
            const sseGenerator = streamSSEResponse(response, currentModel);
            const contentBlocks = [];
            let currentBlock = null;
            let stopReason = 'end_turn';
            let usage = { input_tokens: 0, output_tokens: 0 };

            for await (const event of sseGenerator) {
                if (event.type === 'content_block_start') {
                    currentBlock = { ...event.content_block };
                    contentBlocks.push(currentBlock);
                } else if (event.type === 'content_block_delta') {
                    if (currentBlock) {
                        if (event.delta.type === 'text_delta') {
                            currentBlock.text = (currentBlock.text || '') + event.delta.text;
                        } else if (event.delta.type === 'thinking_delta') {
                            currentBlock.thinking = (currentBlock.thinking || '') + event.delta.thinking;
                        } else if (event.delta.type === 'signature_delta') {
                            currentBlock.signature = event.delta.signature;
                        } else if (event.delta.type === 'input_json_delta') {
                            currentBlock.input_str = (currentBlock.input_str || '') + event.delta.partial_json;
                        }
                    }
                } else if (event.type === 'content_block_stop') {
                    if (currentBlock && currentBlock.input_str) {
                        try {
                            currentBlock.input = JSON.parse(currentBlock.input_str);
                        } catch {
                            currentBlock.input = {};
                        }
                        delete currentBlock.input_str;
                    }
                    currentBlock = null;
                } else if (event.type === 'message_delta') {
                    if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
                    if (event.usage) usage = event.usage;
                }
            }

            const anthropicResponse = {
                id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
                type: 'message',
                role: 'assistant',
                model: requestedModel,
                content: contentBlocks,
                stop_reason: stopReason,
                stop_sequence: null,
                usage
            };

            if (c.executionCtx) {
                c.executionCtx.waitUntil(recordUsage(db, {
                    keyId: keyRecord ? keyRecord.id : null,
                    model: requestedModel,
                    inputTokens: usage.input_tokens || 0,
                    outputTokens: usage.output_tokens || 0
                }));
            }

            return c.json(anthropicResponse);
        } else {
            const data = await response.json();
            const anthropicResponse = convertGoogleToAnthropic(data, requestedModel);
            anthropicResponse.model = requestedModel;

            if (c.executionCtx) {
                c.executionCtx.waitUntil(recordUsage(db, {
                    keyId: keyRecord ? keyRecord.id : null,
                    model: requestedModel,
                    inputTokens: anthropicResponse.usage?.input_tokens || 0,
                    outputTokens: anthropicResponse.usage?.output_tokens || 0
                }));
            }

            return c.json(anthropicResponse);
        }
    }

    if (lastError) {
        let errType = 'api_error';
        if (lastError.status === 429) errType = 'rate_limit_error';
        else if (lastError.status === 400) errType = 'invalid_request_error';
        else if (lastError.status === 401 || lastError.status === 403) errType = 'authentication_error';

        let cleanMsg = lastError.text;
        try {
            const parsed = JSON.parse(lastError.text);
            if (parsed.error && parsed.error.message) cleanMsg = parsed.error.message;
        } catch {}

        return c.json({
            error: {
                type: errType,
                message: cleanMsg || `Upstream error ${lastError.status} from provider`
            }
        }, lastError.status || 500);
    }

    return c.json({
        error: {
            type: 'api_error',
            message: 'Failed to complete request after attempting all accounts'
        }
    }, 500);
}
