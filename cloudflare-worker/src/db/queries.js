/**
 * D1 Database Queries and State Manager for Cloudflare Worker
 * Fully matches GravityRoute's original data models and auth workflows
 */

// In-memory system log buffer for real-time monitoring and SSE streaming
const logHistory = [];
const MAX_LOG_HISTORY = 200;

export function addSystemLog(level, message, details = null) {
    const entry = {
        timestamp: new Date().toISOString(),
        level: level.toLowerCase(),
        message,
        details: details || null
    };
    logHistory.push(entry);
    if (logHistory.length > MAX_LOG_HISTORY) {
        logHistory.shift();
    }
    console.log(`[${entry.level.toUpperCase()}] ${message}`);
    return entry;
}

export function getSystemLogs() {
    return [...logHistory];
}

// --------------------------------------------------------------------------
// 1. WebUI Sessions Management
// --------------------------------------------------------------------------

const SESSION_EXPIRY_DEFAULT = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_EXPIRY_REMEMBER = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(db, username = 'admin', rememberMe = false) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

    const now = Date.now();
    const ttl = rememberMe ? SESSION_EXPIRY_REMEMBER : SESSION_EXPIRY_DEFAULT;
    const expiresAt = now + ttl;

    await db.prepare(`
        INSERT INTO sessions (token, username, created_at, expires_at, remember_me)
        VALUES (?, ?, ?, ?, ?)
    `).bind(token, username, now, expiresAt, rememberMe ? 1 : 0).run();

    addSystemLog('info', `[Auth] Session created for user ${username} (rememberMe: ${rememberMe})`);
    return { token, expiresAt, username, rememberMe: Boolean(rememberMe) };
}

export async function validateSession(db, token) {
    if (!token) return null;
    const now = Date.now();
    const { results } = await db.prepare(`
        SELECT * FROM sessions WHERE token = ? AND expires_at > ?
    `).bind(token, now).all();

    if (results && results.length > 0) {
        return results[0];
    }
    return null;
}

export async function deleteSession(db, token) {
    if (!token) return;
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    addSystemLog('info', `[Auth] Session invalidated`);
}

export async function cleanExpiredSessions(db) {
    const now = Date.now();
    await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
}

// --------------------------------------------------------------------------
// 2. Settings & Server Configuration
// --------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
    apiKey: '',
    webuiAuthEnabled: false,
    webuiUsername: 'admin',
    webuiEmail: '',
    webuiPassword: '',
    webuiRecoveryMode: {
        cliEnabled: true,
        emailEnabled: true
    },
    smtp: {
        enabled: false,
        host: '',
        port: 587,
        secure: false,
        user: '',
        pass: '',
        fromEmail: '',
        fromName: 'GravityRoute Proxy'
    },
    debug: false,
    devMode: false,
    logLevel: 'info',
    maxRetries: 5,
    retryBaseMs: 1000,
    retryMaxMs: 30000,
    persistTokenCache: false,
    defaultCooldownMs: 10000,
    maxWaitBeforeErrorMs: 120000,
    maxAccounts: 10,
    globalQuotaThreshold: 0,
    requestThrottlingEnabled: false,
    requestDelayMs: 200,
    rateLimitDedupWindowMs: 2000,
    maxConsecutiveFailures: 3,
    extendedCooldownMs: 60000,
    maxCapacityRetries: 5,
    switchAccountDelayMs: 5000,
    capacityBackoffTiersMs: [5000, 10000, 20000, 30000, 60000],
    modelMapping: {},
    accountSelection: {
        strategy: 'round-robin',
        healthScore: {
            initial: 70,
            successReward: 1,
            rateLimitPenalty: -10,
            failurePenalty: -20,
            recoveryPerHour: 10,
            minUsable: 50,
            maxScore: 100
        },
        tokenBucket: {
            maxTokens: 50,
            tokensPerMinute: 6,
            initialTokens: 50
        },
        quota: {
            lowThreshold: 0.10,
            criticalThreshold: 0.05,
            staleMs: 300000
        },
        weights: {
            health: 2,
            tokens: 5,
            quota: 3,
            lru: 0.1
        }
    }
};

export async function getSetting(db, key, defaultValue = null) {
    const { results } = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).all();
    if (results && results.length > 0) {
        return results[0].value;
    }
    return defaultValue;
}

