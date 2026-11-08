/**
 * Content Converter for Cloudflare Worker
 * Converts Anthropic message content to Google Generative AI parts format
 */

import { MIN_SIGNATURE_LENGTH, GEMINI_SKIP_SIGNATURE } from '../constants.js';
import { getCachedSignature, getCachedSignatureFamily } from './signature-cache.js';

export function convertRole(role) {
    if (role === 'assistant') return 'model';
    if (role === 'user') return 'user';
    return 'user';
}

export function convertContentToParts(content, isClaudeModel = false, isGeminiModel = false) {
    if (typeof content === 'string') {
        return [{ text: content }];
    }

    if (!Array.isArray(content)) {
        return [{ text: String(content) }];
    }

    const parts = [];
    const deferredInlineData = [];

    for (const block of content) {
        if (!block) continue;

        if (block.type === 'text') {
            if (block.text && block.text.trim()) {
                parts.push({ text: block.text });
            }
        } else if (block.type === 'image') {
            if (block.source?.type === 'base64') {
                parts.push({
                    inlineData: {
                        mimeType: block.source.media_type,
                        data: block.source.data
                    }
                });
            } else if (block.source?.type === 'url') {
                parts.push({
                    fileData: {
                        mimeType: block.source.media_type || 'image/jpeg',
                        fileUri: block.source.url
                    }
                });
            }
        } else if (block.type === 'document') {
            if (block.source?.type === 'base64') {
                parts.push({
                    inlineData: {
                        mimeType: block.source.media_type,
                        data: block.source.data
                    }
                });
            } else if (block.source?.type === 'url') {
                parts.push({
                    fileData: {
                        mimeType: block.source.media_type || 'application/pdf',
                        fileUri: block.source.url
                    }
                });
            }
        } else if (block.type === 'tool_use') {
            const functionCall = {
                name: block.name,
                args: block.input || {}
            };

            if (isClaudeModel && block.id) {
                functionCall.id = block.id;
            }

            const part = { functionCall };

            if (isGeminiModel) {
                let signature = block.thoughtSignature;
                if (!signature && block.id) {
                    signature = getCachedSignature(block.id);
                }
                part.thoughtSignature = signature || GEMINI_SKIP_SIGNATURE;
            }

            parts.push(part);
        } else if (block.type === 'tool_result') {
            let responseContent = block.content;
            let imageParts = [];

            if (typeof responseContent === 'string') {
                responseContent = { result: responseContent };
            } else if (Array.isArray(responseContent)) {
                for (const item of responseContent) {
                    if (item.type === 'image' && item.source?.type === 'base64') {
                        imageParts.push({
                            inlineData: {
                                mimeType: item.source.media_type,
                                data: item.source.data
                            }
                        });
                    }
                }

                const texts = responseContent
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n');
                responseContent = { result: texts || (imageParts.length > 0 ? 'Image attached' : '') };
            }

            const functionResponse = {
                name: block.tool_use_id || 'unknown',
                response: responseContent
            };

            if (isClaudeModel && block.tool_use_id) {
                functionResponse.id = block.tool_use_id;
            }

            parts.push({ functionResponse });
            deferredInlineData.push(...imageParts);
        } else if (block.type === 'thinking') {
            if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) {
                const signatureFamily = getCachedSignatureFamily(block.signature);
                const targetFamily = isClaudeModel ? 'claude' : isGeminiModel ? 'gemini' : null;

                if (isClaudeModel && (!signatureFamily || signatureFamily !== 'claude')) {
                    continue;
                }

                if (isGeminiModel && signatureFamily && targetFamily && signatureFamily !== targetFamily) {
                    continue;
                }

                if (isGeminiModel && !signatureFamily && targetFamily) {
                    continue;
                }

                parts.push({
                    text: block.thinking,
                    thought: true,
                    thoughtSignature: block.signature
                });
            }
        }
    }

    parts.push(...deferredInlineData);
    return parts;
}
