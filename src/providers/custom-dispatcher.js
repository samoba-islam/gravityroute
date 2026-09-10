/**
 * Custom Provider Dispatcher
 * Dispatches requests to OpenAI-compatible and Anthropic-compatible custom providers.
 * Handles format conversion, streaming translation, token usage tracking, and quota deduction.
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { openAiToAnthropic, anthropicToOpenAi, OpenAiStreamTransformer } from '../openai/converter.js';

/**
 * Convert Anthropic Messages API request body into OpenAI Chat Completions request body
 *
 * @param {Object} anthropicBody - Incoming Anthropic request
 * @param {string} rawModel - The model to send to upstream provider
 * @returns {Object} OpenAI-compatible request body
 */
export function anthropicRequestToOpenAi(anthropicBody, rawModel) {
    const {
        messages = [],
        system,
        max_tokens,
        temperature,
        top_p,
        stream = false,
        tools = []
    } = anthropicBody;

    const openAiMessages = [];

    // 1. Convert top-level system prompt to OpenAI system message
    if (system) {
        let systemText = '';
        if (typeof system === 'string') {
            systemText = system;
        } else if (Array.isArray(system)) {
            systemText = system
                .map(s => typeof s === 'string' ? s : s.text || '')
                .filter(Boolean)
                .join('\n\n');
        }
        if (systemText) {
            openAiMessages.push({ role: 'system', content: systemText });
        }
    }

    // 2. Convert conversation messages
    for (const msg of messages) {
        if (!msg) continue;
        const role = msg.role;

        if (typeof msg.content === 'string') {
            openAiMessages.push({ role, content: msg.content });
            continue;
        }

        if (Array.isArray(msg.content)) {
            const textParts = [];
            const toolCalls = [];
            const toolResults = [];

            for (const part of msg.content) {
                if (!part) continue;
                if (part.type === 'text' && part.text) {
                    textParts.push(part.text);
                } else if (part.type === 'tool_use') {
                    toolCalls.push({
                        id: part.id || `call_${crypto.randomBytes(8).toString('hex')}`,
                        type: 'function',
                        function: {
                            name: part.name,
                            arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input || {})
                        }
                    });
                } else if (part.type === 'tool_result') {
                    let contentStr = '';
                    if (typeof part.content === 'string') {
                        contentStr = part.content;
                    } else if (Array.isArray(part.content)) {
                        contentStr = part.content.map(c => c.text || JSON.stringify(c)).join('\n');
                    } else {
                        contentStr = JSON.stringify(part.content || '');
                    }
                    toolResults.push({
                        role: 'tool',
                        tool_call_id: part.tool_use_id,
                        content: contentStr
                    });
                }
            }

            if (toolResults.length > 0) {
                for (const tr of toolResults) {
                    openAiMessages.push(tr);
                }
            } else {
                const openAiMsg = {
                    role,
                    content: textParts.join('\n') || (toolCalls.length > 0 ? null : '')
                };
                if (toolCalls.length > 0) {
                    openAiMsg.tool_calls = toolCalls;
                }
                openAiMessages.push(openAiMsg);
            }
        }
    }

    const openAiBody = {
        model: rawModel,
        messages: openAiMessages,
        stream: Boolean(stream)
    };

    if (max_tokens) openAiBody.max_tokens = max_tokens;
    if (typeof temperature === 'number') openAiBody.temperature = temperature;
    if (typeof top_p === 'number') openAiBody.top_p = top_p;

    if (stream) {
        openAiBody.stream_options = { include_usage: true };
    }

    if (Array.isArray(tools) && tools.length > 0) {
        openAiBody.tools = tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description || undefined,
                parameters: t.input_schema || { type: 'object', properties: {} }
            }
        }));
    }

    return openAiBody;
}

/**
 * Fetch available models from an upstream API endpoint
 *
 * @param {Object} params - { type, baseUrl, apiKey }
 * @returns {Promise<Array<string>>}
 */
