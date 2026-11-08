/**
 * /v1/models & /models Route Handler for Cloudflare Worker
 * Fully compatible with both Anthropic API and OpenAI API client specifications
 */

import {
    getAllAccounts,
    getAllApiKeys,
    validateApiKey,
    getSetting,
    setSetting
} from '../db/queries.js';
import { getCachedAccessToken } from '../cloudcode/oauth.js';
import { getModelQuotas, getSubscriptionTier } from '../cloudcode/model-api.js';

export async function handleListModels(c) {
    const db = c.env.DB;

    // 1. Authenticate API Key from client headers or query param
    const authHeader = c.req.header('authorization') || '';
    const apiKeyHeader = c.req.header('x-api-key') || '';
    const queryKey = c.req.query('key') || c.req.query('api_key') || '';
    const clientKey = apiKeyHeader || authHeader.replace(/^Bearer\s+/i, '') || queryKey;

    const isAnthropicClient = Boolean(apiKeyHeader || c.req.header('anthropic-version') || (c.req.header('user-agent') || '').includes('anthropic'));

    let keyRecord = null;
    if (clientKey) {
        keyRecord = await validateApiKey(db, clientKey);
        if (!keyRecord && c.env.PROXY_API_KEY && clientKey === c.env.PROXY_API_KEY) {
            keyRecord = { id: 'env_master', name: 'Master Key' };
        }
    }

    // If no key provided or key is invalid when keys are configured in D1
    if (!keyRecord) {
        const allKeys = await getAllApiKeys(db);
        if (allKeys.length > 0 || c.env.PROXY_API_KEY) {
            if (isAnthropicClient) {
                return c.json({
                    type: 'error',
                    error: {
                        type: 'authentication_error',
                        message: 'invalid x-api-key'
                    }
                }, 401);
            }
            return c.json({
                error: {
                    message: 'Incorrect API key provided. You can find your API key in the GravityRoute console.',
                    type: 'invalid_request_error',
                    param: null,
                    code: 'invalid_api_key'
                }
            }, 401);
        }
    }

    // 2. Fetch live models dynamically from Antigravity & Custom Provider accounts
    const allAccounts = await getAllAccounts(db);
    const modelSet = new Set();
    const modelDetails = new Map();

    for (const acc of allAccounts) {
        if (acc.source === 'custom') {
            const providerName = acc.name || 'custom';
            for (const rawModel of (acc.models || [])) {
                modelSet.add(rawModel);
                modelDetails.set(rawModel, {
                    id: rawModel,
                    owned_by: providerName,
                    displayName: rawModel
                });
            }
        } else if (acc.enabled !== false) {
            let quotas = {};
            const cachedQuotaStr = await getSetting(db, `quota_${acc.email}`);
            if (cachedQuotaStr) {
                try {
                    const parsed = JSON.parse(cachedQuotaStr);
                    quotas = parsed.models || {};
                } catch (e) {}
            }

            if (Object.keys(quotas).length === 0 && acc.refreshToken) {
                try {
                    const token = await getCachedAccessToken(acc);
                    const sub = await getSubscriptionTier(token);
                    quotas = await getModelQuotas(token, sub.projectId);
                    await setSetting(db, `quota_${acc.email}`, JSON.stringify({
                        models: quotas,
                        lastChecked: Date.now()
                    }));
                } catch (err) {
                    console.warn(`[Models] Failed to fetch live quota for ${acc.email}:`, err.message);
                }
            }

            for (const [mId, mData] of Object.entries(quotas)) {
                modelSet.add(mId);
                const isClaude = mId.toLowerCase().includes('claude');
                modelDetails.set(mId, {
                    id: mId,
                    owned_by: isClaude ? 'anthropic' : 'google',
                    displayName: mData?.displayName || mId
                });
            }
        }
    }

    let modelIds = Array.from(modelSet).sort();

    // 3. Filter models if key has model restriction enabled
    if (keyRecord && keyRecord.modelRestrictionEnabled && Array.isArray(keyRecord.allowedModels) && keyRecord.allowedModels.length > 0) {
        const allowed = new Set(keyRecord.allowedModels.map(m => m.toLowerCase().trim()));
        modelIds = modelIds.filter(m => allowed.has(m.toLowerCase().trim()));
    }

    // 4. Format payload supporting both Anthropic and OpenAI schemas
    const nowSec = Math.floor(Date.now() / 1000);
    const isoDate = new Date().toISOString();

    const formattedList = modelIds.map(mId => {
        const info = modelDetails.get(mId) || {};
        return {
            id: mId,
            object: 'model',                           // OpenAI spec
            type: 'model',                             // Anthropic spec
            created: nowSec,                           // OpenAI spec
            created_at: isoDate,                       // Anthropic spec
            display_name: info.displayName || mId,     // Anthropic spec
            owned_by: info.owned_by || 'anthropic'     // OpenAI spec
        };
    });

    return c.json({
        object: 'list',                                // OpenAI spec
        data: formattedList,                           // Both OpenAI & Anthropic
        has_more: false,                               // Anthropic spec
        first_id: formattedList.length > 0 ? formattedList[0].id : null,
        last_id: formattedList.length > 0 ? formattedList[formattedList.length - 1].id : null
    });
}

export async function handleGetSingleModel(c) {
    const modelParam = c.req.param('model');
    const db = c.env.DB;

    // Validate key
    const authHeader = c.req.header('authorization') || '';
    const apiKeyHeader = c.req.header('x-api-key') || '';
    const clientKey = apiKeyHeader || authHeader.replace(/^Bearer\s+/i, '');

    if (clientKey) {
        const keyRecord = await validateApiKey(db, clientKey);
        if (!keyRecord && c.env.PROXY_API_KEY && clientKey === c.env.PROXY_API_KEY) {
            // master key
        } else if (!keyRecord) {
            return c.json({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }, 401);
        }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const isClaude = modelParam.toLowerCase().includes('claude');

    return c.json({
        id: modelParam,
        object: 'model',
        type: 'model',
        created: nowSec,
        created_at: new Date().toISOString(),
        display_name: modelParam,
        owned_by: isClaude ? 'anthropic' : 'google'
    });
}
