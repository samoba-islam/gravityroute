/**
 * Thinking Block Utilities for Cloudflare Worker
 */

import { MIN_SIGNATURE_LENGTH } from '../constants.js';
import { getCachedSignatureFamily } from './signature-cache.js';

const GEMINI_THINKING_BUDGET_LIMITS = {
    '2.5': 24576,
};
const GEMINI_DEFAULT_THINKING_BUDGET = 16000;
const GEMINI_DEFAULT_THINKING_BUDGET_LIMIT = 128000;

export function clampGeminiThinkingBudget(modelName, budget) {
    const requestedBudget = budget || GEMINI_DEFAULT_THINKING_BUDGET;
    const lower = (modelName || '').toLowerCase();
    const versionMatch = lower.match(/gemini-(\d+(?:\.\d+)?)/);
    let maxBudget = GEMINI_DEFAULT_THINKING_BUDGET_LIMIT;

    if (versionMatch) {
        const version = versionMatch[1];
        if (GEMINI_THINKING_BUDGET_LIMITS[version]) {
            maxBudget = GEMINI_THINKING_BUDGET_LIMITS[version];
        } else {
            const major = version.split('.')[0];
            if (GEMINI_THINKING_BUDGET_LIMITS[major]) {
                maxBudget = GEMINI_THINKING_BUDGET_LIMITS[major];
            }
        }
    }

    if (requestedBudget > maxBudget) {
        return maxBudget;
    }
    return requestedBudget;
}

export function cleanCacheControl(messages) {
    if (!Array.isArray(messages)) return messages;

    return messages.map(message => {
        if (!message || typeof message !== 'object') return message;
        if (typeof message.content === 'string') return message;
        if (!Array.isArray(message.content)) return message;

        const cleanedContent = message.content.map(block => {
            if (!block || typeof block !== 'object') return block;
            if (block.cache_control === undefined) return block;
            const { cache_control, ...cleanBlock } = block;
            return cleanBlock;
        });

        return {
            ...message,
            content: cleanedContent
        };
    });
}

function isThinkingPart(part) {
    return part.type === 'thinking' ||
        part.type === 'redacted_thinking' ||
        part.thinking !== undefined ||
        part.thought === true;
}

function hasValidSignature(part) {
    const signature = part.thought === true ? part.thoughtSignature : part.signature;
    return typeof signature === 'string' && signature.length >= MIN_SIGNATURE_LENGTH;
}

export function hasGeminiHistory(messages) {
    return messages.some(msg =>
        Array.isArray(msg.content) &&
        msg.content.some(block =>
            block.type === 'tool_use' && block.thoughtSignature !== undefined
        )
    );
}

export function hasUnsignedThinkingBlocks(messages) {
    return messages.some(msg => {
        if (msg.role !== 'assistant' && msg.role !== 'model') return false;
        if (!Array.isArray(msg.content)) return false;
        return msg.content.some(block =>
            isThinkingPart(block) && !hasValidSignature(block)
        );
    });
}

function sanitizeThinkingPart(part) {
    if (part.thought === true) {
        const sanitized = { thought: true };
        if (part.text !== undefined) sanitized.text = part.text;
        if (part.thoughtSignature !== undefined) sanitized.thoughtSignature = part.thoughtSignature;
        return sanitized;
    }

    if (part.type === 'thinking' || part.thinking !== undefined) {
        const sanitized = { type: 'thinking' };
        if (part.thinking !== undefined) sanitized.thinking = part.thinking;
        if (part.signature !== undefined) sanitized.signature = part.signature;
        return sanitized;
    }

    return part;
}

function sanitizeAnthropicThinkingBlock(block) {
    if (!block) return block;
    if (block.type === 'thinking') {
        const sanitized = { type: 'thinking' };
        if (block.thinking !== undefined) sanitized.thinking = block.thinking;
        if (block.signature !== undefined) sanitized.signature = block.signature;
        return sanitized;
    }
    if (block.type === 'redacted_thinking') {
        const sanitized = { type: 'redacted_thinking' };
        if (block.data !== undefined) sanitized.data = block.data;
        return sanitized;
    }
    return block;
}

function sanitizeTextBlock(block) {
    if (!block || block.type !== 'text') return block;
    const sanitized = { type: 'text' };
    if (block.text !== undefined) sanitized.text = block.text;
    return sanitized;
}

function sanitizeToolUseBlock(block) {
    if (!block || block.type !== 'tool_use') return block;
    const sanitized = { type: 'tool_use' };
    if (block.id !== undefined) sanitized.id = block.id;
    if (block.name !== undefined) sanitized.name = block.name;
    if (block.input !== undefined) sanitized.input = block.input;
    if (block.thoughtSignature !== undefined) sanitized.thoughtSignature = block.thoughtSignature;
    return sanitized;
}

function filterContentArray(contentArray) {
    const filtered = [];
    for (const item of contentArray) {
        if (!item || typeof item !== 'object') {
            filtered.push(item);
            continue;
        }
        if (!isThinkingPart(item)) {
            filtered.push(item);
            continue;
        }
        if (hasValidSignature(item)) {
            filtered.push(sanitizeThinkingPart(item));
        }
    }
    return filtered;
}

export function filterUnsignedThinkingBlocks(contents) {
    return contents.map(content => {
        if (!content || typeof content !== 'object') return content;
        if (Array.isArray(content.parts)) {
            return { ...content, parts: filterContentArray(content.parts) };
        }
        return content;
    });
}

