/**
 * OpenAI Model Mapper
 * Maps OpenAI model identifiers (e.g. gpt-4o, gpt-4o-mini, o1) to available native backend models
 * while allowing any native model ID to be passed directly.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Standard default mappings from OpenAI model identifiers to native Cloud Code models
 */
export const DEFAULT_OPENAI_ALIASES = {
    // Flagship models -> Claude Sonnet 4.6
    'gpt-4o': 'claude-sonnet-4-6',
    'gpt-4o-2024-08-06': 'claude-sonnet-4-6',
    'gpt-4o-2024-11-20': 'claude-sonnet-4-6',
    'chatgpt-4o-latest': 'claude-sonnet-4-6',

    // Fast / efficient models -> Gemini 2.5 Flash
    'gpt-4o-mini': 'gemini-2.5-flash',
    'gpt-4o-mini-2024-07-18': 'gemini-2.5-flash',
    'gpt-3.5-turbo': 'gemini-2.5-flash',
    'gpt-3.5-turbo-0125': 'gemini-2.5-flash',
    'gpt-3.5-turbo-1106': 'gemini-2.5-flash',

    // Advanced reasoning & deep thinking models -> Claude Opus 4.6 Thinking
    'o1': 'claude-opus-4-6-thinking',
    'o1-preview': 'claude-opus-4-6-thinking',
    'o1-mini': 'gemini-2.5-flash',
    'o3-mini': 'gemini-2.5-flash',
    'gpt-4': 'claude-opus-4-6-thinking',
    'gpt-4-turbo': 'claude-opus-4-6-thinking',
    'gpt-4-turbo-preview': 'claude-opus-4-6-thinking'
};

/**
 * Resolve an incoming model name to a valid backend model ID
 *
 * Priority:
 * 1. User config override (config.modelMapping[model].mapping)
 * 2. Exact match if already a native model ID
 * 3. Default OpenAI alias map (e.g. gpt-4o -> claude-sonnet-4-6)
 * 4. Fallback default model
 *
 * @param {string} requestedModel - Model identifier sent by client
 * @param {Set<string>|Array<string>} [validModels] - Optional set/array of valid models from Cloud Code
 * @returns {string} Effective native model ID
 */
export function resolveOpenAiModel(requestedModel, validModels = null) {
    if (!requestedModel || typeof requestedModel !== 'string') {
        return 'claude-sonnet-4-6';
    }

    const trimmed = requestedModel.trim();
    const modelMapping = config?.modelMapping || {};

    // 1. Check user configured custom model mapping
    if (modelMapping[trimmed] && modelMapping[trimmed].mapping) {
        const target = modelMapping[trimmed].mapping;
        logger.info(`[OpenAI-Mapper] Custom mapped ${trimmed} -> ${target}`);
        return target;
    }

    // 2. If it's a known native model ID (or starts with claude- or gemini-), use it directly
    const isNativePattern = trimmed.startsWith('claude-') || trimmed.startsWith('gemini-');
    if (validModels) {
        const set = validModels instanceof Set ? validModels : new Set(validModels);
        if (set.has(trimmed)) {
            return trimmed;
        }
    } else if (isNativePattern) {
        return trimmed;
    }

    // 3. Check OpenAI alias map (case-insensitive)
    const lower = trimmed.toLowerCase();
    for (const [alias, target] of Object.entries(DEFAULT_OPENAI_ALIASES)) {
        if (lower === alias.toLowerCase()) {
            logger.info(`[OpenAI-Mapper] Alias mapped ${trimmed} -> ${target}`);
            return target;
        }
    }

    // 4. Prefix-based heuristics for custom OpenAI versions
    if (lower.startsWith('gpt-4o-mini')) {
        return 'gemini-2.5-flash';
    }
    if (lower.startsWith('gpt-4o') || lower.startsWith('chatgpt-4o')) {
        return 'claude-sonnet-4-6';
    }
    if (lower.startsWith('o1') || lower.startsWith('o3')) {
        return 'claude-opus-4-6-thinking';
    }
    if (lower.startsWith('gpt-4')) {
        return 'claude-opus-4-6-thinking';
    }
    if (lower.startsWith('gpt-3')) {
        return 'gemini-2.5-flash';
    }

    // 5. If it's not a known OpenAI alias or prefix, pass through the requested model directly
    // so any native model ID from /v1/models can be used and validated
    return trimmed;
}

/**
 * Return list of OpenAI model aliases formatted for /v1/models response
 * @returns {Array<{id: string, object: string, created: number, owned_by: string, description: string}>}
 */
export function getOpenAiModelAliases() {
    const now = Math.floor(Date.now() / 1000);
    const uniqueAliases = [
        { id: 'gpt-4o', description: 'OpenAI GPT-4o (Mapped to Claude Sonnet 4.6)' },
        { id: 'gpt-4o-mini', description: 'OpenAI GPT-4o Mini (Mapped to Gemini 2.5 Flash)' },
        { id: 'o1', description: 'OpenAI o1 Reasoning (Mapped to Claude Opus 4.6 Thinking)' },
        { id: 'o3-mini', description: 'OpenAI o3-mini (Mapped to Gemini 2.5 Flash)' },
        { id: 'gpt-4-turbo', description: 'OpenAI GPT-4 Turbo (Mapped to Claude Opus 4.6 Thinking)' },
        { id: 'gpt-4', description: 'OpenAI GPT-4 (Mapped to Claude Opus 4.6 Thinking)' },
        { id: 'gpt-3.5-turbo', description: 'OpenAI GPT-3.5 Turbo (Mapped to Gemini 2.5 Flash)' }
    ];

    return uniqueAliases.map(item => ({
        id: item.id,
        object: 'model',
        created: now,
        owned_by: 'openai',
        description: item.description
    }));
}

export default {
    DEFAULT_OPENAI_ALIASES,
    resolveOpenAiModel,
    getOpenAiModelAliases
};
