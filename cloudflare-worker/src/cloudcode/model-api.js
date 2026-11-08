/**
 * Model API for Cloud Code in Cloudflare Worker
 * Handles real-time model listing and quota retrieval from Google Cloud Code internal APIs
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    LOAD_CODE_ASSIST_ENDPOINTS,
    LOAD_CODE_ASSIST_HEADERS,
    DEFAULT_PROJECT_ID
} from '../constants.js';

export const CLIENT_METADATA = {
    ideType: 6,      // ANTIGRAVITY
    platform: 1,     // DARWIN_AMD64
    pluginType: 2    // GEMINI
};

/**
 * Check if a model ID is supported (Claude or Gemini)
 */
export function isSupportedModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return false;
    const lower = modelId.toLowerCase();
    return lower.startsWith('claude') || lower.startsWith('gemini') || lower.includes('claude') || lower.includes('gemini');
}

/**
 * Fetch available models with quota info from Google Cloud Code API
 * @param {string} token - Google OAuth access token
 * @param {string} [projectId] - Project ID (e.g. rising-fact-p41fc)
 * @returns {Promise<Object>} Raw response containing models dictionary
 */
export async function fetchAvailableModels(token, projectId = null) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    const body = projectId ? { project: projectId } : {};

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:fetchAvailableModels`;
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                console.warn(`[CloudCode] fetchAvailableModels error at ${endpoint}: ${response.status} ${errorText}`);
                if (response.status === 403) {
                    const lower = (errorText || '').toLowerCase();
                    if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
                        throw new Error(`ACCOUNT_BANNED: ${errorText}`);
                    }
                }
                continue;
            }

            const data = await response.json();
            return data;
        } catch (err) {
            console.warn(`[CloudCode] fetchAvailableModels failed at ${endpoint}:`, err.message);
            if (err.message?.startsWith('ACCOUNT_BANNED:')) throw err;
        }
    }

    throw new Error('Failed to fetch available models from Google Cloud Code endpoints');
}

/**
 * Get subscription tier and project ID for an account from Google's loadCodeAssist API
 * @param {string} token - Google OAuth access token
 * @returns {Promise<{tier: string, projectId: string|null}>}
 */
export async function getSubscriptionTier(token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...LOAD_CODE_ASSIST_HEADERS
    };

    for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
        try {
            const url = `${endpoint}/v1internal:loadCodeAssist`;
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    metadata: CLIENT_METADATA,
                    mode: 1
                })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                console.warn(`[CloudCode] loadCodeAssist error at ${endpoint}: ${response.status}`);
                if (response.status === 403) {
                    const lower = (errorText || '').toLowerCase();
                    if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
                        throw new Error(`ACCOUNT_BANNED: ${errorText}`);
                    }
                }
                continue;
            }

            const data = await response.json();

            // Extract project ID
            let projectId = null;
            if (typeof data.cloudaicompanionProject === 'string') {
                projectId = data.cloudaicompanionProject;
            } else if (data.cloudaicompanionProject?.id) {
                projectId = data.cloudaicompanionProject.id;
            }

            // Extract subscription tier
            let tier = 'PRO';
            if (data.paidTier?.id) {
                const id = data.paidTier.id.toLowerCase();
                if (id.includes('ultra')) tier = 'ULTRA';
                else if (id.includes('pro')) tier = 'PRO';
                else if (id.includes('free')) tier = 'FREE';
            } else if (data.currentTier?.id) {
                const id = data.currentTier.id.toLowerCase();
                if (id.includes('ultra')) tier = 'ULTRA';
                else if (id.includes('standard') || id.includes('pro')) tier = 'PRO';
                else if (id.includes('free')) tier = 'FREE';
            }

            return {
                tier,
                projectId: projectId || DEFAULT_PROJECT_ID
            };
        } catch (err) {
            console.warn(`[CloudCode] loadCodeAssist failed at ${endpoint}:`, err.message);
            if (err.message?.startsWith('ACCOUNT_BANNED:')) throw err;
        }
    }

    return {
        tier: 'PRO',
        projectId: DEFAULT_PROJECT_ID
    };
}

/**
 * Get model quotas map for an account
 * @param {string} token - Google OAuth access token
 * @param {string} [projectId] - Project ID
 * @returns {Promise<Object>} Map of modelId -> { remainingFraction, resetTime, displayName }
 */
export async function getModelQuotas(token, projectId = null) {
    const data = await fetchAvailableModels(token, projectId);
    if (!data || !data.models) return {};

    const quotas = {};
    for (const [modelId, modelData] of Object.entries(data.models)) {
        if (!isSupportedModel(modelId)) continue;

        if (modelData.quotaInfo) {
            quotas[modelId] = {
                remainingFraction: modelData.quotaInfo.remainingFraction ?? (modelData.quotaInfo.resetTime ? 0 : 1.0),
                resetTime: modelData.quotaInfo.resetTime ?? null,
                displayName: modelData.displayName || modelId
            };
        } else {
            quotas[modelId] = {
                remainingFraction: 1.0,
                resetTime: null,
                displayName: modelData.displayName || modelId
            };
        }
    }

    return quotas;
}

/**
 * List available models in Anthropic API format
 * @param {string} token - Google OAuth access token
 * @returns {Promise<{object: string, data: Array<Object>}>}
 */
export async function listModels(token) {
    try {
        const data = await fetchAvailableModels(token);
        if (!data || !data.models) {
            return { object: 'list', data: [] };
        }

        const modelList = Object.entries(data.models)
            .filter(([modelId]) => isSupportedModel(modelId))
            .map(([modelId, modelData]) => ({
                id: modelId,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'anthropic',
                description: modelData.displayName || modelId
            }));

        return {
            object: 'list',
            data: modelList
        };
    } catch (err) {
        console.warn('[CloudCode] listModels failed:', err.message);
        return {
            object: 'list',
            data: []
        };
    }
}