export async function setSetting(db, key, value) {
    await db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(key, value).run();
}

export async function getServerConfig(db) {
    const raw = await getSetting(db, 'server_config');
    let saved = {};
    if (raw) {
        try { saved = JSON.parse(raw); } catch (e) {}
    }

    // Read individual WebUI auth keys
    const authEnabled = await getSetting(db, 'webui_auth_enabled');
    const username = await getSetting(db, 'webui_username');
    const email = await getSetting(db, 'webui_email');
    const password = await getSetting(db, 'webui_password');
    const recoveryRaw = await getSetting(db, 'webui_recovery_mode');

    let recoveryMode = DEFAULT_CONFIG.webuiRecoveryMode;
    if (recoveryRaw) {
        try { recoveryMode = JSON.parse(recoveryRaw); } catch (e) {}
    }

    return {
        ...DEFAULT_CONFIG,
        ...saved,
        webuiAuthEnabled: authEnabled !== null ? authEnabled === 'true' : DEFAULT_CONFIG.webuiAuthEnabled,
        webuiUsername: username || DEFAULT_CONFIG.webuiUsername,
        webuiEmail: email !== null ? email : DEFAULT_CONFIG.webuiEmail,
        webuiPassword: password !== null ? password : DEFAULT_CONFIG.webuiPassword,
        webuiRecoveryMode: recoveryMode
    };
}

export async function saveServerConfig(db, updates) {
    const current = await getServerConfig(db);
    const merged = { ...current, ...updates };

    // Separate WebUI auth fields
    if (updates.webuiAuthEnabled !== undefined) {
        await setSetting(db, 'webui_auth_enabled', String(updates.webuiAuthEnabled));
    }
    if (updates.webuiUsername !== undefined) {
        await setSetting(db, 'webui_username', updates.webuiUsername);
    }
    if (updates.webuiEmail !== undefined) {
        await setSetting(db, 'webui_email', updates.webuiEmail);
    }
    if (updates.webuiPassword !== undefined) {
        await setSetting(db, 'webui_password', updates.webuiPassword);
    }
    if (updates.webuiRecoveryMode !== undefined) {
        await setSetting(db, 'webui_recovery_mode', JSON.stringify(updates.webuiRecoveryMode));
    }

    // Save remainder into server_config
    const toSave = { ...merged };
    delete toSave.webuiPassword;
    await setSetting(db, 'server_config', JSON.stringify(toSave));
    addSystemLog('info', '[Config] Server configuration updated');
    return merged;
}

export async function getPublicConfig(db) {
    const full = await getServerConfig(db);
    const pub = JSON.parse(JSON.stringify(full));
    if (pub.webuiPassword) pub.webuiPassword = '********';
    if (pub.apiKey) pub.apiKey = '********';
    if (pub.smtp) {
        pub.smtp.hasPassword = Boolean(pub.smtp?.pass);
        if (pub.smtp.pass) pub.smtp.pass = '********';
    }
    return pub;
}

// --------------------------------------------------------------------------
// 3. Accounts Management
// --------------------------------------------------------------------------

export async function getAvailableAccounts(db) {
    const nowSec = Math.floor(Date.now() / 1000);
    const { results } = await db.prepare(
        'SELECT * FROM accounts WHERE enabled = 1 AND cooldown_until <= ? ORDER BY last_used ASC'
    ).bind(nowSec).all();

    return results || [];
}

export async function setAccountCooldown(db, id, durationSec = 60) {
    const cooldownUntil = Math.floor(Date.now() / 1000) + durationSec;
    await db.prepare('UPDATE accounts SET cooldown_until = ? WHERE id = ?').bind(cooldownUntil, id).run();
}

export async function updateAccountLastUsed(db, id) {
    const nowSec = Math.floor(Date.now() / 1000);
    await db.prepare('UPDATE accounts SET last_used = ? WHERE id = ?').bind(nowSec, id).run();
}

export async function validateApiKey(db, key) {
    if (!key) return null;
    const res = await validateClientApiKey(db, key);
    return res && res.record ? res.record : null;
}