export async function fetchProviderModels({ type = 'openai', baseUrl, apiKey }) {
    const cleanUrl = (baseUrl || '').replace(/\/+$/, '');
    if (!cleanUrl) {
        throw new Error('Base URL is required to fetch models');
    }

    if (type === 'anthropic') {
        // Try Anthropic /v1/models endpoint
        try {
            const targetUrl = cleanUrl.endsWith('/v1') ? `${cleanUrl}/models` : `${cleanUrl}/v1/models`;
            const headers = {
                'x-api-key': apiKey || '',
                'anthropic-version': '2023-06-01'
            };
            const response = await fetch(targetUrl, { method: 'GET', headers });
            if (response.ok) {
                const data = await response.json();
                if (Array.isArray(data?.data)) {
                    return data.data.map(m => m.id).sort();
                }
            }
        } catch (err) {
            logger.warn(`[CustomDispatcher] Anthropic model fetch error: ${err.message}`);
        }

        // Return curated list of known Anthropic models as fallback
        return [
            'claude-3-7-sonnet-20250219',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-haiku-20241022',
            'claude-3-opus-20240229'
        ];
    }

    // Default: OpenAI compatible endpoint (/models)
    const targetUrl = `${cleanUrl}/models`;
    const headers = {};
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(targetUrl, { method: 'GET', headers });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Upstream returned HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    if (Array.isArray(data?.data)) {
        return data.data.map(m => m.id).filter(Boolean).sort();
    }
    if (Array.isArray(data)) {
        return data.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean).sort();
    }

    return [];
}

/**
 * Check whether a custom provider has sufficient quota
 *
 * @param {Object} provider - Custom provider record
 * @returns {{allowed: boolean, error?: string}}
 */
function checkProviderQuota(provider) {
    if (!provider.enabled) {
        return { allowed: false, error: `Provider '${provider.name}' is currently disabled.` };
    }

    if (provider.quotaType === 'dollar') {
        const balance = provider.currentBalance !== undefined ? provider.currentBalance : provider.initialBalance;
        if (balance !== undefined && balance <= 0) {
            return {
                allowed: false,
                error: `RESOURCE_EXHAUSTED: Provider '${provider.name}' dollar balance is exhausted ($0.00 remaining). Please top up balance in WebUI.`
            };
        }
    } else if (provider.quotaType === 'token') {
        const tokens = provider.currentTokens !== undefined ? provider.currentTokens : provider.initialTokens;
        if (tokens !== undefined && tokens <= 0) {
            return {
                allowed: false,
                error: `RESOURCE_EXHAUSTED: Provider '${provider.name}' token quota is exhausted (0 tokens remaining). Please update quota in WebUI.`
            };
        }
    }

    return { allowed: true };
}

/**
 * Dispatch an Anthropic-format (/v1/messages) request to a custom provider
 *
 * @param {Object} provider - Custom provider object
 * @param {string} rawModel - Stripped model name (e.g. deepseek-chat)
 * @param {Object} reqBody - Request body from client
 * @param {Object} res - Express response object
 * @param {Object} accountManager - AccountManager instance
 */
