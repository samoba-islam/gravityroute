/**
 * /v1/chat/completions Route Handler for Cloudflare Worker (OpenAI API compatible)
 */

import { openAiToAnthropic, anthropicToOpenAi, OpenAiStreamTransformer } from '../openai/converter.js';
import { ANTIGRAVITY_ENDPOINT_FALLBACKS, isThinkingModel } from '../constants.js';
import { buildCloudCodeRequest, buildHeaders } from '../cloudcode/request-builder.js';
import { streamSSEResponse } from '../cloudcode/sse-streamer.js';
import { getCachedAccessToken } from '../cloudcode/oauth.js';
import { convertGoogleToAnthropic } from '../format/index.js';
import {
    getAvailableAccounts,
    setAccountCooldown,
    updateAccountLastUsed,
    recordUsage,
    validateApiKey
} from '../db/queries.js';

function mapOpenAiModel(model) {
    const lower = (model || '').toLowerCase();
    if (lower.includes('claude')) return model;
    if (lower.includes('gemini')) return model;
    if (lower.includes('gpt-4') || lower.includes('o1') || lower.includes('o3')) {
        return 'claude-sonnet-4-6';
    }
    return 'gemini-2.5-flash';
}

export async function handleOpenAiChat(c) {
    const db = c.env.DB;
    const body = await c.req.json();

    const authHeader = c.req.header('authorization') || '';
    const clientKey = authHeader.replace(/^Bearer\s+/i, '');

    let keyRecord = null;
    if (clientKey) {
        keyRecord = await validateApiKey(db, clientKey);
        if (!keyRecord && c.env.PROXY_API_KEY && clientKey === c.env.PROXY_API_KEY) {
            keyRecord = { id: 'env_master', name: 'Master Key' };
        } else if (!keyRecord && c.env.PROXY_API_KEY) {
            return c.json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }, 401);
        }
    } else if (c.env.PROXY_API_KEY) {
        return c.json({ error: { message: 'Missing API key', type: 'invalid_request_error' } }, 401);
    }

    const requestedModel = body.model || 'gpt-4o';
    const resolvedModel = mapOpenAiModel(requestedModel);
    const isStream = Boolean(body.stream);

    const anthropicRequest = openAiToAnthropic(body, resolvedModel);

    let accounts = await getAvailableAccounts(db);
    if (accounts.length === 0) {
        return c.json({
            error: {
                message: 'All accounts currently rate-limited or busy',
                type: 'rate_limit_error'
            }
        }, 429);
    }

    const account = accounts[0];
    await updateAccountLastUsed(db, account.id);

    let accessToken;
    try {
        accessToken = await getCachedAccessToken(account);
    } catch (err) {
        if (accounts.length > 1) {
            await setAccountCooldown(db, account.id, 300);
        }
        return c.json({ error: { message: 'Authentication error with provider', type: 'api_error' } }, 502);
    }

    const payload = buildCloudCodeRequest(anthropicRequest, account.project_id, account.email);

    let response = null;
    let lastError = null;

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        const isThinking = isThinkingModel(resolvedModel);
        const url = isStream || isThinking
            ? `${endpoint}/v1internal:streamGenerateContent?alt=sse`
            : `${endpoint}/v1internal:generateContent`;

        const acceptHeader = (isStream || isThinking) ? 'text/event-stream' : 'application/json';
        const headers = buildHeaders(accessToken, resolvedModel, acceptHeader, payload.request.sessionId);

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
                break;
            }

            if (!response.ok) {
                const errText = await response.text();
                lastError = { status: response.status, text: errText };
                continue;
            }

            break;
        } catch (netErr) {
            lastError = { status: 503, text: netErr.message };
            continue;
        }
    }

    if (!response || !response.ok) {
        let cleanMsg = lastError ? lastError.text : 'Upstream error from provider';
        let statusCode = lastError ? lastError.status : 502;
        try {
            const parsed = JSON.parse(cleanMsg);
            if (parsed.error && parsed.error.message) cleanMsg = parsed.error.message;
        } catch {}

        return c.json({
            error: {
                message: cleanMsg,
                type: statusCode === 429 ? 'rate_limit_error' : 'invalid_request_error'
            }
        }, statusCode || 502);
    }

    if (isStream) {
        const sseGenerator = streamSSEResponse(response, resolvedModel);
        const transformer = new OpenAiStreamTransformer(requestedModel, body.stream_options);
        const encoder = new TextEncoder();

        const stream = new ReadableStream({
            async pull(controller) {
                try {
                    const { value, done } = await sseGenerator.next();
                    if (done) {
                        const finalChunks = transformer.transformEvent({ type: 'message_stop' });
                        for (const chunk of finalChunks) {
                            controller.enqueue(encoder.encode(chunk));
                        }
                        controller.close();
                        if (c.executionCtx) {
                            c.executionCtx.waitUntil(recordUsage(db, {
                                keyId: keyRecord ? keyRecord.id : null,
                                model: resolvedModel,
                                inputTokens: transformer.inputTokens,
                                outputTokens: transformer.outputTokens
                            }));
                        }
                        return;
                    }

                    if (value) {
                        const chunks = transformer.transformEvent(value);
                        for (const chunk of chunks) {
                            controller.enqueue(encoder.encode(chunk));
                        }
                    }
                } catch (err) {
                    controller.error(err);
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

    // Non-streaming OpenAI response
    if (isThinkingModel(resolvedModel)) {
        const sseGenerator = streamSSEResponse(response, resolvedModel);
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

        const anthropicRes = {
            id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
            type: 'message',
            role: 'assistant',
            model: resolvedModel,
            content: contentBlocks,
            stop_reason: stopReason,
            usage
        };

        const openAiRes = anthropicToOpenAi(anthropicRes, requestedModel);
        if (c.executionCtx) {
            c.executionCtx.waitUntil(recordUsage(db, {
                keyId: keyRecord ? keyRecord.id : null,
                model: resolvedModel,
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens
            }));
        }
        return c.json(openAiRes);
    } else {
        const data = await response.json();
        const anthropicRes = convertGoogleToAnthropic(data, resolvedModel);
        const openAiRes = anthropicToOpenAi(anthropicRes, requestedModel);
        if (c.executionCtx) {
            c.executionCtx.waitUntil(recordUsage(db, {
                keyId: keyRecord ? keyRecord.id : null,
                model: resolvedModel,
                inputTokens: anthropicRes.usage?.input_tokens || 0,
                outputTokens: anthropicRes.usage?.output_tokens || 0
            }));
        }
        return c.json(openAiRes);
    }
}