export async function getAllAccounts(db) {
    const { results } = await db.prepare(`
        SELECT id, email, refresh_token, project_id, subscription_tier, enabled, source, custom_config, cooldown_until, last_used, created_at 
        FROM accounts 
        ORDER BY created_at DESC
    `).all();

    return (results || []).map(row => {
        let customData = {};
        if (row.custom_config) {
            try { customData = JSON.parse(row.custom_config); } catch (e) {}
        }
        return {
            id: row.id,
            email: row.email,
            refreshToken: row.refresh_token,
            projectId: row.project_id,
            subscriptionTier: row.subscription_tier,
            enabled: row.enabled === 1,
            source: row.source || 'oauth',
            cooldownUntil: row.cooldown_until || 0,
            lastUsed: row.last_used || 0,
            createdAt: row.created_at,
            ...customData
        };
    });
}

export async function getAccountByEmail(db, email) {
    const { results } = await db.prepare(`
        SELECT * FROM accounts WHERE email = ? OR (source = 'custom' AND json_extract(custom_config, '$.name') = ?)
    `).bind(email, email).all();

    if (results && results.length > 0) {
        const row = results[0];
        let customData = {};
        if (row.custom_config) {
            try { customData = JSON.parse(row.custom_config); } catch (e) {}
        }
        return {
            ...row,
            enabled: row.enabled === 1,
            ...customData
        };
    }
    return null;
}

export async function upsertAccount(db, accountData) {
    const id = accountData.id || crypto.randomUUID();
    const email = accountData.email || accountData.name;
    const refreshToken = accountData.refreshToken || accountData.refresh_token || 'dummy';
    const projectId = accountData.projectId || accountData.project_id || 'rising-fact-p41fc';
    const tier = accountData.subscriptionTier || accountData.subscription_tier || 'custom';
    const source = accountData.source || 'oauth';
    const enabled = accountData.enabled !== false ? 1 : 0;

    let customConfig = null;
    if (source === 'custom') {
        customConfig = JSON.stringify({
            name: accountData.name || email,
            baseUrl: accountData.baseUrl,
            apiKey: accountData.apiKey,
            models: accountData.models || [],
            quotaType: accountData.quotaType || 'dollar',
            initialBalance: accountData.initialBalance,
            currentBalance: accountData.currentBalance,
            initialTokens: accountData.initialTokens,
            currentTokens: accountData.currentTokens,
            pricing: accountData.pricing
        });
    }

    await db.prepare(`
        INSERT INTO accounts (id, email, refresh_token, project_id, subscription_tier, enabled, source, custom_config, cooldown_until, last_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
        ON CONFLICT(email) DO UPDATE SET
            refresh_token = excluded.refresh_token,
            project_id = excluded.project_id,
            subscription_tier = excluded.subscription_tier,
            enabled = excluded.enabled,
            source = excluded.source,
            custom_config = excluded.custom_config,
            cooldown_until = 0
    `).bind(id, email, refreshToken, projectId, tier, enabled, source, customConfig).run();

    addSystemLog('info', `[Accounts] Account ${email} saved successfully`);
    return id;
}

export async function deleteAccount(db, emailOrId) {
    await db.prepare('DELETE FROM accounts WHERE email = ? OR id = ?').bind(emailOrId, emailOrId).run();
    addSystemLog('info', `[Accounts] Account ${emailOrId} removed`);
}

export async function toggleAccount(db, emailOrId, enabled) {
    await db.prepare('UPDATE accounts SET enabled = ? WHERE email = ? OR id = ?').bind(enabled ? 1 : 0, emailOrId, emailOrId).run();
    addSystemLog('info', `[Accounts] Account ${emailOrId} ${enabled ? 'enabled' : 'disabled'}`);
}

// --------------------------------------------------------------------------
// 4. API Keys Management
// --------------------------------------------------------------------------

function isKeyExpired(keyRecord) {
    if (!keyRecord.expiresAt) return false;
    return Date.now() > keyRecord.expiresAt;
}

function isTokenLimitExceeded(keyRecord) {
    if (!keyRecord.tokenLimit || keyRecord.tokenLimit <= 0) return false;
    return (keyRecord.tokensUsed || 0) >= keyRecord.tokenLimit;
}

function getEffectiveStatus(keyRecord) {
    if (keyRecord.status === 'revoked' || keyRecord.enabled === false) return 'revoked';
    if (isKeyExpired(keyRecord)) return 'expired';
    if (isTokenLimitExceeded(keyRecord)) return 'limit_exceeded';
    return 'active';
}

