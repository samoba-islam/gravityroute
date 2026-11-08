/**
 * SSE Streamer for Cloud Code in Cloudflare Worker
 * Converts Google Cloud Code SSE chunks to Anthropic SSE events.
 */

import { MIN_SIGNATURE_LENGTH, getModelFamily } from '../constants.js';
import { cacheSignature, cacheThinkingSignature } from '../format/signature-cache.js';

function randomHex(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

export async function* streamSSEResponse(response, originalModel) {
    const messageId = `msg_${randomHex(32)}`;
    let hasEmittedStart = false;
    let blockIndex = 0;
    let currentBlockType = null;
    let currentThinkingSignature = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let stopReason = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;

            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;

            try {
                const data = JSON.parse(jsonText);
                const innerResponse = data.response || data;

                const usage = innerResponse.usageMetadata;
                if (usage) {
                    inputTokens = usage.promptTokenCount || inputTokens;
                    outputTokens = usage.candidatesTokenCount || outputTokens;
                    cacheReadTokens = usage.cachedContentTokenCount || cacheReadTokens;
                }

                const candidates = innerResponse.candidates || [];
                const firstCandidate = candidates[0] || {};
                const content = firstCandidate.content || {};
                const parts = content.parts || [];

                if (!hasEmittedStart && parts.length > 0) {
                    hasEmittedStart = true;
                    yield {
                        type: 'message_start',
                        message: {
                            id: messageId,
                            type: 'message',
                            role: 'assistant',
                            content: [],
                            model: originalModel,
                            stop_reason: null,
                            stop_sequence: null,
                            usage: {
                                input_tokens: Math.max(0, inputTokens - cacheReadTokens),
                                output_tokens: 0,
                                cache_read_input_tokens: cacheReadTokens,
                                cache_creation_input_tokens: 0
                            }
                        }
                    };
                }

                for (const part of parts) {
                    if (part.thought === true) {
                        const text = part.text || '';
                        const signature = part.thoughtSignature || '';

                        if (currentBlockType !== 'thinking') {
                            if (currentBlockType !== null) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            }
                            currentBlockType = 'thinking';
                            currentThinkingSignature = '';
                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: { type: 'thinking', thinking: '' }
                            };
                        }

                        if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                            currentThinkingSignature = signature;
                            const modelFamily = getModelFamily(originalModel);
                            cacheThinkingSignature(signature, modelFamily);
                        }

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'thinking_delta', thinking: text }
                        };

                    } else if (part.text !== undefined) {
                        if (part.text === '') {
                            continue;
                        }

                        if (currentBlockType !== 'text') {
                            if (currentBlockType === 'thinking' && currentThinkingSignature) {
                                yield {
                                    type: 'content_block_delta',
                                    index: blockIndex,
                                    delta: { type: 'signature_delta', signature: currentThinkingSignature }
                                };
                                currentThinkingSignature = '';
                            }
                            if (currentBlockType !== null) {
                                yield { type: 'content_block_stop', index: blockIndex };
                                blockIndex++;
                            }
                            currentBlockType = 'text';
                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: { type: 'text', text: '' }
                            };
                        }

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: { type: 'text_delta', text: part.text }
                        };

                    } else if (part.functionCall) {
                        const functionCallSignature = part.thoughtSignature || '';

                        if (currentBlockType === 'thinking' && currentThinkingSignature) {
                            yield {
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'signature_delta', signature: currentThinkingSignature }
                            };
                            currentThinkingSignature = '';
                        }
                        if (currentBlockType !== null) {
                            yield { type: 'content_block_stop', index: blockIndex };
                            blockIndex++;
                        }
                        currentBlockType = 'tool_use';
                        stopReason = 'tool_use';

                        const toolId = part.functionCall.id || `toolu_${randomHex(24)}`;
                        const toolUseBlock = {
                            type: 'tool_use',
                            id: toolId,
                            name: part.functionCall.name,
                            input: {}
                        };

                        if (functionCallSignature && functionCallSignature.length >= MIN_SIGNATURE_LENGTH) {
                            toolUseBlock.thoughtSignature = functionCallSignature;
                            cacheSignature(toolId, functionCallSignature);
                        }

                        yield {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: toolUseBlock
                        };

                        yield {
                            type: 'content_block_delta',
                            index: blockIndex,
                            delta: {
                                type: 'input_json_delta',
                                partial_json: JSON.stringify(part.functionCall.args || {})
                            }
                        };
                    } else if (part.inlineData) {
                        if (currentBlockType === 'thinking' && currentThinkingSignature) {
                            yield {
                                type: 'content_block_delta',
                                index: blockIndex,
                                delta: { type: 'signature_delta', signature: currentThinkingSignature }
                            };
                            currentThinkingSignature = '';
                        }
                        if (currentBlockType !== null) {
                            yield { type: 'content_block_stop', index: blockIndex };
                            blockIndex++;
                        }
                        currentBlockType = 'image';

                        yield {
                            type: 'content_block_start',
                            index: blockIndex,
                            content_block: {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: part.inlineData.mimeType,
                                    data: part.inlineData.data
                                }
                            }
                        };

                        yield { type: 'content_block_stop', index: blockIndex };
                        blockIndex++;
                        currentBlockType = null;
                    }
                }

                if (firstCandidate.finishReason && !stopReason) {
                    if (firstCandidate.finishReason === 'MAX_TOKENS') {
                        stopReason = 'max_tokens';
                    } else if (firstCandidate.finishReason === 'STOP') {
                        stopReason = 'end_turn';
                    }
                }

            } catch (err) {
                // Ignore parse errors on partial chunks
            }
        }
    }

    if (!hasEmittedStart) {
        throw new Error('No content parts received from upstream Google Cloud Code API');
    }

    if (currentBlockType !== null) {
        if (currentBlockType === 'thinking' && currentThinkingSignature) {
            yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'signature_delta', signature: currentThinkingSignature }
            };
        }
        yield { type: 'content_block_stop', index: blockIndex };
    }

    yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
        usage: {
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: 0
        }
    };

    yield { type: 'message_stop' };
}