export async function dispatchMessagesRequest(provider, rawModel, reqBody, res, accountManager) {
    const quotaCheck = checkProviderQuota(provider);
    if (!quotaCheck.allowed) {
        return res.status(429).json({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                message: quotaCheck.error
            }
        });
    }

    const cleanBaseUrl = (provider.baseUrl || '').replace(/\/+$/, '');

    if (provider.type === 'anthropic') {
        // Native Anthropic-compatible upstream
        const targetUrl = cleanBaseUrl.endsWith('/v1')
            ? `${cleanBaseUrl}/messages`
            : `${cleanBaseUrl}/v1/messages`;

        const upstreamBody = {
            ...reqBody,
            model: rawModel
        };

        const headers = {
            'Content-Type': 'application/json',
            'x-api-key': provider.apiKey || '',
            'anthropic-version': '2023-06-01'
        };

        logger.info(`[CustomDispatcher] Routing /v1/messages to Anthropic provider '${provider.name}' (${targetUrl}), model: ${rawModel}`);

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            logger.error(`[CustomDispatcher] Anthropic provider error (${response.status}): ${errText}`);
            return res.status(response.status).send(errText);
        }

        if (reqBody.stream) {
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            let promptTokens = 0;
            let completionTokens = 0;

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const textChunk = decoder.decode(value, { stream: true });
                res.write(textChunk);
                if (res.flush) res.flush();

                buffer += textChunk;
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep remainder

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.slice(6).trim();
                        if (!jsonStr || jsonStr === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(jsonStr);
                            if (parsed.message?.usage?.input_tokens) {
                                promptTokens = parsed.message.usage.input_tokens;
                            }
                            if (parsed.usage?.output_tokens) {
                                completionTokens = parsed.usage.output_tokens;
                            }
                        } catch { /* ignore parse error */ }
                    }
                }
            }

            res.end();

            // Record usage
            accountManager.recordCustomProviderUsage(provider.name, {
                inputTokens: promptTokens || Math.round(JSON.stringify(reqBody).length / 4),
                outputTokens: completionTokens || 200
            });
        } else {
            const data = await response.json();
            const promptTokens = data.usage?.input_tokens || Math.round(JSON.stringify(reqBody).length / 4);
            const completionTokens = data.usage?.output_tokens || 200;

            accountManager.recordCustomProviderUsage(provider.name, {
                inputTokens: promptTokens,
                outputTokens: completionTokens
            });

            // Ensure model field reflects client expectation or provider model
            data.model = `${provider.name}-${rawModel}`;
            return res.json(data);
        }
    } else {
        // OpenAI-compatible upstream (e.g., DeepSeek, Groq, OpenRouter, vLLM, Ollama)
        const targetUrl = cleanBaseUrl.endsWith('/chat/completions')
            ? cleanBaseUrl
            : `${cleanBaseUrl}/chat/completions`;

        const openAiBody = anthropicRequestToOpenAi(reqBody, rawModel);

        const headers = {
            'Content-Type': 'application/json'
        };
        if (provider.apiKey) {
            headers['Authorization'] = `Bearer ${provider.apiKey}`;
        }

        logger.info(`[CustomDispatcher] Routing /v1/messages to OpenAI provider '${provider.name}' (${targetUrl}), model: ${rawModel}, stream: ${!!reqBody.stream}`);

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(openAiBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            logger.error(`[CustomDispatcher] OpenAI provider error (${response.status}): ${errText}`);
            return res.status(response.status).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: `Upstream error: ${errText.slice(0, 300)}`
                }
            });
        }

        if (reqBody.stream) {
            // Translate OpenAI SSE stream -> Anthropic SSE events
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
            const clientModel = `${provider.name}-${rawModel}`;

            // 1. Emit message_start
            const startEvent = {
                type: 'message_start',
                message: {
                    id: msgId,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: clientModel,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 }
                }
            };
            res.write(`event: message_start\ndata: ${JSON.stringify(startEvent)}\n\n`);

            // 2. Emit content_block_start
            const blockStartEvent = {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
            };
            res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStartEvent)}\n\n`);
            if (res.flush) res.flush();

            let promptTokens = 0;
            let completionTokens = 0;
            let outputChars = 0;

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunkText = decoder.decode(value, { stream: true });
                buffer += chunkText;
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;
                    const dataStr = trimmed.slice(6).trim();

                    if (dataStr === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(dataStr);

                        if (parsed.usage) {
                            if (parsed.usage.prompt_tokens) promptTokens = parsed.usage.prompt_tokens;
                            if (parsed.usage.completion_tokens) completionTokens = parsed.usage.completion_tokens;
                        }

                        const delta = parsed.choices?.[0]?.delta;
                        if (delta?.content) {
                            outputChars += delta.content.length;
                            const deltaEvent = {
                                type: 'content_block_delta',
                                index: 0,
                                delta: { type: 'text_delta', text: delta.content }
                            };
                            res.write(`event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`);
                            if (res.flush) res.flush();
                        } else if (delta?.reasoning_content) {
                            // DeepSeek reasoning / thinking delta
                            outputChars += delta.reasoning_content.length;
                            const deltaEvent = {
                                type: 'content_block_delta',
                                index: 0,
                                delta: { type: 'thinking_delta', thinking: delta.reasoning_content }
                            };
                            res.write(`event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`);
                            if (res.flush) res.flush();
                        }
                    } catch { /* ignore parse error on partial chunks */ }
                }
            }

            // Estimate tokens if upstream didn't send stream_options usage
            if (!promptTokens) promptTokens = Math.max(10, Math.round(JSON.stringify(reqBody).length / 4));
            if (!completionTokens) completionTokens = Math.max(1, Math.round(outputChars / 4));

            // 3. Emit content_block_stop
            const blockStopEvent = { type: 'content_block_stop', index: 0 };
            res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStopEvent)}\n\n`);

            // 4. Emit message_delta
            const messageDeltaEvent = {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: completionTokens }
            };
            res.write(`event: message_delta\ndata: ${JSON.stringify(messageDeltaEvent)}\n\n`);

            // 5. Emit message_stop
            res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
            res.end();

            // Record usage
            accountManager.recordCustomProviderUsage(provider.name, {
                inputTokens: promptTokens,
                outputTokens: completionTokens
            });
        } else {
            // Non-streaming response: translate OpenAI JSON -> Anthropic format
            const openAiRes = await response.json();
            const choice = openAiRes.choices?.[0];
            const content = choice?.message?.content || '';

            const promptTokens = openAiRes.usage?.prompt_tokens || Math.max(10, Math.round(JSON.stringify(reqBody).length / 4));
            const completionTokens = openAiRes.usage?.completion_tokens || Math.max(1, Math.round(content.length / 4));

            accountManager.recordCustomProviderUsage(provider.name, {
                inputTokens: promptTokens,
                outputTokens: completionTokens
            });

            const anthropicResponse = {
                id: `msg_${crypto.randomBytes(12).toString('hex')}`,
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text: content }],
                model: `${provider.name}-${rawModel}`,
                stop_reason: choice?.finish_reason === 'stop' ? 'end_turn' : (choice?.finish_reason || 'end_turn'),
                stop_sequence: null,
                usage: {
                    input_tokens: promptTokens,
                    output_tokens: completionTokens
                }
            };

            return res.json(anthropicResponse);
        }
    }
}