export function removeTrailingThinkingBlocks(content) {
    if (!Array.isArray(content) || content.length === 0) return content;

    let endIndex = content.length;
    for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i];
        if (!block || typeof block !== 'object') break;

        if (isThinkingPart(block)) {
            if (!hasValidSignature(block)) {
                endIndex = i;
            } else {
                break;
            }
        } else {
            break;
        }
    }

    if (endIndex < content.length) {
        return content.slice(0, endIndex);
    }
    return content;
}

export function restoreThinkingSignatures(content) {
    if (!Array.isArray(content)) return content;
    const filtered = [];
    for (const block of content) {
        if (!block || block.type !== 'thinking') {
            filtered.push(block);
            continue;
        }
        if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) {
            filtered.push(sanitizeAnthropicThinkingBlock(block));
        }
    }
    return filtered;
}

export function reorderAssistantContent(content) {
    if (!Array.isArray(content)) return content;
    if (content.length === 1) {
        const block = content[0];
        if (block && (block.type === 'thinking' || block.type === 'redacted_thinking')) {
            return [sanitizeAnthropicThinkingBlock(block)];
        }
        return content;
    }

    const thinkingBlocks = [];
    const textBlocks = [];
    const toolUseBlocks = [];

    for (const block of content) {
        if (!block) continue;
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            thinkingBlocks.push(sanitizeAnthropicThinkingBlock(block));
        } else if (block.type === 'tool_use') {
            toolUseBlocks.push(sanitizeToolUseBlock(block));
        } else if (block.type === 'text') {
            if (block.text && block.text.trim().length > 0) {
                textBlocks.push(sanitizeTextBlock(block));
            }
        } else {
            textBlocks.push(block);
        }
    }

    return [...thinkingBlocks, ...textBlocks, ...toolUseBlocks];
}

function messageHasValidThinking(message) {
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return false;
    return content.some(block => {
        if (!isThinkingPart(block)) return false;
        if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) return true;
        if (block.thoughtSignature && block.thoughtSignature.length >= MIN_SIGNATURE_LENGTH) return true;
        return false;
    });
}

function messageHasToolUse(message) {
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return false;
    return content.some(block => block.type === 'tool_use' || block.functionCall);
}

function messageHasToolResult(message) {
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return false;
    return content.some(block => block.type === 'tool_result' || block.functionResponse);
}

function isPlainUserMessage(message) {
    if (message.role !== 'user') return false;
    const content = message.content || message.parts || [];
    if (!Array.isArray(content)) return typeof content === 'string';
    return !content.some(block => block.type === 'tool_result' || block.functionResponse);
}

function analyzeConversationState(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { inToolLoop: false, interruptedTool: false, turnHasThinking: false, toolResultCount: 0 };
    }

    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' || messages[i].role === 'model') {
            lastAssistantIdx = i;
            break;
        }
    }

    if (lastAssistantIdx === -1) {
        return { inToolLoop: false, interruptedTool: false, turnHasThinking: false, toolResultCount: 0 };
    }

    const lastAssistant = messages[lastAssistantIdx];
    const hasToolUse = messageHasToolUse(lastAssistant);
    const hasThinking = messageHasValidThinking(lastAssistant);

    let toolResultCount = 0;
    let hasPlainUserMessageAfter = false;
    for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
        if (messageHasToolResult(messages[i])) {
            toolResultCount++;
        }
        if (isPlainUserMessage(messages[i])) {
            hasPlainUserMessageAfter = true;
        }
    }

    const inToolLoop = hasToolUse && toolResultCount > 0;
    const interruptedTool = hasToolUse && toolResultCount === 0 && hasPlainUserMessageAfter;

    return {
        inToolLoop,
        interruptedTool,
        turnHasThinking: hasThinking,
        toolResultCount,
        lastAssistantIdx
    };
}

export function needsThinkingRecovery(messages) {
    const state = analyzeConversationState(messages);
    if (!state.inToolLoop && !state.interruptedTool) return false;
    return !state.turnHasThinking;
}

function stripInvalidThinkingBlocks(messages, targetFamily = null) {
    return messages.map(msg => {
        const content = msg.content || msg.parts;
        if (!Array.isArray(content)) return msg;

        const filtered = content.filter(block => {
            if (!isThinkingPart(block)) return true;
            if (!hasValidSignature(block)) return false;

            if (targetFamily === 'gemini') {
                const signature = block.thought === true ? block.thoughtSignature : block.signature;
                const signatureFamily = getCachedSignatureFamily(signature);
                if (!signatureFamily || signatureFamily !== targetFamily) return false;
            }
            return true;
        });

        if (msg.content) {
            return { ...msg, content: filtered.length > 0 ? filtered : [{ type: 'text', text: '.' }] };
        } else if (msg.parts) {
            return { ...msg, parts: filtered.length > 0 ? filtered : [{ text: '.' }] };
        }
        return msg;
    });
}

export function closeToolLoopForThinking(messages, targetFamily = null) {
    const state = analyzeConversationState(messages);
    if (!state.inToolLoop && !state.interruptedTool) return messages;

    let modified = stripInvalidThinkingBlocks(messages, targetFamily);

    if (state.interruptedTool) {
        const insertIdx = state.lastAssistantIdx + 1;
        modified.splice(insertIdx, 0, {
            role: 'assistant',
            content: [{ type: 'text', text: '[Tool call was interrupted.]' }]
        });
    } else if (state.inToolLoop) {
        const syntheticText = state.toolResultCount === 1
            ? '[Tool execution completed.]'
            : `[${state.toolResultCount} tool executions completed.]`;

        modified.push({
            role: 'assistant',
            content: [{ type: 'text', text: syntheticText }]
        });

        modified.push({
            role: 'user',
            content: [{ type: 'text', text: '[Continue]' }]
        });
    }

    return modified;
}
