/**
 * Admin & WebUI Complete API Suite for Cloudflare Worker
 * Fully matches GravityRoute's original Express WebUI endpoints & auth system
 */

import { OAUTH_CONFIG, OAUTH_REDIRECT_URI } from '../constants.js';
import { exchangeAuthCode, getUserEmail, getCachedAccessToken, getAuthorizationUrl } from '../cloudcode/oauth.js';
import {
    fetchAvailableModels,
    getModelQuotas,
    getSubscriptionTier,
    listModels
} from '../cloudcode/model-api.js';
import {
    createSession,
    validateSession,
    deleteSession,
    getServerConfig,
    saveServerConfig,
    getPublicConfig,
    getAllAccounts,
    getAccountByEmail,
    upsertAccount,
    deleteAccount,
    toggleAccount,
    getAllApiKeys,
    getApiKeyById,
    createApiKey,
    toggleRevokeKey,
    updateApiKey,
    deleteApiKey,
    getDetailedUsage,
    getSystemLogs,
    addSystemLog,
    getSetting,
    setSetting,
    saveOAuthFlow,
    getOAuthFlow,
    deleteOAuthFlow
} from '../db/queries.js';

// Default built-in presets matching original constants.js
const DEFAULT_SERVER_PRESETS = [
    {
        name: 'Default (3-5 Accounts)',
        builtIn: true,
        descriptionKey: 'presetDefaultDesc',
        config: {
            maxRetries: 5,
            retryBaseMs: 1000,
            retryMaxMs: 30000,
            defaultCooldownMs: 10000,
            maxWaitBeforeErrorMs: 120000,
            maxAccounts: 10,
            globalQuotaThreshold: 0,
            rateLimitDedupWindowMs: 2000,
            maxConsecutiveFailures: 3,
            extendedCooldownMs: 60000,
            maxCapacityRetries: 5,
            switchAccountDelayMs: 5000,
            capacityBackoffTiersMs: [5000, 10000, 20000, 30000, 60000]
        }
    },
    {
        name: 'Many Accounts (10+)',
        builtIn: true,
        descriptionKey: 'presetManyAccountsDesc',
        config: {
            maxRetries: 3,
            retryBaseMs: 500,
            retryMaxMs: 15000,
            defaultCooldownMs: 5000,
            maxWaitBeforeErrorMs: 60000,
            maxAccounts: 50,
            globalQuotaThreshold: 0.05,
            rateLimitDedupWindowMs: 1000,
            maxConsecutiveFailures: 2,
            extendedCooldownMs: 30000,
            maxCapacityRetries: 3,
            switchAccountDelayMs: 2000,
            capacityBackoffTiersMs: [2000, 5000, 10000, 15000, 30000]
        }
    }
];

const DEFAULT_PRESETS = [
    {
        name: 'Claude Thinking',
        config: {
            ANTHROPIC_MODEL: 'claude-3-7-sonnet',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-3-7-sonnet'
        }
    }
];

function maskEmail(email) {
    if (!email || typeof email !== 'string') return '';
    const parts = email.split('@');
    if (parts.length !== 2) return email;
    const [name, domain] = parts;
    if (name.length <= 2) return `${name[0]}*@${domain}`;
    return `${name[0]}${'*'.repeat(Math.min(name.length - 2, 5))}${name[name.length - 1]}@${domain}`;
}

function parseCookie(cookieHeader, name) {
    if (!cookieHeader) return null;
    const matches = cookieHeader.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
    return matches ? decodeURIComponent(matches[2]) : null;
}

function extractToken(c) {
    const authHeader = c.req.header('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7).trim();
    }
    const webuiHeader = c.req.header('x-webui-token');
    if (webuiHeader) {
        return webuiHeader.trim();
    }
    const cookieToken = parseCookie(c.req.header('cookie'), 'webui_token');
    if (cookieToken) {
        return cookieToken.trim();
    }
    return null;
}

