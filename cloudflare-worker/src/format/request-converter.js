/**
 * Request Converter for Cloudflare Worker
 * Converts Anthropic Messages API requests to Google Generative AI format
 */

import {
    GEMINI_MAX_OUTPUT_TOKENS,
    getModelFamily,
    isThinkingModel
} from '../constants.js';
import { convertContentToParts, convertRole } from './content-converter.js';
import { sanitizeSchema, cleanSchema } from './schema-sanitizer.js';
import {
    restoreThinkingSignatures,
    removeTrailingThinkingBlocks,
    reorderAssistantContent,
    filterUnsignedThinkingBlocks,
    hasGeminiHistory,
    hasUnsignedThinkingBlocks,
    needsThinkingRecovery,
    closeToolLoopForThinking,
    cleanCacheControl,
    clampGeminiThinkingBudget
} from './thinking-utils.js';

export function convertAnthropicToGoogle(anthropicRequest) {
    const messages = cleanCacheControl(anthropicRequest.messages || []);
    const { system, max_tokens, temperature, top_p, top_k, stop_sequences, tools, thinking } = anthropicRequest;
    const modelName = anthropicRequest.model || '';
    const modelFamily = getModelFamily(modelName);
    const isClaudeModel = modelFamily === 'claude';
    const isGeminiModel = modelFamily === 'gemini';
    const isThinking = isThinkingModel(modelName);

    const googleRequest = {
        contents: [],
        generationConfig: {}
    };

    if (system) {
        let systemParts = [];
        if (typeof system === 'string') {
            systemParts = [{ text: system }];
        } else if (Array.isArray(system)) {
            systemParts = system
                .filter(block => block.type === 'text')
                .map(block => ({ text: block.text }));
        }

        if (systemParts.length > 0) {
            googleRequest.systemInstruction = {
                parts: systemParts
            };
        }
    }

    if (isClaudeModel && isThinking && tools && tools.length > 0) {
        const hint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.';
        if (!googleRequest.systemInstruction) {
            googleRequest.systemInstruction = { parts: [{ text: hint }] };
        } else {
            const lastPart = googleRequest.systemInstruction.parts[googleRequest.systemInstruction.parts.length - 1];
            if (lastPart && lastPart.text) {
                lastPart.text = `${lastPart.text}\n\n${hint}`;
            } else {
                googleRequest.systemInstruction.parts.push({ text: hint });
            }
        }
    }

    let processedMessages = messages;

    if (isGeminiModel && isThinking && needsThinkingRecovery(messages)) {
        processedMessages = closeToolLoopForThinking(messages, 'gemini');
    }

    const needsClaudeRecovery = hasGeminiHistory(messages) || hasUnsignedThinkingBlocks(messages);
    if (isClaudeModel && isThinking && needsClaudeRecovery && needsThinkingRecovery(messages)) {
        processedMessages = closeToolLoopForThinking(messages, 'claude');
    }

    for (const msg of processedMessages) {
        let msgContent = msg.content;

        if ((msg.role === 'assistant' || msg.role === 'model') && Array.isArray(msgContent)) {
            msgContent = restoreThinkingSignatures(msgContent);
            msgContent = removeTrailingThinkingBlocks(msgContent);
            msgContent = reorderAssistantContent(msgContent);
        }

        const parts = convertContentToParts(msgContent, isClaudeModel, isGeminiModel);

        if (parts.length === 0) {
            parts.push({ text: '.' });
        }

        googleRequest.contents.push({
            role: convertRole(msg.role),
            parts: parts
        });
    }

    if (isClaudeModel) {
        googleRequest.contents = filterUnsignedThinkingBlocks(googleRequest.contents);
    }

    if (max_tokens) {
        googleRequest.generationConfig.maxOutputTokens = max_tokens;
    }
    if (temperature !== undefined) {
        googleRequest.generationConfig.temperature = temperature;
    }
    if (top_p !== undefined) {
        googleRequest.generationConfig.topP = top_p;
    }
    if (top_k !== undefined) {
        googleRequest.generationConfig.topK = top_k;
    }
    if (stop_sequences && stop_sequences.length > 0) {
        googleRequest.generationConfig.stopSequences = stop_sequences;
    }

    if (isThinking) {
        if (isClaudeModel) {
            const thinkingBudget = thinking?.budget_tokens || 32000;
            const thinkingConfig = {
                include_thoughts: true,
                thinking_budget: thinkingBudget
            };

            const currentMaxTokens = googleRequest.generationConfig.maxOutputTokens;
            if (currentMaxTokens && currentMaxTokens <= thinkingBudget) {
                googleRequest.generationConfig.maxOutputTokens = thinkingBudget + 8192;
            }

            googleRequest.generationConfig.thinkingConfig = thinkingConfig;
        } else if (isGeminiModel) {
            googleRequest.generationConfig.thinkingConfig = {
                includeThoughts: true,
                thinkingBudget: clampGeminiThinkingBudget(modelName, thinking?.budget_tokens)
            };
        }
    }

    if (tools && tools.length > 0) {
        const functionDeclarations = tools.map((tool, idx) => {
            const name = tool.name || tool.function?.name || tool.custom?.name || `tool-${idx}`;
            const description = tool.description || tool.function?.description || tool.custom?.description || '';
            const schema = tool.input_schema
                || tool.function?.input_schema
                || tool.function?.parameters
                || tool.custom?.input_schema
                || tool.parameters
                || { type: 'object' };

            let parameters = sanitizeSchema(schema);
            parameters = cleanSchema(parameters);

            return {
                name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
                description: description,
                parameters
            };
        });

        googleRequest.tools = [{ functionDeclarations }];

        if (isClaudeModel) {
            googleRequest.toolConfig = {
                functionCallingConfig: {
                    mode: 'VALIDATED'
                }
            };
        }
    }

    if (isGeminiModel && googleRequest.generationConfig.maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS) {
        googleRequest.generationConfig.maxOutputTokens = GEMINI_MAX_OUTPUT_TOKENS;
    }

    return googleRequest;
}