export async function getAllApiKeys(db) {
    const { results } = await db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all();
    return (results || []).map(row => {
        let ipList = [];
        let allowedModels = [];
        try { ipList = JSON.parse(row.ip_list || '[]'); } catch (e) {}
        try { allowedModels = JSON.parse(row.allowed_models || '[]'); } catch (e) {}

        const keyObj = {
            id: row.id,
            key: row.key,
            name: row.name || 'Default Key',
            status: row.status || 'active',
            enabled: row.enabled === 1,
            tokensUsed: row.tokens_used || 0,
            tokenLimit: row.token_limit || 0,
            expiresAt: row.expires_at || null,
            lastUsedAt: row.last_used_at || null,
            ipRestrictionEnabled: row.ip_restriction_enabled === 1,
            ipRestrictionMode: row.ip_restriction_mode || 'allow',
            ipList,
            modelRestrictionEnabled: row.model_restriction_enabled === 1,
            allowedModels,
            createdAt: row.created_at
        };

        keyObj.effectiveStatus = getEffectiveStatus(keyObj);
        keyObj.isExpired = isKeyExpired(keyObj);
        keyObj.isLimitExceeded = isTokenLimitExceeded(keyObj);
        return keyObj;
    });
}

export async function getApiKeyById(db, id) {
    const { results } = await db.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).all();
    if (results && results.length > 0) {
        const row = results[0];
        let ipList = [];
        let allowedModels = [];
        try { ipList = JSON.parse(row.ip_list || '[]'); } catch (e) {}
        try { allowedModels = JSON.parse(row.allowed_models || '[]'); } catch (e) {}

        const keyObj = {
            id: row.id,
            key: row.key,
            name: row.name || 'Default Key',
            status: row.status || 'active',
            enabled: row.enabled === 1,
            tokensUsed: row.tokens_used || 0,
            tokenLimit: row.token_limit || 0,
            expiresAt: row.expires_at || null,
            lastUsedAt: row.last_used_at || null,
            ipRestrictionEnabled: row.ip_restriction_enabled === 1,
            ipRestrictionMode: row.ip_restriction_mode || 'allow',
            ipList,
            modelRestrictionEnabled: row.model_restriction_enabled === 1,
            allowedModels,
            createdAt: row.created_at
        };

        keyObj.effectiveStatus = getEffectiveStatus(keyObj);
        keyObj.isExpired = isKeyExpired(keyObj);
        keyObj.isLimitExceeded = isTokenLimitExceeded(keyObj);
        return keyObj;
    }
    return null;
}