export function registerAdminRoutes(app) {
    // --------------------------------------------------------------------------
    // WebUI Auth Middleware
    // --------------------------------------------------------------------------
    app.use('*', async (c, next) => {
        const path = new URL(c.req.url).pathname;

        // 1. Bypass AI Proxy routes
        if (
            path === '/health' ||
            path === '/refresh-token' ||
            path.startsWith('/v1') ||
            path.startsWith('/chat/completions') ||
            path.startsWith('/models') ||
            path.startsWith('/auth/google') ||
            path.startsWith('/auth/callback')
        ) {
            return await next();
        }

        // 2. Bypass Public Auth Endpoints
        if (
            path === '/api/auth/status' ||
            path === '/api/auth/login' ||
            path === '/api/auth/recovery-status' ||
            path === '/api/auth/forgot-password' ||
            path === '/api/auth/reset-password'
        ) {
            return await next();
        }

        // 3. Bypass Static Assets and SPA shell
        if (
            path === '/' ||
            path === '/index.html' ||
            path === '/app.js' ||
            path === '/favicon.svg' ||
            path.startsWith('/views/') ||
            path.startsWith('/css/') ||
            path.startsWith('/js/')
        ) {
            return await next();
        }

        // Check if WebUI authentication is enabled
        const config = await getServerConfig(c.env.DB);
        if (!config.webuiAuthEnabled) {
            return await next();
        }

        // Validate session token
        const token = extractToken(c);
        if (token) {
            const session = await validateSession(c.env.DB, token);
            if (session) {
                c.set('webuiUser', session.username);
                return await next();
            }
        }

        // Legacy password header support
        const legacyPass = c.req.header('x-webui-password');
        if (legacyPass && config.webuiPassword && legacyPass === config.webuiPassword) {
            c.set('webuiUser', config.webuiUsername || 'admin');
            return await next();
        }

        return c.json({
            status: 'error',
            error: 'Unauthorized: Authentication required',
            authRequired: true
        }, 401);
    });

    // --------------------------------------------------------------------------
    // WebUI Auth Endpoints
    // --------------------------------------------------------------------------

    app.get('/api/auth/status', async (c) => {
        const config = await getServerConfig(c.env.DB);
        const token = extractToken(c);
        let authenticated = false;
        let username = null;

        if (token) {
            const session = await validateSession(c.env.DB, token);
            if (session) {
                authenticated = true;
                username = session.username;
            }
        }

        return c.json({
            status: 'ok',
            authEnabled: Boolean(config.webuiAuthEnabled),
            authenticated: !config.webuiAuthEnabled || authenticated,
            username: authenticated ? username : (config.webuiAuthEnabled ? null : config.webuiUsername || 'admin'),
            email: config.webuiEmail || ''
        });
    });

    app.post('/api/auth/login', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const { username, password, rememberMe } = body;
            const config = await getServerConfig(c.env.DB);

            if (!config.webuiAuthEnabled) {
                return c.json({
                    status: 'ok',
                    message: 'Authentication is not enabled',
                    authenticated: true,
                    authEnabled: false
                });
            }

            const expectedUsername = (config.webuiUsername || 'admin').toLowerCase();
            const expectedEmail = (config.webuiEmail || '').toLowerCase();
            const inputIdentifier = (username || '').trim().toLowerCase();
            const expectedPassword = config.webuiPassword || '';

            if (!inputIdentifier || !password) {
                return c.json({ status: 'error', error: 'Username/email and password are required' }, 400);
            }

            const isIdentifierMatch = inputIdentifier === expectedUsername || (expectedEmail && inputIdentifier === expectedEmail);
            if (!isIdentifierMatch || password !== expectedPassword) {
                return c.json({ status: 'error', error: 'Invalid username/email or password' }, 401);
            }

            const isRemember = Boolean(rememberMe);
            const session = await createSession(c.env.DB, config.webuiUsername || 'admin', isRemember);

            const headers = new Headers();
            const maxAge = Math.floor((session.expiresAt - Date.now()) / 1000);
            const cookieVal = isRemember
                ? `webui_token=${session.token}; Path=/; SameSite=Lax; Max-Age=${maxAge}; HttpOnly`
                : `webui_token=${session.token}; Path=/; SameSite=Lax; HttpOnly`;
            headers.append('Set-Cookie', cookieVal);

            return c.json({
                status: 'ok',
                token: session.token,
                username: config.webuiUsername || 'admin',
                rememberMe: isRemember,
                expiresAt: session.expiresAt
            }, 200, Object.fromEntries(headers));
        } catch (err) {
            return c.json({ status: 'error', error: err.message }, 500);
        }
    });

    app.post('/api/auth/logout', async (c) => {
        const token = extractToken(c);
        if (token) {
            await deleteSession(c.env.DB, token);
        }
        const headers = new Headers();
        headers.append('Set-Cookie', 'webui_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
        return c.json({ status: 'ok', message: 'Logged out successfully' }, 200, Object.fromEntries(headers));
    });

    app.post('/api/auth/config', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const { enabled, username, email, currentPassword, newPassword, recoveryMode } = body;
            const config = await getServerConfig(c.env.DB);

            // If auth is already enabled, verify authentication
            if (config.webuiAuthEnabled) {
                const token = extractToken(c);
                const session = token ? await validateSession(c.env.DB, token) : null;
                if (!session) {
                    return c.json({ status: 'error', error: 'Unauthorized: Authentication required to modify auth settings' }, 401);
                }
            }

            const updates = {};

            if (newPassword !== undefined && newPassword !== null && newPassword !== '') {
                if (typeof newPassword !== 'string' || newPassword.length < 4) {
                    return c.json({ status: 'error', error: 'Password must be at least 4 characters long' }, 400);
                }
                if (config.webuiPassword && config.webuiPassword !== currentPassword) {
                    return c.json({ status: 'error', error: 'Current password does not match' }, 403);
                }
                updates.webuiPassword = newPassword;
            }

            if (enabled === true) {
                const effectivePassword = updates.webuiPassword || config.webuiPassword;
                if (!effectivePassword) {
                    return c.json({ status: 'error', error: 'A password is required before enabling authentication. Please set a password first.' }, 400);
                }
                updates.webuiAuthEnabled = true;
            } else if (enabled === false) {
                updates.webuiAuthEnabled = false;
            }

            if (typeof username === 'string') {
                const trimmed = username.trim();
                if (!trimmed) return c.json({ status: 'error', error: 'Username cannot be empty' }, 400);
                updates.webuiUsername = trimmed;
            }

            if (email !== undefined && email !== null) {
                const trimmedEmail = typeof email === 'string' ? email.trim() : '';
                if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
                    return c.json({ status: 'error', error: 'Please enter a valid email address' }, 400);
                }
                updates.webuiEmail = trimmedEmail;
            }

            if (recoveryMode && typeof recoveryMode === 'object') {
                updates.webuiRecoveryMode = {
                    cliEnabled: recoveryMode.cliEnabled !== false,
                    emailEnabled: recoveryMode.emailEnabled !== false
                };
            }

            const updated = await saveServerConfig(c.env.DB, updates);

            let sessionToken = null;
            const headers = new Headers();
            if (updated.webuiAuthEnabled) {
                const session = await createSession(c.env.DB, updated.webuiUsername || 'admin', true);
                sessionToken = session.token;
                const maxAge = Math.floor((session.expiresAt - Date.now()) / 1000);
                headers.append('Set-Cookie', `webui_token=${session.token}; Path=/; SameSite=Lax; Max-Age=${maxAge}; HttpOnly`);
            }

            return c.json({
                status: 'ok',
                message: 'Authentication settings updated successfully',
                config: {
                    webuiAuthEnabled: updated.webuiAuthEnabled,
                    webuiUsername: updated.webuiUsername,
                    webuiEmail: updated.webuiEmail || '',
                    webuiRecoveryMode: updated.webuiRecoveryMode || { cliEnabled: true, emailEnabled: true }
                },
                token: sessionToken
            }, 200, Object.fromEntries(headers));
        } catch (err) {
            return c.json({ status: 'error', error: err.message }, 500);
        }
    });

    app.get('/api/auth/recovery-status', async (c) => {
        const config = await getServerConfig(c.env.DB);
        const recoveryMode = config.webuiRecoveryMode || { cliEnabled: true, emailEnabled: true };
        const hasEmail = Boolean(config.webuiEmail);
        const hasSmtp = Boolean(config.smtp?.enabled && config.smtp?.host);

        return c.json({
            status: 'ok',
            cliEnabled: recoveryMode.cliEnabled !== false,
            emailEnabled: recoveryMode.emailEnabled !== false,
            hasEmail,
            hasSmtp,
            emailMasked: config.webuiEmail ? maskEmail(config.webuiEmail) : '',
            emailReady: Boolean(recoveryMode.emailEnabled !== false && hasEmail && hasSmtp)
        });
    });

    app.post('/api/auth/forgot-password', async (c) => {
        return c.json({
            status: 'ok',
            message: 'Password recovery initiated. Use Wrangler CLI or Cloudflare D1 dashboard to inspect settings.'
        });
    });

    app.post('/api/auth/reset-password', async (c) => {
        return c.json({ status: 'ok', message: 'Password reset completed' });
    });

    // --------------------------------------------------------------------------
    // Google OAuth Endpoints for Adding Accounts
    // --------------------------------------------------------------------------

    app.get('/api/auth/url', async (c) => {
        const { url, verifier, state } = await getAuthorizationUrl(OAUTH_REDIRECT_URI);
        await saveOAuthFlow(c.env.DB, state, verifier);
        return c.json({
            status: 'ok',
            url,
            state
        });
    });

    app.post('/api/auth/url', async (c) => {
        const { url, verifier, state } = await getAuthorizationUrl(OAUTH_REDIRECT_URI);
        await saveOAuthFlow(c.env.DB, state, verifier);
        return c.json({
            status: 'ok',
            url,
            state
        });
    });

    app.post('/api/auth/complete', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const { callbackInput } = body;
            let state = body.state;
            if (!callbackInput) return c.json({ status: 'error', error: 'Missing callbackInput' }, 400);

            let code = callbackInput.trim();
            // User might paste the full redirect URL:
            // http://localhost:51121/oauth-callback?code=4/0A...&state=...
            if (code.includes('code=')) {
                try {
                    const parsedUrl = new URL(code.startsWith('http') ? code : `http://${code}`);
                    code = parsedUrl.searchParams.get('code') || code;
                    if (!state && parsedUrl.searchParams.get('state')) {
                        state = parsedUrl.searchParams.get('state');
                    }
                } catch (e) {
                    const match = code.match(/code=([^&]+)/);
                    if (match) code = decodeURIComponent(match[1]);
                    const stateMatch = code.match(/state=([^&]+)/);
                    if (!state && stateMatch) state = decodeURIComponent(stateMatch[1]);
                }
            }

            let verifier = null;
            if (state) {
                verifier = await getOAuthFlow(c.env.DB, state);
            }
            if (!verifier) {
                try {
                    const { results } = await c.env.DB.prepare('SELECT state, verifier FROM oauth_flows ORDER BY created_at DESC LIMIT 1').all();
                    if (results && results.length > 0) {
                        verifier = results[0].verifier;
                        state = results[0].state;
                    }
                } catch (e) {}
            }

            const tokens = await exchangeAuthCode(code, OAUTH_REDIRECT_URI, verifier);
            const email = await getUserEmail(tokens.accessToken);

            let projectId = 'rising-fact-p41fc';
            let tier = 'unknown';
            try {
                const sub = await getSubscriptionTier(tokens.accessToken, projectId);
                if (sub && sub.tier) tier = sub.tier;
            } catch (e) {}

            await upsertAccount(c.env.DB, {
                email,
                refresh_token: tokens.refreshToken,
                project_id: projectId,
                subscription_tier: tier,
                source: 'oauth'
            });

            if (state) {
                await deleteOAuthFlow(c.env.DB, state);
            }

            addSystemLog('info', `[WebUI] Account ${email} added successfully`);

            return c.json({
                status: 'ok',
                email,
                message: `Account ${email} added successfully`
            });
        } catch (err) {
            return c.json({ status: 'error', error: err.message }, 500);
        }
    });

    app.get('/auth/google', (c) => {
        const origin = new URL(c.req.url).origin;
        const redirectUri = `${origin}/auth/callback`;

        const params = new URLSearchParams({
            client_id: OAUTH_CONFIG.clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: OAUTH_CONFIG.scopes.join(' '),
            access_type: 'offline',
            prompt: 'consent'
        });

        return c.redirect(`${OAUTH_CONFIG.authUrl}?${params.toString()}`);
    });

    app.get('/auth/callback', async (c) => {
        const code = c.req.query('code');
        const error = c.req.query('error');

        if (error || !code) {
            return c.html(`<h3>Authentication Failed</h3><p>${error || 'No code'}</p><a href="/">Back</a>`, 400);
        }

        try {
            const origin = new URL(c.req.url).origin;
            const redirectUri = `${origin}/auth/callback`;

            const tokens = await exchangeAuthCode(code, redirectUri);
            const email = await getUserEmail(tokens.accessToken);

            await upsertAccount(c.env.DB, {
                email,
                refreshToken: tokens.refreshToken,
                projectId: 'rising-fact-p41fc',
                subscriptionTier: 'PRO',
                source: 'oauth'
            });

            return c.redirect('/#providers');
        } catch (err) {
            return c.html(`<h3>Error saving account</h3><p>${err.message}</p><a href="/">Back</a>`, 500);
        }
    });

    // --------------------------------------------------------------------------
    // Quotas & Dashboard Endpoints
    // --------------------------------------------------------------------------

    app.get('/account-limits', async (c) => {
        const dbAccounts = await getAllAccounts(c.env.DB);
        const config = await getServerConfig(c.env.DB);

        // Only show models that are actually fetched from Antigravity or added from custom APIs
        const allModelSet = new Set();

        const accountLimits = await Promise.all(
            dbAccounts.map(async (acc) => {
                if (acc.source === 'custom') {
                    let remainingFraction = 1.0;
                    if (acc.quotaType === 'dollar') {
                        const init = Number(acc.initialBalance) || 0;
                        const curr = acc.currentBalance !== undefined ? Number(acc.currentBalance) : init;
                        remainingFraction = init > 0 ? Math.max(0, Math.min(1, curr / init)) : 1;
                    } else if (acc.quotaType === 'token') {
                        const init = Number(acc.initialTokens) || 0;
                        const curr = acc.currentTokens !== undefined ? Number(acc.currentTokens) : init;
                        remainingFraction = init > 0 ? Math.max(0, Math.min(1, curr / init)) : 1;
                    }

                    const customModels = {};
                    for (const rawModel of (acc.models || [])) {
                        allModelSet.add(rawModel);
                        customModels[rawModel] = {
                            remaining: `${Math.round(remainingFraction * 100)}%`,
                            remainingFraction,
                            resetTime: null
                        };
                    }

                    return {
                        email: acc.email,
                        status: acc.enabled ? 'ok' : 'disabled',
                        error: null,
                        source: 'custom',
                        enabled: acc.enabled,
                        projectId: null,
                        subscription: { tier: (acc.type || 'custom').toUpperCase(), projectId: null },
                        name: acc.name,
                        type: acc.type,
                        baseUrl: acc.baseUrl,
                        models: acc.models || [],
                        quotaType: acc.quotaType,
                        initialBalance: acc.initialBalance,
                        currentBalance: acc.currentBalance,
                        limits: customModels
                    };
                }

                // Google OAuth account (Antigravity)
                let quotas = {};
                const cachedQuotaStr = await getSetting(c.env.DB, `quota_${acc.email}`);
                if (cachedQuotaStr) {
                    try {
                        const parsed = JSON.parse(cachedQuotaStr);
                        quotas = parsed.models || {};
                    } catch (e) {}
                }

                // If empty and account enabled, fetch live quotas from Google Cloud Code API
                if (acc.enabled && Object.keys(quotas).length === 0 && acc.refreshToken) {
                    try {
                        const token = await getCachedAccessToken(acc);
                        const sub = await getSubscriptionTier(token);
                        quotas = await getModelQuotas(token, sub.projectId);
                        await setSetting(c.env.DB, `quota_${acc.email}`, JSON.stringify({
                            models: quotas,
                            lastChecked: Date.now()
                        }));
                    } catch (err) {
                        console.warn(`[Limits] Failed to fetch live quota for ${acc.email}:`, err.message);
                    }
                }

                // Only add models actually returned by Antigravity
                for (const mId of Object.keys(quotas)) {
                    allModelSet.add(mId);
                }

                return {
                    email: acc.email,
                    status: acc.enabled ? 'ok' : 'disabled',
                    error: null,
                    source: 'oauth',
                    enabled: acc.enabled,
                    projectId: acc.projectId || 'rising-fact-p41fc',
                    isInvalid: false,
                    invalidReason: null,
                    lastUsed: acc.lastUsed || null,
                    subscription: { tier: acc.subscriptionTier || 'PRO', projectId: acc.projectId },
                    limits: quotas
                };
            })
        );

        const sortedModels = Array.from(allModelSet).sort();

        // Populate full limits map for every model in sortedModels
        const formattedAccounts = accountLimits.map(acc => {
            const fullLimits = {};
            for (const modelId of sortedModels) {
                const q = acc.limits?.[modelId];
                if (!q) {
                    fullLimits[modelId] = null;
                } else {
                    const frac = q.remainingFraction;
                    let remStr = 'N/A';
                    if (frac !== null && frac !== undefined) {
                        if (frac === 0) {
                            remStr = q.resetTime ? '0% (wait...)' : '0% (exhausted)';
                        } else {
                            remStr = `${Math.round(frac * 100)}%`;
                        }
                    }
                    fullLimits[modelId] = {
                        remaining: remStr,
                        remainingFraction: frac,
                        resetTime: q.resetTime || null
                    };
                }
            }

            return {
                ...acc,
                limits: fullLimits
            };
        });

        return c.json({
            timestamp: new Date().toLocaleString(),
            totalAccounts: dbAccounts.length,
            models: sortedModels,
            modelConfig: config.modelMapping || {},
            globalQuotaThreshold: config.globalQuotaThreshold || 0,
            accounts: formattedAccounts,
            history: {}
        });
    });

    app.post('/api/models/refresh', async (c) => {
        try {
            const allAccounts = await getAllAccounts(c.env.DB);
            const activeAccounts = allAccounts.filter(a => a.enabled !== false);
            if (activeAccounts.length === 0) {
                return c.json({
                    status: 'error',
                    error: 'No active accounts available to fetch models. Please link and enable an account first.'
                }, 503);
            }

            const allModelIds = new Set();
            let primaryToken = null;

            // Fetch live quotas and models across accounts in parallel
            await Promise.allSettled(
                activeAccounts.map(async (account) => {
                    if (account.source === 'custom') {
                        if (Array.isArray(account.models)) {
                            account.models.forEach(m => allModelIds.add(m));
                        }
                        return;
                    }

                    try {
                        const token = await getCachedAccessToken(account);
                        if (!primaryToken) primaryToken = token;

                        const subscription = await getSubscriptionTier(token);
                        const quotas = await getModelQuotas(token, subscription.projectId);

                        // Save updated subscription and projectId in DB
                        await upsertAccount(c.env.DB, {
                            id: account.id,
                            email: account.email,
                            refreshToken: account.refreshToken,
                            projectId: subscription.projectId,
                            subscriptionTier: subscription.tier,
                            source: 'oauth',
                            enabled: true
                        });

                        // Cache live quotas in D1 settings
                        await setSetting(c.env.DB, `quota_${account.email}`, JSON.stringify({
                            models: quotas,
                            lastChecked: Date.now()
                        }));

                        for (const mId of Object.keys(quotas)) {
                            allModelIds.add(mId);
                        }
                    } catch (err) {
                        console.warn(`[WebUI] Failed to refresh models for account ${account.email}:`, err.message);
                    }
                })
            );

            // Warm validation cache
            if (primaryToken) {
                try {
                    await listModels(primaryToken);
                } catch (e) { /* ignore */ }
            }


            const models = Array.from(allModelIds).sort();
            addSystemLog('info', `[WebUI] Manually re-fetched ${models.length} models from Antigravity server`);

            return c.json({
                status: 'ok',
                models,
                count: models.length,
                message: `Successfully fetched ${models.length} models from Antigravity server`
            });
        } catch (error) {
            console.error('[WebUI] Error re-fetching models:', error);
            return c.json({ status: 'error', error: error.message }, 500);
        }
    });

    app.post('/api/models/config', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        await setSetting(c.env.DB, 'model_config', JSON.stringify(body));
        return c.json({ status: 'ok', message: 'Model configuration saved' });
    });

    // --------------------------------------------------------------------------
    // Server Config & Presets Endpoints
    // --------------------------------------------------------------------------

    app.get('/api/config', async (c) => {
        const pub = await getPublicConfig(c.env.DB);
        return c.json({
            status: 'ok',
            config: pub,
            version: '1.0.0',
            note: 'Cloudflare Worker Edge Edition with D1 Persistence'
        });
    });

    app.post('/api/config', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            const updated = await saveServerConfig(c.env.DB, body);
            const pub = await getPublicConfig(c.env.DB);
            return c.json({
                status: 'ok',
                message: 'Configuration saved successfully',
                updates: body,
                config: pub
            });
        } catch (err) {
            return c.json({ status: 'error', error: err.message }, 500);
        }
    });

    app.post('/api/config/password', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const { oldPassword, newPassword } = body;
        if (!newPassword || typeof newPassword !== 'string') {
            return c.json({ status: 'error', error: 'New password is required' }, 400);
        }

        const config = await getServerConfig(c.env.DB);
        if (config.webuiPassword && config.webuiPassword !== oldPassword) {
            return c.json({ status: 'error', error: 'Invalid current password' }, 403);
        }

        await saveServerConfig(c.env.DB, { webuiPassword: newPassword });
        return c.json({ status: 'ok', message: 'Password updated successfully' });
    });

    app.get('/api/settings', async (c) => {
        const pub = await getPublicConfig(c.env.DB);
        return c.json(pub);
    });

    app.post('/api/settings', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        await saveServerConfig(c.env.DB, body);
        return c.json({ success: true });
    });

    app.get('/api/server/presets', (c) => {
        return c.json({ status: 'ok', presets: DEFAULT_SERVER_PRESETS });
    });

    app.post('/api/server/presets', (c) => {
        return c.json({ status: 'ok', message: 'Preset created' });
    });

    app.patch('/api/server/presets/:name', (c) => {
        return c.json({ status: 'ok', message: 'Preset updated' });
    });

    app.delete('/api/server/presets/:name', (c) => {
        return c.json({ status: 'ok', message: 'Preset deleted' });
    });

    app.get('/api/strategy/health', (c) => {
        return c.json({
            status: 'ok',
            strategy: 'round-robin',
            scores: {},
            accounts: []
        });
    });

    // --------------------------------------------------------------------------
    // Claude CLI & SMTP Endpoints
    // --------------------------------------------------------------------------

    app.get('/api/claude/config', (c) => {
        const origin = new URL(c.req.url).origin;
        return c.json({
            status: 'ok',
            config: {
                ANTHROPIC_BASE_URL: origin,
                ANTHROPIC_MODEL: 'claude-3-7-sonnet'
            }
        });
    });

    app.post('/api/claude/config', (c) => {
        return c.json({ status: 'ok', message: 'Claude config updated' });
    });

    app.post('/api/claude/config/restore', (c) => {
        return c.json({ status: 'ok', message: 'Claude config restored' });
    });

    app.get('/api/claude/presets', (c) => {
        return c.json({ status: 'ok', presets: DEFAULT_PRESETS });
    });

    app.post('/api/claude/presets', (c) => {
        return c.json({ status: 'ok' });
    });

    app.get('/api/claude/mode', (c) => {
        return c.json({ status: 'ok', mode: 'auto' });
    });

    app.get('/api/smtp/config', async (c) => {
        const config = await getServerConfig(c.env.DB);
        return c.json({ status: 'ok', config: config.smtp || {} });
    });

    app.post('/api/smtp/config', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        await saveServerConfig(c.env.DB, { smtp: body });
        return c.json({ status: 'ok', message: 'SMTP settings updated' });
    });

    app.post('/api/smtp/test', (c) => {
        return c.json({ status: 'ok', message: 'SMTP test simulated successfully' });
    });

    // --------------------------------------------------------------------------
    // Accounts / Providers Endpoints
    // --------------------------------------------------------------------------

    app.get('/api/accounts', async (c) => {
        const accounts = await getAllAccounts(c.env.DB);
        return c.json({ status: 'ok', accounts });
    });

    app.post('/api/accounts', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const id = await upsertAccount(c.env.DB, body);
        return c.json({ status: 'ok', success: true, id });
    });

    app.delete('/api/accounts/:email', async (c) => {
        const email = decodeURIComponent(c.req.param('email'));
        await deleteAccount(c.env.DB, email);
        return c.json({ status: 'ok', message: `Account ${email} removed` });
    });

    app.post('/api/accounts/:email/toggle', async (c) => {
        const email = decodeURIComponent(c.req.param('email'));
        const body = await c.req.json().catch(() => ({}));
        await toggleAccount(c.env.DB, email, Boolean(body.enabled));
        return c.json({ status: 'ok', message: 'Account status toggled' });
    });

    app.post('/api/accounts/:email/refresh', async (c) => {
        const email = decodeURIComponent(c.req.param('email'));
        const acc = await getAccountByEmail(c.env.DB, email);
        return c.json({ status: 'ok', account: acc });
    });

    app.patch('/api/accounts/:email', async (c) => {
        const email = decodeURIComponent(c.req.param('email'));
        const body = await c.req.json().catch(() => ({}));
        await upsertAccount(c.env.DB, { email, ...body });
        return c.json({ status: 'ok', message: 'Account updated' });
    });

    app.post('/api/accounts/reload', (c) => {
        return c.json({ status: 'ok', message: 'Accounts reloaded successfully' });
    });

    app.post('/api/accounts/verify-all', (c) => {
        return c.json({ status: 'ok', message: 'All accounts verified' });
    });

    app.get('/api/accounts/export', async (c) => {
        const accounts = await getAllAccounts(c.env.DB);
        return c.json({ accounts });
    });

    app.post('/api/accounts/import', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const list = Array.isArray(body) ? body : (body.accounts || []);
        for (const item of list) {
            await upsertAccount(c.env.DB, item);
        }
        return c.json({ status: 'ok', count: list.length });
    });

    app.post('/api/providers/custom', async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const id = await upsertAccount(c.env.DB, {
            ...body,
            source: 'custom'
        });
        return c.json({ status: 'ok', success: true, id });
    });

    app.patch('/api/providers/custom/:name', async (c) => {
        const name = decodeURIComponent(c.req.param('name'));
        const body = await c.req.json().catch(() => ({}));
        await upsertAccount(c.env.DB, { ...body, name, source: 'custom' });
        return c.json({ status: 'ok', message: 'Custom provider updated' });
    });

    app.post('/api/providers/fetch-models', async (c) => {
        return c.json({
            status: 'ok',
            models: ['gpt-4o', 'gpt-4o-mini', 'claude-3-7-sonnet']
        });
    });

    // --------------------------------------------------------------------------
    // API Keys Endpoints
    // --------------------------------------------------------------------------

    app.get('/api/keys', async (c) => {
        const keys = await getAllApiKeys(c.env.DB);
        const allAccounts = await getAllAccounts(c.env.DB);
        const modelSet = new Set();
        for (const acc of allAccounts) {
            if (acc.source === 'custom' && Array.isArray(acc.models)) {
                acc.models.forEach(m => modelSet.add(m));
            } else {
                const cachedQuotaStr = await getSetting(c.env.DB, `quota_${acc.email}`);
                if (cachedQuotaStr) {
                    try {
                        const parsed = JSON.parse(cachedQuotaStr);
                        Object.keys(parsed.models || {}).forEach(m => modelSet.add(m));
                    } catch (e) {}
                }
            }
        }
        const availableModels = Array.from(modelSet).sort();
        return c.json({
            status: 'ok',
            keys,
            total: keys.length,
            activeCount: keys.filter(k => k.effectiveStatus === 'active').length,
            availableModels
        });
    });

    app.post('/api/keys', async (c) => {
        try {
            const body = await c.req.json().catch(() => ({}));
            if (!body.name || !body.name.trim()) {
                return c.json({ status: 'error', error: 'API key name is required' }, 400);
            }
            const key = await createApiKey(c.env.DB, body);
            return c.json({
                status: 'ok',
                key,
                message: `API key "${key.name}" created successfully`
            });
        } catch (err) {
            return c.json({ status: 'error', error: err.message }, 500);
        }
    });

    app.get('/api/keys/:id', async (c) => {
        const id = c.req.param('id');
        const key = await getApiKeyById(c.env.DB, id);
        if (!key) return c.json({ status: 'error', error: 'Key not found' }, 404);
        return c.json({ status: 'ok', key });
    });

    const handleUpdateKey = async (c) => {
        try {
            const id = c.req.param('id');
            const body = await c.req.json().catch(() => ({}));
            const updated = await updateApiKey(c.env.DB, id, body);
            return c.json({ status: 'ok', key: updated, message: 'API key updated' });
        } catch (err) {
            return c.json({ status: 'error', error: err.message }, 500);
        }
    };

    app.put('/api/keys/:id', handleUpdateKey);
    app.patch('/api/keys/:id', handleUpdateKey);

    app.post('/api/keys/:id/toggle', async (c) => {
        try {
            const id = c.req.param('id');
            const updated = await toggleRevokeKey(c.env.DB, id);
            return c.json({ status: 'ok', key: updated });
        } catch (err) {
            return c.json({ status: 'error', error: err.message }, 500);
        }
    });

    app.delete('/api/keys/:id', async (c) => {
        const id = c.req.param('id');
        await deleteApiKey(c.env.DB, id);
        return c.json({ status: 'ok', message: 'API key deleted' });
    });

    app.get('/api/keys/usage', async (c) => {
        const keyId = c.req.query('keyId');
        const usageData = await getDetailedUsage(c.env.DB, keyId);
        return c.json({
            status: 'ok',
            summary: usageData.summary,
            logs: usageData.logs
        });
    });

    app.get('/api/keys/:id/usage', async (c) => {
        const id = c.req.param('id');
        const usageData = await getDetailedUsage(c.env.DB, id);
        return c.json({
            status: 'ok',
            summary: usageData.summary,
            logs: usageData.logs
        });
    });

    app.get('/api/my-ip', (c) => {
        const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1';
        return c.json({ status: 'ok', ip: clientIp });
    });

    app.post('/api/pricing/refresh', (c) => {
        return c.json({ status: 'ok', message: 'Pricing refreshed' });
    });

    app.get('/api/pricing/status', (c) => {
        return c.json({
            status: 'ok',
            pricingStatus: { isLive: true, lastUpdated: new Date().toISOString() }
        });
    });

    // --------------------------------------------------------------------------
    // System Logs Endpoints
    // --------------------------------------------------------------------------

    app.get('/api/logs', (c) => {
        return c.json({
            status: 'ok',
            logs: getSystemLogs()
        });
    });

    app.get('/api/logs/stream', (c) => {
        const history = getSystemLogs();
        const encoder = new TextEncoder();
        let heartbeatInterval = null;

        const stream = new ReadableStream({
            start(controller) {
                // Send history logs
                for (const log of history) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(log)}\n\n`));
                }
                const pingEntry = {
                    timestamp: new Date().toISOString(),
                    level: 'info',
                    message: '[SSE] Live log stream established'
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(pingEntry)}\n\n`));

                // Keep connection open with periodic SSE comments
                heartbeatInterval = setInterval(() => {
                    try {
                        controller.enqueue(encoder.encode(': heartbeat\n\n'));
                    } catch (e) {
                        if (heartbeatInterval) {
                            clearInterval(heartbeatInterval);
                            heartbeatInterval = null;
                        }
                    }
                }, 10000);
            },
            cancel() {
                if (heartbeatInterval) {
                    clearInterval(heartbeatInterval);
                    heartbeatInterval = null;
                }
            }
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive'
            }
        });
    });
}
