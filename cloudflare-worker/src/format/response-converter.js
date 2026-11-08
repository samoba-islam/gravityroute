/**
 * Response Converter for Cloudflare Worker
 * Converts Google Generative AI responses to Anthropic Messages API format
 */

import { MIN_SIGNATURE_LENGTH, getModelFamily } from '../constants.js';
import { cacheSignature, cacheThinkingSignature } from './signature-cache.js';

function randomHex(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

export function convertGoogleToAnthropic(googleResponse, model) {
    const response = googleResponse.response || googleResponse;
    const candidates = response.candidates || [];
    const firstCandidate = candidates[0] || {};
    const content = firstCandidate.content || {};
    const parts = content.parts || [];

    const anthropicContent = [];
    let hasToolCalls = false;

    for (const part of parts) {
        if (part.text !== undefined) {
            if (part.thought === true) {
                const signature = part.thoughtSignature || '';
                if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                    const modelFamily = getModelFamily(model);
                    cacheThinkingSignature(signature, modelFamily);
                }

                anthropicContent.push({
                    type: 'thinking',
                    thinking: part.text,
                    signature: signature
                });
            } else {
                anthropicContent.push({
                    type: 'text',
                    text: part.text
                });
            }
        } else if (part.functionCall) {
            const toolId = part.functionCall.id || `toolu_${randomHex(24)}`;
            const toolUseBlock = {
                type: 'tool_use',
                id: toolId,
                name: part.functionCall.name,
                input: part.functionCall.args || {}
            };

            if (part.thoughtSignature && part.thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
                toolUseBlock.thoughtSignature = part.thoughtSignature;
                cacheSignature(toolId, part.thoughtSignature);
            }

            anthropicContent.push(toolUseBlock);
            hasToolCalls = true;
        } else if (part.inlineData) {
            anthropicContent.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: part.inlineData.mimeType,
                    data: part.inlineData.data
                }
            });
        }
    }

    const finishReason = firstCandidate.finishReason;
    let stopReason = 'end_turn';
    if (finishReason === 'STOP') {
        stopReason = 'end_turn';
    } else if (finishReason === 'MAX_TOKENS') {
        stopReason = 'max_tokens';
    } else if (finishReason === 'TOOL_USE' || hasToolCalls) {
        stopReason = 'tool_use';
    }

    const usageMetadata = response.usageMetadata || {};
    const promptTokens = usageMetadata.promptTokenCount || 0;
    const cachedTokens = usageMetadata.cachedContentTokenCount || 0;

    return {
        id: `msg_${randomHex(32)}`,
        type: 'message',
        role: 'assistant',
        content: anthropicContent.length > 0 ? anthropicContent : [{ type: 'text', text: '' }],
        model: model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: Math.max(0, promptTokens - cachedTokens),
            output_tokens: usageMetadata.candidatesTokenCount || 0,
            cache_read_input_tokens: cachedTokens,
            cache_creation_input_tokens: 0
        }
    };
}
