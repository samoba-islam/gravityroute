/**
 * OpenAI <-> Anthropic Bidirectional Converter for Cloudflare Worker
 */

function randomHex(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

function convertUserContent(content) {
    if (typeof content === 'string') {
        return [{ type: 'text', text: content }];
    }

    if (!Array.isArray(content)) {
        return [{ type: 'text', text: String(content || '') }];
    }

    const blocks = [];
    for (const item of content) {
        if (!item) continue;

        if (item.type === 'text') {
            blocks.push({ type: 'text', text: item.text || '' });
        } else if (item.type === 'image_url') {
            const url = item.image_url?.url || '';
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
                blocks.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: match[1],
                        data: match[2]
                    }
                });
            } else {
                blocks.push({
                    type: 'text',
                    text: `[Image: ${url}]`
                });
            }
        }
    }

    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

export function openAiToAnthropic(openAiBody, resolvedModel) {
    const {
        messages = [],
        temperature,
        top_p,
        max_tokens,
        max_completion_tokens,
        tools,
        tool_choice,
        stream = false
    } = openAiBody;

    const systemParts = [];
    const nonSystemMessages = [];

    for (const msg of messages) {
        if (!msg) continue;
        if (msg.role === 'system' || msg.role === 'developer') {
            if (typeof msg.content === 'string') {
                systemParts.push(msg.content);
            } else if (Array.isArray(msg.content)) {
                const text = msg.content
                    .filter(c => c && (c.type === 'text' || typeof c === 'string'))
                    .map(c => typeof c === 'string' ? c : c.text)
                    .join('\n');
                if (text) systemParts.push(text);
            }
        } else {
            nonSystemMessages.push(msg);
        }
    }

    const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
    const anthropicMessages = [];

    for (let i = 0; i < nonSystemMessages.length; i++) {
        const msg = nonSystemMessages[i];
        const role = msg.role;

        if (role === 'user') {
            const content = convertUserContent(msg.content);
            anthropicMessages.push({ role: 'user', content });
        } else if (role === 'assistant') {
            const content = [];

            if (typeof msg.content === 'string' && msg.content.length > 0) {
                content.push({ type: 'text', text: msg.content });
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text' && part.text) {
                        content.push({ type: 'text', text: part.text });
                    }
                }
            }

            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                for (const call of msg.tool_calls) {
                    let parsedInput = {};
                    if (call.function?.arguments) {
                        try {
                            parsedInput = typeof call.function.arguments === 'string'
                                ? JSON.parse(call.function.arguments)
                                : call.function.arguments;
                        } catch {
                            parsedInput = {};
                        }
                    }
                    content.push({
                        type: 'tool_use',
                        id: call.id || `call_${randomHex(16)}`,
                        name: call.function?.name || 'unknown_tool',
                        input: parsedInput
                    });
                }
            }

            if (content.length === 0) {
                content.push({ type: 'text', text: '' });
            }

            anthropicMessages.push({ role: 'assistant', content });
        } else if (role === 'tool') {
            const toolResultBlock = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id || '',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')
            };

            const lastMsg = anthropicMessages[anthropicMessages.length - 1];
            if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content) && lastMsg.content.some(c => c.type === 'tool_result')) {
                lastMsg.content.push(toolResultBlock);
            } else {
                anthropicMessages.push({
                    role: 'user',
                    content: [toolResultBlock]
                });
            }
        }
    }

    if (anthropicMessages.length === 0) {
        anthropicMessages.push({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
    }

    let anthropicTools = undefined;
    if (Array.isArray(tools) && tools.length > 0) {
        anthropicTools = tools
            .filter(t => t && t.type === 'function' && t.function)
            .map(t => ({
                name: t.function.name,
                description: t.function.description || '',
                input_schema: t.function.parameters || { type: 'object', properties: {} }
            }));
    }

    let anthropicToolChoice = undefined;
    if (tool_choice) {
        if (tool_choice === 'auto') {
            anthropicToolChoice = { type: 'auto' };
        } else if (tool_choice === 'none') {
            anthropicTools = undefined;
        } else if (tool_choice === 'required') {
            anthropicToolChoice = { type: 'any' };
        } else if (typeof tool_choice === 'object' && tool_choice.type === 'function' && tool_choice.function?.name) {
            anthropicToolChoice = { type: 'tool', name: tool_choice.function.name };
        }
    }

    const effectiveMaxTokens = max_completion_tokens || max_tokens || 4096;

    return {
        model: resolvedModel,
        messages: anthropicMessages,
        system,
        max_tokens: effectiveMaxTokens,
        stream: Boolean(stream),
        tools: anthropicTools,
        tool_choice: anthropicToolChoice,
        temperature: typeof temperature === 'number' ? temperature : undefined,
        top_p: typeof top_p === 'number' ? top_p : undefined
    };
}

export function anthropicToOpenAi(anthropicResponse, requestedModel) {
    const textParts = [];
    const reasoningParts = [];
    const toolCalls = [];

    const content = anthropicResponse.content || [];

    for (const block of content) {
        if (block.type === 'text') {
            textParts.push(block.text || '');
        } else if (block.type === 'thinking') {
            reasoningParts.push(block.thinking || '');
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                }
            });
        }
    }

    const textContent = textParts.join('');
    const reasoningContent = reasoningParts.join('') || undefined;

    let finishReason = 'stop';
    if (anthropicResponse.stop_reason === 'tool_use' || toolCalls.length > 0) {
        finishReason = 'tool_calls';
    } else if (anthropicResponse.stop_reason === 'max_tokens') {
        finishReason = 'length';
    } else if (anthropicResponse.stop_reason === 'end_turn' || anthropicResponse.stop_reason === 'stop_sequence') {
        finishReason = 'stop';
    }

    const inputTokens = anthropicResponse.usage?.input_tokens || 0;
    const outputTokens = anthropicResponse.usage?.output_tokens || 0;
    const cachedTokens = (anthropicResponse.usage?.cache_read_input_tokens || 0) + (anthropicResponse.usage?.cache_creation_input_tokens || 0);
    const promptTokens = inputTokens + cachedTokens;
    const totalTokens = promptTokens + outputTokens;

    const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: outputTokens,
        total_tokens: totalTokens,
        prompt_tokens_details: {
            cached_tokens: cachedTokens
        },
        completion_tokens_details: {
            reasoning_tokens: 0
        }
    };

    const message = {
        role: 'assistant',
        content: textContent || (toolCalls.length > 0 ? null : '')
    };

    if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
    }

    if (reasoningContent) {
        message.reasoning_content = reasoningContent;
    }

    return {
        id: `chatcmpl-${randomHex(24)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
            {
                index: 0,
                message,
                logprobs: null,
                finish_reason: finishReason
            }
        ],
        usage
    };
}

export class OpenAiStreamTransformer {
    constructor(requestedModel, streamOptions = {}) {
        this.chatcmplId = `chatcmpl-${randomHex(24)}`;
        this.created = Math.floor(Date.now() / 1000);
        this.model = requestedModel;
        this.includeUsage = Boolean(streamOptions?.include_usage);

        this.roleSent = false;
        this.toolCallIndex = -1;
        this.finishReasonSent = false;

        this.inputTokens = 0;
        this.outputTokens = 0;
        this.cacheTokens = 0;
    }

    transformEvent(event) {
        const chunks = [];
        if (!event) return chunks;

        if (!this.roleSent) {
            chunks.push(this.formatChunk({
                role: 'assistant',
                content: ''
            }, null));
            this.roleSent = true;
        }

        const usage = event.message?.usage || event.usage;
        if (usage) {
            if (usage.input_tokens) this.inputTokens = Math.max(this.inputTokens, usage.input_tokens);
            if (usage.output_tokens) this.outputTokens = Math.max(this.outputTokens, usage.output_tokens);
            const cache = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
            if (cache) this.cacheTokens = Math.max(this.cacheTokens, cache);
        }

        switch (event.type) {
            case 'content_block_start': {
                const block = event.content_block;
                if (block?.type === 'tool_use') {
                    this.toolCallIndex++;
                    chunks.push(this.formatChunk({
                        tool_calls: [
                            {
                                index: this.toolCallIndex,
                                id: block.id,
                                type: 'function',
                                function: {
                                    name: block.name,
                                    arguments: ''
                                }
                            }
                        ]
                    }, null));
                }
                break;
            }

            case 'content_block_delta': {
                const delta = event.delta;
                if (!delta) break;

                if (delta.type === 'text_delta') {
                    chunks.push(this.formatChunk({
                        content: delta.text
                    }, null));
                } else if (delta.type === 'thinking_delta') {
                    chunks.push(this.formatChunk({
                        reasoning_content: delta.thinking
                    }, null));
                } else if (delta.type === 'input_json_delta') {
                    chunks.push(this.formatChunk({
                        tool_calls: [
                            {
                                index: this.toolCallIndex,
                                function: {
                                    arguments: delta.partial_json
                                }
                            }
                        ]
                    }, null));
                }
                break;
            }

            case 'message_delta': {
                const stopReason = event.delta?.stop_reason;
                let openAiFinishReason = 'stop';
                if (stopReason === 'tool_use' || this.toolCallIndex >= 0) {
                    openAiFinishReason = 'tool_calls';
                } else if (stopReason === 'max_tokens') {
                    openAiFinishReason = 'length';
                } else if (stopReason === 'end_turn') {
                    openAiFinishReason = 'stop';
                }

                chunks.push(this.formatChunk({}, openAiFinishReason));
                this.finishReasonSent = true;
                break;
            }

            case 'message_stop': {
                if (!this.finishReasonSent) {
                    const fallbackFinish = this.toolCallIndex >= 0 ? 'tool_calls' : 'stop';
                    chunks.push(this.formatChunk({}, fallbackFinish));
                    this.finishReasonSent = true;
                }

                if (this.includeUsage || (this.inputTokens + this.outputTokens > 0)) {
                    chunks.push(this.formatUsageChunk());
                }

                chunks.push('data: [DONE]\n\n');
                break;
            }
        }

        return chunks;
    }

    formatChunk(delta, finishReason = null) {
        const payload = {
            id: this.chatcmplId,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.model,
            choices: [
                {
                    index: 0,
                    delta,
                    logprobs: null,
                    finish_reason: finishReason
                }
            ]
        };
        return `data: ${JSON.stringify(payload)}\n\n`;
    }

    formatUsageChunk() {
        const promptTokens = this.inputTokens + this.cacheTokens;
        const totalTokens = promptTokens + this.outputTokens;
        const payload = {
            id: this.chatcmplId,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.model,
            choices: [],
            usage: {
                prompt_tokens: promptTokens,
                completion_tokens: this.outputTokens,
                total_tokens: totalTokens,
                prompt_tokens_details: {
                    cached_tokens: this.cacheTokens
                },
                completion_tokens_details: {
                    reasoning_tokens: 0
                }
            }
        };
        return `data: ${JSON.stringify(payload)}\n\n`;
    }
}