export async function createApiKey(db, {
    name = 'Default Key',
    expiresAt = null,
    presetDays = null,
    tokenLimit = 0,
    ipRestrictionEnabled = false,
    ipRestrictionMode = 'allow',
    ipList = [],
    modelRestrictionEnabled = false,
    allowedModels = []
} = {}) {
    const id = `key_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
    const randomBytes = new Uint8Array(24);
    crypto.getRandomValues(randomBytes);
    const key = `ag-sk-${Array.from(randomBytes, b => b.toString(16).padStart(2, '0')).join('')}`;

    let calculatedExpiresAt = null;
    if (presetDays !== null && presetDays !== undefined) {
        if (presetDays === 'never' || presetDays === 0) {
            calculatedExpiresAt = null;
        } else {
            const days = parseInt(presetDays, 10);
            if (!isNaN(days) && days > 0) {
                calculatedExpiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
            }
        }
    } else if (expiresAt) {
        const parsed = typeof expiresAt === 'string' ? new Date(expiresAt).getTime() : expiresAt;
        if (!isNaN(parsed) && parsed > Date.now()) {
            calculatedExpiresAt = parsed;
        }
    }

    const now = Date.now();
    const ipListStr = JSON.stringify(Array.isArray(ipList) ? ipList : (typeof ipList === 'string' ? ipList.split('\n').map(s => s.trim()).filter(Boolean) : []));
    const allowedModelsStr = JSON.stringify(Array.isArray(allowedModels) ? allowedModels : []);

    await db.prepare(`
        INSERT INTO api_keys (
            id, key, name, status, enabled, tokens_used, token_limit, 
            expires_at, last_used_at, ip_restriction_enabled, ip_restriction_mode, 
            ip_list, model_restriction_enabled, allowed_models, created_at
        ) VALUES (?, ?, ?, 'active', 1, 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `).bind(
        id, key, name.trim(), tokenLimit || 0, calculatedExpiresAt,
        ipRestrictionEnabled ? 1 : 0, ipRestrictionMode || 'allow',
        ipListStr, modelRestrictionEnabled ? 1 : 0, allowedModelsStr, now
    ).run();

    addSystemLog('info', `[APIKeys] Key "${name}" created (${id})`);
    return getApiKeyById(db, id);
}

export async function toggleRevokeKey(db, id) {
    const keyRecord = await getApiKeyById(db, id);
    if (!keyRecord) throw new Error(`API key with ID ${id} not found`);

    const newStatus = keyRecord.status === 'revoked' ? 'active' : 'revoked';
    await db.prepare('UPDATE api_keys SET status = ?, enabled = ? WHERE id = ?')
        .bind(newStatus, newStatus === 'active' ? 1 : 0, id).run();

    addSystemLog('info', `[APIKeys] Key ${id} status toggled to ${newStatus}`);
    return getApiKeyById(db, id);
}

export async function updateApiKey(db, id, updates) {
    const keyRecord = await getApiKeyById(db, id);
    if (!keyRecord) throw new Error(`API key with ID ${id} not found`);

    const name = updates.name !== undefined ? updates.name.trim() : keyRecord.name;
    const tokenLimit = updates.tokenLimit !== undefined ? updates.tokenLimit : keyRecord.tokenLimit;
    const ipRestrictionEnabled = updates.ipRestrictionEnabled !== undefined ? (updates.ipRestrictionEnabled ? 1 : 0) : (keyRecord.ipRestrictionEnabled ? 1 : 0);
    const ipRestrictionMode = updates.ipRestrictionMode || keyRecord.ipRestrictionMode;
    const ipListStr = updates.ipList !== undefined ? JSON.stringify(updates.ipList) : JSON.stringify(keyRecord.ipList);
    const modelRestrictionEnabled = updates.modelRestrictionEnabled !== undefined ? (updates.modelRestrictionEnabled ? 1 : 0) : (keyRecord.modelRestrictionEnabled ? 1 : 0);
    const allowedModelsStr = updates.allowedModels !== undefined ? JSON.stringify(updates.allowedModels) : JSON.stringify(keyRecord.allowedModels);

    let expiresAt = keyRecord.expiresAt;
    if (updates.presetDays !== undefined) {
        if (updates.presetDays === 'never' || updates.presetDays === 0) expiresAt = null;
        else {
            const d = parseInt(updates.presetDays, 10);
            if (!isNaN(d) && d > 0) expiresAt = Date.now() + d * 24 * 60 * 60 * 1000;
        }
    } else if (updates.expiresAt !== undefined) {
        expiresAt = updates.expiresAt;
    }

    await db.prepare(`
        UPDATE api_keys SET
            name = ?, token_limit = ?, expires_at = ?,
            ip_restriction_enabled = ?, ip_restriction_mode = ?, ip_list = ?,
            model_restriction_enabled = ?, allowed_models = ?
        WHERE id = ?
    `).bind(
        name, tokenLimit, expiresAt,
        ipRestrictionEnabled, ipRestrictionMode, ipListStr,
        modelRestrictionEnabled, allowedModelsStr, id
    ).run();

    addSystemLog('info', `[APIKeys] Key ${id} updated`);
    return getApiKeyById(db, id);
}

export async function deleteApiKey(db, id) {
    await db.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
    addSystemLog('info', `[APIKeys] Key ${id} deleted`);
}

export async function validateClientApiKey(db, authHeader) {
    if (!authHeader) return null;
    let rawKey = authHeader;
    if (rawKey.startsWith('Bearer ')) rawKey = rawKey.substring(7).trim();
    if (!rawKey) return null;

    const { results } = await db.prepare('SELECT * FROM api_keys WHERE key = ?').bind(rawKey).all();
    if (!results || results.length === 0) return null;

    const row = results[0];
    let ipList = [];
    let allowedModels = [];
    try { ipList = JSON.parse(row.ip_list || '[]'); } catch (e) {}
    try { allowedModels = JSON.parse(row.allowed_models || '[]'); } catch (e) {}

    const keyRecord = {
        ...row,
        enabled: row.enabled === 1,
        tokensUsed: row.tokens_used || 0,
        tokenLimit: row.token_limit || 0,
        expiresAt: row.expires_at,
        ipList,
        allowedModels,
        effectiveStatus: getEffectiveStatus({
            ...row,
            enabled: row.enabled === 1,
            tokensUsed: row.tokens_used || 0,
            tokenLimit: row.token_limit || 0,
            expiresAt: row.expires_at
        })
    };

    if (keyRecord.effectiveStatus !== 'active') {
        return { error: `API key is ${keyRecord.effectiveStatus}`, record: keyRecord };
    }
    return { record: keyRecord };
}

// --------------------------------------------------------------------------
// 5. Usage Logs & Pricing Metrics
// --------------------------------------------------------------------------

export async function recordUsage(db, { keyId = null, model, inputTokens = 0, outputTokens = 0, cacheTokens = 0, cost = 0.0 }) {
    const id = `use_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
    const now = Date.now();
    const totalTokens = inputTokens + outputTokens + cacheTokens;

    const batch = [
        db.prepare(`
            INSERT INTO usage_logs (id, key_id, model, input_tokens, output_tokens, cache_tokens, total_tokens, cost, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(id, keyId, model, inputTokens, outputTokens, cacheTokens, totalTokens, cost, now)
    ];

    if (keyId) {
        batch.push(
            db.prepare(`
                UPDATE api_keys 
                SET tokens_used = tokens_used + ?, last_used_at = ?
                WHERE id = ?
            `).bind(totalTokens, now, keyId)
        );
    }

    await db.batch(batch);
}

export async function getDetailedUsage(db, keyId = null) {
    let query = 'SELECT * FROM usage_logs';
    const params = [];
    if (keyId) {
        query += ' WHERE key_id = ?';
        params.push(keyId);
    }
    query += ' ORDER BY timestamp DESC LIMIT 200';

    const stmt = params.length > 0 ? db.prepare(query).bind(...params) : db.prepare(query);
    const { results } = await stmt.all();
    const logs = results || [];

    const totalRequests = logs.length;
    let totalTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheTokens = 0;
    let totalCost = 0.0;
    const modelDistribution = {};

    for (const log of logs) {
        totalTokens += log.total_tokens || 0;
        totalInputTokens += log.input_tokens || 0;
        totalOutputTokens += log.output_tokens || 0;
        totalCacheTokens += log.cache_tokens || 0;
        totalCost += log.cost || 0.0;

        const m = log.model || 'unknown';
        modelDistribution[m] = (modelDistribution[m] || 0) + (log.total_tokens || 0);
    }

    return {
        logs,
        summary: {
            totalRequests,
            totalTokens,
            totalInputTokens,
            totalOutputTokens,
            totalCacheTokens,
            totalCost: Number(totalCost.toFixed(6)),
            modelDistribution
        }
    };
}

// --------------------------------------------------------------------------
// 7. OAuth Pending Flows Management
// --------------------------------------------------------------------------

export async function saveOAuthFlow(db, state, verifier) {
    const now = Date.now();
    const expiry = now - 15 * 60 * 1000;
    try {
        await db.prepare('DELETE FROM oauth_flows WHERE created_at < ?').bind(expiry).run();
    } catch (e) {
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS oauth_flows (
                state TEXT PRIMARY KEY,
                verifier TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
        `).run();
    }
    await db.prepare(`
        INSERT INTO oauth_flows (state, verifier, created_at) VALUES (?, ?, ?)
        ON CONFLICT(state) DO UPDATE SET verifier = excluded.verifier, created_at = excluded.created_at
    `).bind(state, verifier, now).run();
}

export async function getOAuthFlow(db, state) {
    try {
        const { results } = await db.prepare('SELECT verifier FROM oauth_flows WHERE state = ?').bind(state).all();
        if (results && results.length > 0) {
            return results[0].verifier;
        }
    } catch (e) {}
    return null;
}

export async function deleteOAuthFlow(db, state) {
    try {
        await db.prepare('DELETE FROM oauth_flows WHERE state = ?').bind(state).run();
    } catch (e) {}
}