/**
 * Dispatch an OpenAI-format (/v1/chat/completions) request to a custom provider
 *
 * @param {Object} provider - Custom provider object
 * @param {string} rawModel - Stripped model name
 * @param {Object} reqBody - Request body from client
 * @param {Object} res - Express response object
 * @param {Object} accountManager - AccountManager instance
 */
export async function dispatchChatCompletionsRequest(provider, rawModel, reqBody, res, accountManager) {
    const quotaCheck = checkProviderQuota(provider);
    if (!quotaCheck.allowed) {
        return res.status(429).json({
            error: {
                message: quotaCheck.error,
                type: 'insufficient_quota',
                code: 'insufficient_quota'
            }
        });
    }

    const cleanBaseUrl = (provider.baseUrl || '').replace(/\/+$/, '');

    if (provider.type === 'openai') {
        // Direct passthrough to OpenAI-compatible endpoint
        const targetUrl = cleanBaseUrl.endsWith('/chat/completions')
            ? cleanBaseUrl
            : `${cleanBaseUrl}/chat/completions`;

        const upstreamBody = {
            ...reqBody,
            model: rawModel
        };

        const headers = { 'Content-Type': 'application/json' };
        if (provider.apiKey) {
            headers['Authorization'] = `Bearer ${provider.apiKey}`;
        }

        logger.info(`[CustomDispatcher] Routing /v1/chat/completions to OpenAI provider '${provider.name}' (${targetUrl}), model: ${rawModel}`);

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(upstreamBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            return res.status(response.status).send(errText);
        }

        if (reqBody.stream) {
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            let promptTokens = 0;
            let completionTokens = 0;
            let totalChars = 0;

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const textChunk = decoder.decode(value, { stream: true });
                res.write(textChunk);
                if (res.flush) res.flush();

                buffer += textChunk;
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.slice(6).trim();
                        if (!jsonStr || jsonStr === '[DONE]') continue;
                        try {
                            const parsed = JSON.parse(jsonStr);
                            if (parsed.usage) {
                                if (parsed.usage.prompt_tokens) promptTokens = parsed.usage.prompt_tokens;
                                if (parsed.usage.completion_tokens) completionTokens = parsed.usage.completion_tokens;
                            }
                            const delta = parsed.choices?.[0]?.delta?.content;
                            if (delta) totalChars += delta.length;
                        } catch { /* ignore */ }
                    }
                }
            }

            res.end();

            if (!promptTokens) promptTokens = Math.max(10, Math.round(JSON.stringify(reqBody).length / 4));
            if (!completionTokens) completionTokens = Math.max(1, Math.round(totalChars / 4));

            accountManager.recordCustomProviderUsage(provider.name, {
                inputTokens: promptTokens,
                outputTokens: completionTokens
            });
        } else {
            const data = await response.json();
            const promptTokens = data.usage?.prompt_tokens || Math.max(10, Math.round(JSON.stringify(reqBody).length / 4));
            const completionTokens = data.usage?.completion_tokens || 200;

            accountManager.recordCustomProviderUsage(provider.name, {
                inputTokens: promptTokens,
                outputTokens: completionTokens
            });

            return res.json(data);
        }
    } else {
        // Anthropic upstream: Convert OpenAI request -> Anthropic request -> send to /v1/messages -> convert back
        const targetUrl = cleanBaseUrl.endsWith('/v1')
            ? `${cleanBaseUrl}/messages`
            : `${cleanBaseUrl}/v1/messages`;

        const anthropicBody = openAiToAnthropic(reqBody, rawModel);

        const headers = {
            'Content-Type': 'application/json',
            'x-api-key': provider.apiKey || '',
            'anthropic-version': '2023-06-01'
        };

        logger.info(`[CustomDispatcher] Routing /v1/chat/completions to Anthropic provider '${provider.name}' (${targetUrl}), model: ${rawModel}`);

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(anthropicBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            return res.status(response.status).json({
                error: {
                    message: `Upstream error: ${errText.slice(0, 300)}`,
                    type: 'api_error'
                }
            });
        }

        if (reqBody.stream) {
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            const transformer = new OpenAiStreamTransformer(`${provider.name}-${rawModel}`, reqBody.stream_options);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            let promptTokens = 0;
            let completionTokens = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.slice(6).trim();
                        if (!dataStr) continue;
                        try {
                            const event = JSON.parse(dataStr);
                            const chunks = transformer.transformEvent(event);
                            for (const chunk of chunks) {
                                res.write(chunk);
                            }
                            if (res.flush) res.flush();

                            if (event.message?.usage?.input_tokens) promptTokens = event.message.usage.input_tokens;
                            if (event.usage?.output_tokens) completionTokens = event.usage.output_tokens;
                        } catch { /* ignore */ }
                    }
                }
            }

            res.end();

            accountManager.recordCustomProviderUsage(provider.name, {
                inputTokens: promptTokens || Math.round(JSON.stringify(reqBody).length / 4),
                outputTokens: completionTokens || 200
            });
        } else {
            const anthropicJson = await response.json();
            const promptTokens = anthropicJson.usage?.input_tokens || Math.round(JSON.stringify(reqBody).length / 4);
            const completionTokens = anthropicJson.usage?.output_tokens || 200;

            accountManager.recordCustomProviderUsage(provider.name, {
                inputTokens: promptTokens,
                outputTokens: completionTokens
            });

            const openAiJson = anthropicToOpenAi(anthropicJson, `${provider.name}-${rawModel}`);
            return res.json(openAiJson);
        }
    }
}

export default {
    fetchProviderModels,
    dispatchMessagesRequest,
    dispatchChatCompletionsRequest,
    anthropicRequestToOpenAi
};
