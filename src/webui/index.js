/**
 * WebUI Module - Optional web interface for account management
 *
 * This module provides a web-based UI for:
 * - Dashboard with real-time model quota visualization
 * - Account management (add via OAuth, enable/disable, refresh, remove)
 * - Live server log streaming with filtering
 * - Claude CLI configuration editor
 *
 * Usage in server.js:
 *   import { mountWebUI } from './webui/index.js';
 *   mountWebUI(app, __dirname, accountManager);
 */

import path from 'path';
import crypto from 'crypto';
import express from 'express';
import { getPublicConfig, saveConfig, config, loadConfig } from '../config.js';
import { DEFAULT_PORT, ACCOUNT_CONFIG_PATH, MAX_ACCOUNTS, DEFAULT_PRESETS, DEFAULT_SERVER_PRESETS } from '../constants.js';
import { readClaudeConfig, updateClaudeConfig, replaceClaudeConfig, getClaudeConfigPath, readPresets, savePreset, deletePreset } from '../utils/claude-config.js';
import { readServerPresets, saveServerPreset, updateServerPreset, deleteServerPreset } from '../utils/server-presets.js';
import { logger } from '../utils/logger.js';
import { getAuthorizationUrl, completeOAuthFlow, startCallbackServer } from '../auth/oauth.js';
import { loadAccounts, saveAccounts } from '../account-manager/storage.js';
import { getPackageVersion } from '../utils/helpers.js';
import { getModelQuotas, getSubscriptionTier, listModels } from '../cloudcode/index.js';
import apiKeyManager from '../modules/api-keys.js';
import { fetchLivePricing, getPricingStatus } from '../modules/pricing.js';
import { verifySmtpConnection, sendTestEmail, createTransporter } from '../utils/smtp.js';
import { fetchProviderModels } from '../providers/custom-dispatcher.js';

// Get package version
const packageVersion = getPackageVersion();

// OAuth state storage (state -> { server, verifier, state, timestamp })
// Maps state ID to active OAuth flow data
const pendingOAuthFlows = new Map();

/**
 * WebUI Helper Functions - Direct account manipulation
 * These functions work around AccountManager's limited API by directly
 * manipulating the accounts.json config file (non-invasive approach for PR)
 */

/**
 * Set account enabled/disabled state
 */
async function setAccountEnabled(email, enabled) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const account = accounts.find(a => a.email === email || (a.source === 'custom' && a.name === email));
    if (!account) {
        throw new Error(`Account ${email} not found`);
    }
    account.enabled = enabled;
    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);
    logger.info(`[WebUI] Account ${email} ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Remove account from config
 */
async function removeAccount(email) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
    const index = accounts.findIndex(a => a.email === email || (a.source === 'custom' && a.name === email));
    if (index === -1) {
        throw new Error(`Account ${email} not found`);
    }
    accounts.splice(index, 1);
    // Adjust activeIndex if needed
    const newActiveIndex = activeIndex >= accounts.length ? Math.max(0, accounts.length - 1) : activeIndex;
    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, newActiveIndex);
    logger.info(`[WebUI] Account ${email} removed`);
}

/**
 * Add new account to config
 * @throws {Error} If MAX_ACCOUNTS limit is reached (for new accounts only)
 */
async function addAccount(accountData) {
    const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);

    // Check if account already exists
    const existingIndex = accounts.findIndex(a => a.email === accountData.email);
    if (existingIndex !== -1) {
        // Update existing account
        accounts[existingIndex] = {
            ...accounts[existingIndex],
            ...accountData,
            enabled: true,
            isInvalid: false,
            invalidReason: null,
            addedAt: accounts[existingIndex].addedAt || new Date().toISOString()
        };
        logger.info(`[WebUI] Account ${accountData.email} updated`);
    } else {
        // Check MAX_ACCOUNTS limit before adding new account
        if (accounts.length >= MAX_ACCOUNTS) {
            throw new Error(`Maximum of ${MAX_ACCOUNTS} accounts reached. Update maxAccounts in config to increase the limit.`);
        }
        // Add new account
        accounts.push({
            ...accountData,
            enabled: true,
            isInvalid: false,
            invalidReason: null,
            modelRateLimits: {},
            lastUsed: null,
            addedAt: new Date().toISOString()
        });
        logger.info(`[WebUI] Account ${accountData.email} added`);
    }

    await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);
}

/**
 * WebUI Session Management
 */
const activeSessions = new Map();
const SESSION_EXPIRY_DEFAULT = 24 * 60 * 60 * 1000; // 24 hours (session)
const SESSION_EXPIRY_REMEMBER = 30 * 24 * 60 * 60 * 1000; // 30 days (saved login)

function createSession(username, rememberMe = false) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const ttl = rememberMe ? SESSION_EXPIRY_REMEMBER : SESSION_EXPIRY_DEFAULT;
    const expiresAt = now + ttl;
    activeSessions.set(token, {
        username,
        createdAt: now,
        expiresAt,
        rememberMe: Boolean(rememberMe)
    });
    return { token, expiresAt };
}

function validateSession(token) {
    if (!token) return null;
    const session = activeSessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
        activeSessions.delete(token);
        return null;
    }
    return session;
}

function invalidateSession(token) {
    if (token) activeSessions.delete(token);
}

// Clean up expired sessions periodically (every 15 minutes)
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of activeSessions.entries()) {
        if (now > session.expiresAt) {
            activeSessions.delete(token);
        }
    }
}, 15 * 60 * 1000).unref();

/**
 * Password Reset Management
 */
const pendingPasswordResets = new Map();
const RESET_CODE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

function maskEmail(email) {
    if (!email || typeof email !== 'string') return '';
    const parts = email.split('@');
    if (parts.length !== 2) return email;
    const [name, domain] = parts;
    if (name.length <= 2) return `${name[0]}*@${domain}`;
    return `${name[0]}${'*'.repeat(Math.min(name.length - 2, 5))}${name[name.length - 1]}@${domain}`;
}

async function sendRecoveryCodeEmail(toEmail, code, username) {
    const smtp = config.smtp || {};
    const transporter = createTransporter(smtp);
    const fromName = smtp.fromName || 'Antigravity Proxy';
    const fromEmail = smtp.fromEmail || smtp.user || 'noreply@antigravity.proxy';

    const mailOptions = {
        from: `"${fromName}" <${fromEmail}>`,
        to: toEmail,
        subject: `[Antigravity Proxy] Your Password Reset Code: ${code}`,
        text: `Password Reset Request\n\nYour 6-digit verification code is: ${code}\n\nThis code will expire in 15 minutes.\nIf you did not request this password reset, please ignore this email.`,
        html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 540px; margin: 0 auto; background-color: #0b0f19; color: #e2e8f0; border-radius: 12px; overflow: hidden; border: 1px solid #1e293b;">
            <div style="background: linear-gradient(135deg, #7c3aed, #4f46e5); padding: 24px 32px;">
                <h1 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 700;">⚡ Antigravity Proxy</h1>
                <p style="margin: 4px 0 0 0; color: #c4b5fd; font-size: 13px;">Admin Password Recovery</p>
            </div>
            <div style="padding: 32px;">
                <p style="margin: 0 0 16px 0; font-size: 14px; color: #cbd5e1;">
                    Hello <strong>${username || 'Admin'}</strong>,
                </p>
                <p style="margin: 0 0 24px 0; font-size: 13px; color: #94a3b8; line-height: 1.5;">
                    We received a request to reset the administrator password for your Antigravity WebUI console. Enter the following verification code to complete your password reset:
                </p>
                <div style="text-align: center; margin: 24px 0; background: #131927; border: 1px dashed #7c3aed; border-radius: 10px; padding: 20px;">
                    <div style="font-family: monospace; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #a78bfa;">
                        ${code}
                    </div>
                    <span style="display: block; font-size: 11px; color: #64748b; margin-top: 6px;">Valid for 15 minutes</span>
                </div>
                <p style="margin: 0 0 8px 0; font-size: 12px; color: #64748b;">
                    If you did not initiate this request, no action is needed. Your current password remains unchanged.
                </p>
            </div>
        </div>
        `
    };

    return transporter.sendMail(mailOptions);
}

/**
 * Parse cookies from Cookie header
 */
function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name?.trim();
        if (!name) return;
        const value = rest.join('=').trim();
        list[name] = decodeURIComponent(value);
    });
    return list;
}

/**
 * Extract auth token from request (Bearer, header, cookie, or query param)
 */
function extractToken(req) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7).trim();
    }
    if (req.headers['x-webui-token']) {
        return req.headers['x-webui-token'].trim();
    }
    const cookies = parseCookies(req.headers['cookie']);
    if (cookies['webui_token']) {
        return cookies['webui_token'];
    }
    return null;
}

/**
 * Check if request is authenticated
 */
function isRequestAuthenticated(req) {
    if (!config.webuiAuthEnabled) return true;
    const token = extractToken(req);
    if (token) {
        const session = validateSession(token);
        if (session) {
            req.webuiUser = session.username;
            return true;
        }
    }
    const legacyPass = req.headers['x-webui-password'];
    if (legacyPass && config.webuiPassword && legacyPass === config.webuiPassword) {
        req.webuiUser = config.webuiUsername || 'admin';
        return true;
    }
    return false;
}

/**
 * Auth Middleware - Protects WebUI when webuiAuthEnabled is true
 */
function createAuthMiddleware() {
    return (req, res, next) => {
        if (!config.webuiAuthEnabled) {
            return next();
        }

        // 1. Bypass AI proxy endpoints and API requests:
        // These are handled and authenticated by the proxy API Key middleware (Anthropic/OpenAI schemas),
        // not WebUI administrative credentials.
        const rawPath = req.path || (req.originalUrl ? req.originalUrl.split('?')[0] : '');
        const normalizedPath = (rawPath || '').replace(/\/+/g, '/').toLowerCase();
        const isAiProxyRoute =
            Boolean(req.apiKeyRecord) ||
            normalizedPath === '/v1' ||
            normalizedPath.startsWith('/v1/') ||
            normalizedPath === '/chat/completions' ||
            normalizedPath.startsWith('/chat/completions/') ||
            normalizedPath === '/models' ||
            normalizedPath.startsWith('/models/') ||
            normalizedPath === '/embeddings' ||
            normalizedPath.startsWith('/embeddings/') ||
            normalizedPath === '/health' ||
            normalizedPath === '/refresh-token' ||
            normalizedPath === '/api/event_logging/batch' ||
            normalizedPath === '/test/clear-signature-cache' ||
            normalizedPath.startsWith('/test/') ||
            (req.method === 'POST' && (normalizedPath === '' || normalizedPath === '/'));

        if (isAiProxyRoute) {
            return next();
        }

        // Public routes that never require authentication
        const isAuthStatus = req.path === '/api/auth/status';
        const isAuthLogin = req.path === '/api/auth/login';
        const isRecoveryStatus = req.path === '/api/auth/recovery-status';
        const isForgotPassword = req.path === '/api/auth/forgot-password';
        const isResetPassword = req.path === '/api/auth/reset-password';
        if (isAuthStatus || isAuthLogin || isRecoveryStatus || isForgotPassword || isResetPassword) {
            return next();
        }

        // Allow static assets required to render the login page and UI view templates
        if (req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/views/') || req.path.startsWith('/favicon.')) {
            return next();
        }

        // Allow index.html shell and app entry script so browser executes client JS and renders login view
        if (req.path === '/' || req.path === '/index.html' || req.path === '/app.js') {
            return next();
        }

        // Check authentication for all protected endpoints (views/*.html, /api/*, /account-limits, etc.)
        if (isRequestAuthenticated(req)) {
            return next();
        }

        return res.status(401).json({
            status: 'error',
            error: 'Unauthorized: Authentication required',
            authRequired: true
        });
    };
}

/**
 * Validate server config fields from user input.
 * Shared by POST /api/config and PATCH /api/server/presets/:name.
 * @param {Object} input - Raw config fields to validate
 * @returns {Object} Validated updates object (only valid fields included)
 */
function validateConfigFields(input) {
    const updates = {};
    const { maxRetries, retryBaseMs, retryMaxMs, defaultCooldownMs, maxWaitBeforeErrorMs, maxAccounts, globalQuotaThreshold, accountSelection, rateLimitDedupWindowMs, maxConsecutiveFailures, extendedCooldownMs, maxCapacityRetries, switchAccountDelayMs, capacityBackoffTiersMs } = input;

    if (typeof maxRetries === 'number' && maxRetries >= 1 && maxRetries <= 20) {
        updates.maxRetries = maxRetries;
    }
    if (typeof retryBaseMs === 'number' && retryBaseMs >= 100 && retryBaseMs <= 10000) {
        updates.retryBaseMs = retryBaseMs;
    }
    if (typeof retryMaxMs === 'number' && retryMaxMs >= 1000 && retryMaxMs <= 120000) {
        updates.retryMaxMs = retryMaxMs;
    }
    if (typeof defaultCooldownMs === 'number' && defaultCooldownMs >= 1000 && defaultCooldownMs <= 300000) {
        updates.defaultCooldownMs = defaultCooldownMs;
    }
    if (typeof maxWaitBeforeErrorMs === 'number' && maxWaitBeforeErrorMs >= 0 && maxWaitBeforeErrorMs <= 600000) {
        updates.maxWaitBeforeErrorMs = maxWaitBeforeErrorMs;
    }
    if (typeof maxAccounts === 'number' && maxAccounts >= 1 && maxAccounts <= 100) {
        updates.maxAccounts = maxAccounts;
    }
    if (typeof globalQuotaThreshold === 'number' && globalQuotaThreshold >= 0 && globalQuotaThreshold < 1) {
        updates.globalQuotaThreshold = globalQuotaThreshold;
    }
    if (typeof rateLimitDedupWindowMs === 'number' && rateLimitDedupWindowMs >= 1000 && rateLimitDedupWindowMs <= 30000) {
        updates.rateLimitDedupWindowMs = rateLimitDedupWindowMs;
    }
    if (typeof maxConsecutiveFailures === 'number' && maxConsecutiveFailures >= 1 && maxConsecutiveFailures <= 10) {
        updates.maxConsecutiveFailures = maxConsecutiveFailures;
    }
    if (typeof extendedCooldownMs === 'number' && extendedCooldownMs >= 10000 && extendedCooldownMs <= 300000) {
        updates.extendedCooldownMs = extendedCooldownMs;
    }
    if (typeof maxCapacityRetries === 'number' && maxCapacityRetries >= 1 && maxCapacityRetries <= 10) {
        updates.maxCapacityRetries = maxCapacityRetries;
    }
    if (typeof switchAccountDelayMs === 'number' && switchAccountDelayMs >= 1000 && switchAccountDelayMs <= 60000) {
        updates.switchAccountDelayMs = switchAccountDelayMs;
    }
    if (Array.isArray(capacityBackoffTiersMs) && capacityBackoffTiersMs.length >= 1 && capacityBackoffTiersMs.length <= 10) {
        const allValid = capacityBackoffTiersMs.every(v => typeof v === 'number' && v >= 1000 && v <= 300000);
        if (allValid) {
            updates.capacityBackoffTiersMs = [...capacityBackoffTiersMs];
        }
    }
    // Account selection strategy and tuning validation
    if (accountSelection && typeof accountSelection === 'object') {
        const validStrategies = ['sticky', 'round-robin', 'hybrid'];
        const acctUpdate = {};

        if (accountSelection.strategy && validStrategies.includes(accountSelection.strategy)) {
            acctUpdate.strategy = accountSelection.strategy;
        }

        // Health score tuning
        if (accountSelection.healthScore && typeof accountSelection.healthScore === 'object') {
            const hs = accountSelection.healthScore;
            const hsUpdate = {};
            if (typeof hs.initial === 'number' && hs.initial >= 0 && hs.initial <= 100) hsUpdate.initial = hs.initial;
            if (typeof hs.successReward === 'number' && hs.successReward >= 0 && hs.successReward <= 20) hsUpdate.successReward = hs.successReward;
            if (typeof hs.rateLimitPenalty === 'number' && hs.rateLimitPenalty >= -50 && hs.rateLimitPenalty <= 0) hsUpdate.rateLimitPenalty = hs.rateLimitPenalty;
            if (typeof hs.failurePenalty === 'number' && hs.failurePenalty >= -50 && hs.failurePenalty <= 0) hsUpdate.failurePenalty = hs.failurePenalty;
            if (typeof hs.recoveryPerHour === 'number' && hs.recoveryPerHour >= 0 && hs.recoveryPerHour <= 20) hsUpdate.recoveryPerHour = hs.recoveryPerHour;
            if (typeof hs.minUsable === 'number' && hs.minUsable >= 0 && hs.minUsable <= 100) hsUpdate.minUsable = hs.minUsable;
            if (typeof hs.maxScore === 'number' && hs.maxScore >= 1 && hs.maxScore <= 200) hsUpdate.maxScore = hs.maxScore;
            if (Object.keys(hsUpdate).length > 0) acctUpdate.healthScore = hsUpdate;
        }

        // Token bucket tuning
        if (accountSelection.tokenBucket && typeof accountSelection.tokenBucket === 'object') {
            const tb = accountSelection.tokenBucket;
            const tbUpdate = {};
            if (typeof tb.maxTokens === 'number' && tb.maxTokens >= 5 && tb.maxTokens <= 200) tbUpdate.maxTokens = tb.maxTokens;
            if (typeof tb.tokensPerMinute === 'number' && tb.tokensPerMinute >= 1 && tb.tokensPerMinute <= 60) tbUpdate.tokensPerMinute = tb.tokensPerMinute;
            if (typeof tb.initialTokens === 'number' && tb.initialTokens >= 1 && tb.initialTokens <= 200) tbUpdate.initialTokens = tb.initialTokens;
            if (Object.keys(tbUpdate).length > 0) acctUpdate.tokenBucket = tbUpdate;
        }

        // Quota tuning
        if (accountSelection.quota && typeof accountSelection.quota === 'object') {
            const q = accountSelection.quota;
            const qUpdate = {};
            if (typeof q.lowThreshold === 'number' && q.lowThreshold >= 0 && q.lowThreshold < 1) qUpdate.lowThreshold = q.lowThreshold;
            if (typeof q.criticalThreshold === 'number' && q.criticalThreshold >= 0 && q.criticalThreshold < 1) qUpdate.criticalThreshold = q.criticalThreshold;
            if (typeof q.staleMs === 'number' && q.staleMs >= 30000 && q.staleMs <= 3600000) qUpdate.staleMs = q.staleMs;
            if (Object.keys(qUpdate).length > 0) acctUpdate.quota = qUpdate;
        }

        // Weights tuning
        if (accountSelection.weights && typeof accountSelection.weights === 'object') {
            const w = accountSelection.weights;
            const wUpdate = {};
            if (typeof w.health === 'number' && w.health >= 0 && w.health <= 20) wUpdate.health = w.health;
            if (typeof w.tokens === 'number' && w.tokens >= 0 && w.tokens <= 20) wUpdate.tokens = w.tokens;
            if (typeof w.quota === 'number' && w.quota >= 0 && w.quota <= 20) wUpdate.quota = w.quota;
            if (typeof w.lru === 'number' && w.lru >= 0 && w.lru <= 5) wUpdate.lru = w.lru;
            if (Object.keys(wUpdate).length > 0) acctUpdate.weights = wUpdate;
        }

        if (Object.keys(acctUpdate).length > 0) {
            updates.accountSelection = acctUpdate;
        }
    }

    return updates;
}

/**
 * Mount WebUI routes and middleware on Express app
 * @param {Express} app - Express application instance
 * @param {string} dirname - __dirname of the calling module (for static file path)
 * @param {AccountManager} accountManager - Account manager instance
 */
export function mountWebUI(app, dirname, accountManager) {
    // Apply auth middleware
    app.use(createAuthMiddleware());

    // Serve static files from public directory
    app.use(express.static(path.join(dirname, '../public')));

    // ==========================================
    // WebUI Authentication API
    // ==========================================

    /**
     * GET /api/auth/status - Check authentication status and current session
     */
    app.get('/api/auth/status', (req, res) => {
        const authenticated = isRequestAuthenticated(req);
        res.json({
            status: 'ok',
            authEnabled: Boolean(config.webuiAuthEnabled),
            authenticated: !config.webuiAuthEnabled || authenticated,
            username: authenticated ? (req.webuiUser || config.webuiUsername || 'admin') : null,
            email: config.webuiEmail || ''
        });
    });

    /**
     * POST /api/auth/login - Log in with username/email and password
     */
    app.post('/api/auth/login', (req, res) => {
        try {
            const { username, password, rememberMe } = req.body || {};

            if (!config.webuiAuthEnabled) {
                return res.json({
                    status: 'ok',
                    message: 'Authentication is not enabled',
                    authenticated: true,
                    authEnabled: false
                });
            }

            loadConfig();
            const expectedUsername = (config.webuiUsername || 'admin').toLowerCase();
            const expectedEmail = (config.webuiEmail || '').toLowerCase();
            const inputIdentifier = (username || '').trim().toLowerCase();
            const expectedPassword = config.webuiPassword || '';

            if (!inputIdentifier || !password) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Username/email and password are required'
                });
            }

            const isIdentifierMatch = inputIdentifier === expectedUsername || (expectedEmail && inputIdentifier === expectedEmail);
            if (!isIdentifierMatch || password !== expectedPassword) {
                return res.status(401).json({
                    status: 'error',
                    error: 'Invalid username/email or password'
                });
            }

            // Create session
            const isRemember = Boolean(rememberMe);
            const { token, expiresAt } = createSession(config.webuiUsername || 'admin', isRemember);

            // Set cookie: with Max-Age for rememberMe (saved login across browser restarts), or session cookie if unchecked
            if (isRemember) {
                const maxAge = Math.floor((expiresAt - Date.now()) / 1000);
                res.setHeader('Set-Cookie', `webui_token=${token}; Path=/; SameSite=Lax; Max-Age=${maxAge}; HttpOnly`);
            } else {
                res.setHeader('Set-Cookie', `webui_token=${token}; Path=/; SameSite=Lax; HttpOnly`);
            }

            logger.info(`[WebUI] User ${config.webuiUsername || 'admin'} logged in (rememberMe: ${isRemember})`);

            res.json({
                status: 'ok',
                token,
                username: config.webuiUsername || 'admin',
                rememberMe: isRemember,
                expiresAt
            });
        } catch (error) {
            logger.error('[WebUI] Login error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/auth/logout - Log out current session
     */
    app.post('/api/auth/logout', (req, res) => {
        try {
            const token = extractToken(req);
            if (token) {
                invalidateSession(token);
            }
            res.setHeader('Set-Cookie', 'webui_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
            res.json({ status: 'ok', message: 'Logged out successfully' });
        } catch (error) {
            logger.error('[WebUI] Logout error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/auth/config - Update WebUI auth settings (enable/disable, username, password)
     */
    app.post('/api/auth/config', (req, res) => {
        try {
            const { enabled, username, email, currentPassword, newPassword } = req.body || {};

            // If auth is already enabled, caller MUST be authenticated
            if (config.webuiAuthEnabled && !isRequestAuthenticated(req)) {
                return res.status(401).json({
                    status: 'error',
                    error: 'Unauthorized: Authentication required to modify auth settings'
                });
            }

            const updates = {};

            // 1. Password verification & update
            if (newPassword !== undefined && newPassword !== null && newPassword !== '') {
                if (typeof newPassword !== 'string' || newPassword.length < 4) {
                    return res.status(400).json({
                        status: 'error',
                        error: 'Password must be at least 4 characters long'
                    });
                }

                // If current password is set, verify currentPassword matches
                if (config.webuiPassword && config.webuiPassword !== currentPassword) {
                    return res.status(403).json({
                        status: 'error',
                        error: 'Current password does not match'
                    });
                }

                updates.webuiPassword = newPassword;
            }

            // 2. Enable/disable check
            if (enabled === true) {
                const effectivePassword = updates.webuiPassword || config.webuiPassword;
                if (!effectivePassword) {
                    return res.status(400).json({
                        status: 'error',
                        error: 'A password is required before enabling authentication. Please set a password first.'
                    });
                }
                updates.webuiAuthEnabled = true;
            } else if (enabled === false) {
                updates.webuiAuthEnabled = false;
            }

            // 3. Username update
            if (typeof username === 'string') {
                const trimmed = username.trim();
                if (!trimmed) {
                    return res.status(400).json({
                        status: 'error',
                        error: 'Username cannot be empty'
                    });
                }
                updates.webuiUsername = trimmed;
            }

            // 4. Email update (optional)
            if (email !== undefined && email !== null) {
                const trimmedEmail = typeof email === 'string' ? email.trim() : '';
                if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
                    return res.status(400).json({
                        status: 'error',
                        error: 'Please enter a valid email address'
                    });
                }
                updates.webuiEmail = trimmedEmail;
            }

            // 5. Recovery mode update (optional)
            if (req.body.recoveryMode && typeof req.body.recoveryMode === 'object') {
                updates.webuiRecoveryMode = {
                    cliEnabled: req.body.recoveryMode.cliEnabled !== false,
                    emailEnabled: req.body.recoveryMode.emailEnabled !== false
                };
            }

            // Save updates to config.json
            const success = saveConfig(updates);
            if (!success) {
                throw new Error('Failed to save configuration to disk');
            }

            // Update in-memory config
            Object.assign(config, updates);

            // If auth is now enabled, create a session for the user so they stay logged in
            let sessionToken = null;
            if (config.webuiAuthEnabled) {
                const { token, expiresAt } = createSession(config.webuiUsername || 'admin', true);
                sessionToken = token;
                const maxAge = Math.floor((expiresAt - Date.now()) / 1000);
                res.setHeader('Set-Cookie', `webui_token=${token}; Path=/; SameSite=Lax; Max-Age=${maxAge}; HttpOnly`);
            }

            logger.info(`[WebUI] Auth config updated: enabled=${config.webuiAuthEnabled}, username=${config.webuiUsername}, email=${config.webuiEmail || '(none)'}`);

            res.json({
                status: 'ok',
                message: 'Authentication settings updated successfully',
                config: {
                    webuiAuthEnabled: config.webuiAuthEnabled,
                    webuiUsername: config.webuiUsername,
                    webuiEmail: config.webuiEmail || '',
                    webuiRecoveryMode: config.webuiRecoveryMode || { cliEnabled: true, emailEnabled: true }
                },
                token: sessionToken
            });
        } catch (error) {
            logger.error('[WebUI] Error updating auth config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/auth/recovery-status - Check available recovery modes & status
     */
    app.get('/api/auth/recovery-status', (req, res) => {
        try {
            loadConfig();
            const recoveryMode = config.webuiRecoveryMode || { cliEnabled: true, emailEnabled: true };
            const hasEmail = Boolean(config.webuiEmail);
            const hasSmtp = Boolean(config.smtp?.enabled && config.smtp?.host);

            res.json({
                status: 'ok',
                cliEnabled: recoveryMode.cliEnabled !== false,
                emailEnabled: recoveryMode.emailEnabled !== false,
                hasEmail,
                hasSmtp,
                emailMasked: config.webuiEmail ? maskEmail(config.webuiEmail) : '',
                emailReady: Boolean(recoveryMode.emailEnabled !== false && hasEmail && hasSmtp)
            });
        } catch (error) {
            logger.error('[WebUI] Error getting recovery status:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/auth/forgot-password - Request 6-digit recovery code via email
     */
    app.post('/api/auth/forgot-password', async (req, res) => {
        try {
            const recoveryMode = config.webuiRecoveryMode || { cliEnabled: true, emailEnabled: true };
            if (recoveryMode.emailEnabled === false) {
                return res.status(403).json({
                    status: 'error',
                    error: 'Email password recovery is disabled on this server. Please use CLI command recovery.'
                });
            }

            if (!config.smtp?.enabled || !config.smtp?.host) {
                return res.status(400).json({
                    status: 'error',
                    error: 'SMTP email server is not configured or disabled. Please use CLI command recovery or configure SMTP in Settings.'
                });
            }

            if (!config.webuiEmail) {
                return res.status(400).json({
                    status: 'error',
                    error: 'No administrator email ID is configured. Please use CLI command recovery.'
                });
            }

            const { identifier } = req.body || {};
            if (!identifier || typeof identifier !== 'string') {
                return res.status(400).json({
                    status: 'error',
                    error: 'Please provide your admin username or email address.'
                });
            }

            const cleanId = identifier.trim().toLowerCase();
            const expectedUser = (config.webuiUsername || 'admin').toLowerCase();
            const expectedEmail = (config.webuiEmail || '').toLowerCase();

            if (cleanId !== expectedUser && cleanId !== expectedEmail) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Provided username or email does not match administrative records.'
                });
            }

            // Generate secure 6-digit code
            const code = crypto.randomInt(100000, 999999).toString();
            const expiresAt = Date.now() + RESET_CODE_EXPIRY_MS;

            // Store in pending resets
            pendingPasswordResets.set(code, {
                code,
                expiresAt,
                attempts: 0,
                username: config.webuiUsername || 'admin'
            });

            // Send recovery email via SMTP
            try {
                await sendRecoveryCodeEmail(config.webuiEmail, code, config.webuiUsername || 'admin');
                logger.info(`[WebUI] Password recovery code sent to ${config.webuiEmail}`);
                res.json({
                    status: 'ok',
                    message: `A 6-digit recovery code has been sent to ${maskEmail(config.webuiEmail)}.`,
                    emailMasked: maskEmail(config.webuiEmail)
                });
            } catch (mailErr) {
                logger.error('[WebUI] Failed to send recovery email:', mailErr);
                pendingPasswordResets.delete(code);
                res.status(500).json({
                    status: 'error',
                    error: `Failed to send recovery email: ${mailErr.message || 'SMTP error'}. Please check your SMTP settings or use CLI recovery.`
                });
            }
        } catch (error) {
            logger.error('[WebUI] Error in forgot-password endpoint:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/auth/reset-password - Verify recovery code and set new password
     */
    app.post('/api/auth/reset-password', (req, res) => {
        try {
            const { code, newPassword } = req.body || {};

            if (!code || typeof code !== 'string') {
                return res.status(400).json({
                    status: 'error',
                    error: 'Recovery code is required'
                });
            }

            const cleanCode = code.trim();
            const resetRecord = pendingPasswordResets.get(cleanCode);

            if (!resetRecord) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Invalid recovery code. Please double-check the code or request a new one.'
                });
            }

            if (Date.now() > resetRecord.expiresAt) {
                pendingPasswordResets.delete(cleanCode);
                return res.status(400).json({
                    status: 'error',
                    error: 'Recovery code has expired. Please request a new code.'
                });
            }

            if (resetRecord.attempts >= 5) {
                pendingPasswordResets.delete(cleanCode);
                return res.status(400).json({
                    status: 'error',
                    error: 'Too many incorrect attempts. Please request a new recovery code.'
                });
            }

            if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 4) {
                resetRecord.attempts++;
                return res.status(400).json({
                    status: 'error',
                    error: 'New password must be at least 4 characters long'
                });
            }

            // Valid! Update password
            pendingPasswordResets.delete(cleanCode);
            const success = saveConfig({ webuiPassword: newPassword });
            if (!success) {
                return res.status(500).json({
                    status: 'error',
                    error: 'Failed to save updated password to disk'
                });
            }

            config.webuiPassword = newPassword;
            logger.info('[WebUI] Admin password successfully reset via email recovery code');

            res.json({
                status: 'ok',
                message: 'Password has been reset successfully. You can now log in with your new password.'
            });
        } catch (error) {
            logger.error('[WebUI] Error in reset-password endpoint:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // SMTP Configuration & Testing API
    // ==========================================

    /**
     * GET /api/smtp/config - Get current SMTP configuration
     */
    app.get('/api/smtp/config', (req, res) => {
        try {
            if (config.webuiAuthEnabled && !isRequestAuthenticated(req)) {
                return res.status(401).json({
                    status: 'error',
                    error: 'Unauthorized: Authentication required'
                });
            }

            const smtp = config.smtp || {};
            res.json({
                status: 'ok',
                config: {
                    enabled: Boolean(smtp.enabled),
                    host: smtp.host || '',
                    port: smtp.port || 587,
                    secure: Boolean(smtp.secure),
                    user: smtp.user || '',
                    pass: smtp.pass ? '********' : '',
                    hasPassword: Boolean(smtp.pass),
                    fromEmail: smtp.fromEmail || '',
                    fromName: smtp.fromName || 'Antigravity Proxy'
                }
            });
        } catch (error) {
            logger.error('[WebUI] Error getting SMTP config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/smtp/config - Update SMTP configuration
     */
    app.post('/api/smtp/config', (req, res) => {
        try {
            if (config.webuiAuthEnabled && !isRequestAuthenticated(req)) {
                return res.status(401).json({
                    status: 'error',
                    error: 'Unauthorized: Authentication required'
                });
            }

            const { enabled, host, port, secure, user, pass, fromEmail, fromName } = req.body || {};

            const updates = { ...(config.smtp || {}) };

            if (typeof enabled === 'boolean') {
                updates.enabled = enabled;
            }

            if (typeof host === 'string') {
                updates.host = host.trim();
            }

            if (port !== undefined && port !== null) {
                const parsedPort = parseInt(port, 10);
                if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
                    return res.status(400).json({
                        status: 'error',
                        error: 'Port must be a valid number between 1 and 65535'
                    });
                }
                updates.port = parsedPort;
            }

            if (typeof secure === 'boolean') {
                updates.secure = secure;
            }

            if (typeof user === 'string') {
                updates.user = user.trim();
            }

            if (pass !== undefined && pass !== null) {
                if (pass === '__CLEAR__') {
                    updates.pass = '';
                } else if (pass !== '') {
                    updates.pass = pass;
                }
            }

            if (typeof fromEmail === 'string') {
                const trimmedFrom = fromEmail.trim();
                if (trimmedFrom && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedFrom)) {
                    return res.status(400).json({
                        status: 'error',
                        error: 'Sender email must be a valid email address'
                    });
                }
                updates.fromEmail = trimmedFrom;
            }

            if (typeof fromName === 'string') {
                updates.fromName = fromName.trim();
            }

            const success = saveConfig({ smtp: updates });
            if (!success) {
                return res.status(500).json({
                    status: 'error',
                    error: 'Failed to save SMTP configuration to file'
                });
            }

            logger.info(`[WebUI] SMTP config updated: enabled=${updates.enabled}, host=${updates.host}:${updates.port}`);

            res.json({
                status: 'ok',
                message: 'SMTP configuration saved successfully',
                config: {
                    enabled: updates.enabled,
                    host: updates.host,
                    port: updates.port,
                    secure: updates.secure,
                    user: updates.user,
                    pass: updates.pass ? '********' : '',
                    hasPassword: Boolean(updates.pass),
                    fromEmail: updates.fromEmail,
                    fromName: updates.fromName
                }
            });
        } catch (error) {
            logger.error('[WebUI] Error updating SMTP config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/smtp/test - Test connection or send test email
     */
    app.post('/api/smtp/test', async (req, res) => {
        try {
            if (config.webuiAuthEnabled && !isRequestAuthenticated(req)) {
                return res.status(401).json({
                    status: 'error',
                    error: 'Unauthorized: Authentication required'
                });
            }

            const { recipient, host, port, secure, user, pass, fromEmail, fromName, action } = req.body || {};

            const testConfig = {
                host: host !== undefined ? host : (config.smtp?.host || ''),
                port: port !== undefined ? port : (config.smtp?.port || 587),
                secure: secure !== undefined ? secure : Boolean(config.smtp?.secure),
                user: user !== undefined ? user : (config.smtp?.user || ''),
                pass: pass ? pass : (config.smtp?.pass || ''),
                fromEmail: fromEmail !== undefined ? fromEmail : (config.smtp?.fromEmail || ''),
                fromName: fromName !== undefined ? fromName : (config.smtp?.fromName || 'Antigravity Proxy')
            };

            if (!testConfig.host) {
                return res.status(400).json({
                    status: 'error',
                    error: 'SMTP host is required'
                });
            }

            if (action === 'verify' || !recipient) {
                const result = await verifySmtpConnection(testConfig);
                if (result.success) {
                    return res.json({ status: 'ok', message: result.message });
                } else {
                    return res.status(400).json({ status: 'error', error: result.error, code: result.code });
                }
            } else {
                const result = await sendTestEmail(testConfig, recipient);
                if (result.success) {
                    return res.json({ status: 'ok', message: result.message, messageId: result.messageId });
                } else {
                    return res.status(400).json({ status: 'error', error: result.error, code: result.code });
                }
            }
        } catch (error) {
            logger.error('[WebUI] Error in SMTP test endpoint:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Account Management API
    // ==========================================

    /**
     * GET /api/accounts - List all accounts with status
     */
    app.get('/api/accounts', async (req, res) => {
        try {
            const status = accountManager.getStatus();
            res.json({
                status: 'ok',
                accounts: status.accounts,
                summary: {
                    total: status.total,
                    available: status.available,
                    rateLimited: status.rateLimited,
                    invalid: status.invalid
                }
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/:email/refresh - Refresh specific account token
     */
    app.post('/api/accounts/:email/refresh', async (req, res) => {
        try {
            const { email } = req.params;
            accountManager.clearTokenCache(email);
            accountManager.clearProjectCache(email);

            // For verification errors (403 VALIDATION_REQUIRED), clear isInvalid on refresh.
            // The user has completed verification on Google's site and clicks Refresh to re-enable.
            // Auth errors (no verifyUrl) still require OAuth re-auth via FIX button.
            const account = accountManager.getAllAccounts().find(a => a.email === email);
            if (account && account.isInvalid && account.verifyUrl) {
                accountManager.clearInvalid(email);
            }

            res.json({
                status: 'ok',
                message: `Token cache cleared for ${email}`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/:email/toggle - Enable/disable account
     */
    app.post('/api/accounts/:email/toggle', async (req, res) => {
        try {
            const { email } = req.params;
            const { enabled } = req.body;

            if (typeof enabled !== 'boolean') {
                return res.status(400).json({ status: 'error', error: 'enabled must be a boolean' });
            }

            await setAccountEnabled(email, enabled);

            // Reload AccountManager to pick up changes
            await accountManager.reload();

            res.json({
                status: 'ok',
                message: `Account ${email} ${enabled ? 'enabled' : 'disabled'}`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/accounts/:email - Remove account
     */
    app.delete('/api/accounts/:email', async (req, res) => {
        try {
            const { email } = req.params;
            await removeAccount(email);

            // Reload AccountManager to pick up changes
            await accountManager.reload();

            res.json({
                status: 'ok',
                message: `Account ${email} removed`
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/providers/fetch-models - Fetch available models from upstream API
     */
    app.post('/api/providers/fetch-models', async (req, res) => {
        try {
            const { type, baseUrl, apiKey } = req.body || {};
            const models = await fetchProviderModels({ type, baseUrl, apiKey });
            res.json({ status: 'ok', models });
        } catch (error) {
            logger.error('[WebUI] Fetch provider models error:', error.message);
            res.status(400).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/providers/custom - Add or update a custom provider
     */
    app.post('/api/providers/custom', async (req, res) => {
        try {
            const {
                name,
                type,
                baseUrl,
                apiKey,
                models,
                quotaType,
                initialBalance,
                initialTokens,
                pricing
            } = req.body || {};

            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ status: 'error', error: 'Provider name is required' });
            }
            if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
                return res.status(400).json({ status: 'error', error: 'Base URL is required' });
            }

            const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
            const email = `${cleanName} (${type === 'anthropic' ? 'Anthropic' : 'OpenAI'})`;

            const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);

            const existingIdx = accounts.findIndex(a =>
                (a.source === 'custom' && a.name === cleanName) || a.email === email
            );

            const initialBal = Number(initialBalance) || 0;
            const initialTok = Number(initialTokens) || 0;

            const providerRecord = {
                name: cleanName,
                email: email,
                source: 'custom',
                type: type === 'anthropic' ? 'anthropic' : 'openai',
                enabled: true,
                baseUrl: baseUrl.trim(),
                apiKey: (apiKey || '').trim(),
                models: Array.isArray(models) ? models.filter(Boolean) : [],
                quotaType: quotaType || 'dollar',
                initialBalance: initialBal,
                currentBalance: initialBal,
                initialTokens: initialTok,
                currentTokens: initialTok,
                pricing: {
                    inputPricePerM: Number(pricing?.inputPricePerM) || 0,
                    outputPricePerM: Number(pricing?.outputPricePerM) || 0,
                    cachePricePerM: Number(pricing?.cachePricePerM) || 0
                },
                usage: {
                    totalRequests: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheTokens: 0,
                    totalCost: 0
                },
                addedAt: new Date().toISOString()
            };

            if (existingIdx !== -1) {
                accounts[existingIdx] = {
                    ...accounts[existingIdx],
                    ...providerRecord,
                    usage: accounts[existingIdx].usage || providerRecord.usage
                };
            } else {
                accounts.push(providerRecord);
            }

            await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);
            await accountManager.reload();

            logger.info(`[WebUI] Custom provider '${cleanName}' saved with ${providerRecord.models.length} model(s)`);
            res.json({ status: 'ok', message: 'Provider saved successfully', provider: providerRecord });
        } catch (error) {
            logger.error('[WebUI] Add custom provider error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * PATCH /api/providers/custom/:name - Update custom provider configuration (top-up, pricing, models)
     */
    app.patch('/api/providers/custom/:name', async (req, res) => {
        try {
            const { name } = req.params;
            const { topUpBalance, initialBalance, initialTokens, resetTokens, pricing, models, apiKey, baseUrl } = req.body || {};

            const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
            const provider = accounts.find(a => a.source === 'custom' && (a.name === name || a.email === name));

            if (!provider) {
                return res.status(404).json({ status: 'error', error: `Custom provider '${name}' not found` });
            }

            if (typeof topUpBalance === 'number' && topUpBalance > 0) {
                provider.currentBalance = Math.round(((provider.currentBalance || 0) + topUpBalance) * 100000) / 100000;
                provider.initialBalance = Math.round(((provider.initialBalance || 0) + topUpBalance) * 100000) / 100000;
            } else if (typeof initialBalance === 'number') {
                provider.initialBalance = initialBalance;
                provider.currentBalance = initialBalance;
            }

            if (resetTokens && provider.initialTokens) {
                provider.currentTokens = provider.initialTokens;
            } else if (typeof initialTokens === 'number') {
                provider.initialTokens = initialTokens;
                provider.currentTokens = initialTokens;
            }

            if (pricing && typeof pricing === 'object') {
                provider.pricing = {
                    inputPricePerM: Number(pricing.inputPricePerM) || 0,
                    outputPricePerM: Number(pricing.outputPricePerM) || 0,
                    cachePricePerM: Number(pricing.cachePricePerM) || 0
                };
            }

            if (Array.isArray(models)) {
                provider.models = models.filter(Boolean);
            }

            if (typeof apiKey === 'string' && apiKey.trim()) {
                provider.apiKey = apiKey.trim();
            }

            if (typeof baseUrl === 'string' && baseUrl.trim()) {
                provider.baseUrl = baseUrl.trim();
            }

            await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);
            await accountManager.reload();

            logger.info(`[WebUI] Custom provider '${name}' updated`);
            res.json({ status: 'ok', message: 'Provider updated successfully', provider });
        } catch (error) {
            logger.error('[WebUI] Update custom provider error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * PATCH /api/accounts/:email - Update account settings (thresholds)
     */
    app.patch('/api/accounts/:email', async (req, res) => {
        try {
            const { email } = req.params;
            const { quotaThreshold, modelQuotaThresholds } = req.body;

            const { accounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);
            const account = accounts.find(a => a.email === email);

            if (!account) {
                return res.status(404).json({ status: 'error', error: `Account ${email} not found` });
            }

            // Validate and update quotaThreshold (0-0.99 or null/undefined to clear)
            if (quotaThreshold !== undefined) {
                if (quotaThreshold === null) {
                    delete account.quotaThreshold;
                } else if (typeof quotaThreshold === 'number' && quotaThreshold >= 0 && quotaThreshold < 1) {
                    account.quotaThreshold = quotaThreshold;
                } else {
                    return res.status(400).json({ status: 'error', error: 'quotaThreshold must be 0-0.99 or null' });
                }
            }

            // Validate and update modelQuotaThresholds (full replacement, not merge)
            if (modelQuotaThresholds !== undefined) {
                if (modelQuotaThresholds === null || (typeof modelQuotaThresholds === 'object' && Object.keys(modelQuotaThresholds).length === 0)) {
                    // Clear all model thresholds
                    delete account.modelQuotaThresholds;
                } else if (typeof modelQuotaThresholds === 'object') {
                    // Validate all thresholds first
                    for (const [modelId, threshold] of Object.entries(modelQuotaThresholds)) {
                        if (typeof threshold !== 'number' || threshold < 0 || threshold >= 1) {
                            return res.status(400).json({
                                status: 'error',
                                error: `Invalid threshold for model ${modelId}: must be 0-0.99`
                            });
                        }
                    }
                    // Replace entire object (not merge)
                    account.modelQuotaThresholds = { ...modelQuotaThresholds };
                } else {
                    return res.status(400).json({ status: 'error', error: 'modelQuotaThresholds must be an object or null' });
                }
            }

            await saveAccounts(ACCOUNT_CONFIG_PATH, accounts, settings, activeIndex);

            // Reload AccountManager to pick up changes
            await accountManager.reload();

            logger.info(`[WebUI] Account ${email} thresholds updated`);

            res.json({
                status: 'ok',
                message: `Account ${email} thresholds updated`,
                account: {
                    email: account.email,
                    quotaThreshold: account.quotaThreshold,
                    modelQuotaThresholds: account.modelQuotaThresholds || {}
                }
            });
        } catch (error) {
            logger.error('[WebUI] Error updating account thresholds:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/reload - Reload accounts from disk
     */
    app.post('/api/accounts/reload', async (req, res) => {
        try {
            // Reload AccountManager from disk
            await accountManager.reload();

            const status = accountManager.getStatus();
            res.json({
                status: 'ok',
                message: 'Accounts reloaded from disk',
                summary: status.summary
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/accounts/export - Export accounts (both native Google and Custom providers)
     */
    app.get('/api/accounts/export', async (req, res) => {
        try {
            const { accounts } = await loadAccounts(ACCOUNT_CONFIG_PATH);

            // Export accounts with essential credentials and custom provider configurations
            const exportData = accounts
                .filter(acc => acc.source !== 'database')
                .map(acc => {
                    if (acc.source === 'custom') {
                        return {
                            name: acc.name,
                            email: acc.email,
                            source: 'custom',
                            type: acc.type || 'openai',
                            enabled: acc.enabled !== false,
                            baseUrl: acc.baseUrl || '',
                            base_url: acc.baseUrl || '',
                            apiKey: acc.apiKey || '',
                            api_key: acc.apiKey || '',
                            models: Array.isArray(acc.models) ? acc.models : [],
                            quotaType: acc.quotaType || 'dollar',
                            quota_type: acc.quotaType || 'dollar',
                            initialBalance: Number(acc.initialBalance) || 0,
                            initial_balance: Number(acc.initialBalance) || 0,
                            currentBalance: acc.currentBalance !== undefined ? Number(acc.currentBalance) : (Number(acc.initialBalance) || 0),
                            current_balance: acc.currentBalance !== undefined ? Number(acc.currentBalance) : (Number(acc.initialBalance) || 0),
                            initialTokens: Number(acc.initialTokens) || 0,
                            initial_tokens: Number(acc.initialTokens) || 0,
                            currentTokens: acc.currentTokens !== undefined ? Number(acc.currentTokens) : (Number(acc.initialTokens) || 0),
                            current_tokens: acc.currentTokens !== undefined ? Number(acc.currentTokens) : (Number(acc.initialTokens) || 0),
                            pricing: acc.pricing || { inputPricePerM: 0, outputPricePerM: 0, cachePricePerM: 0 },
                            usage: acc.usage || { totalRequests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalCost: 0 },
                            addedAt: acc.addedAt || undefined,
                            added_at: acc.addedAt || undefined,
                            lastUsed: acc.lastUsed || undefined,
                            last_used: acc.lastUsed || undefined
                        };
                    }

                    const essential = {
                        email: acc.email,
                        source: acc.source || 'oauth'
                    };
                    // Use snake_case for compatibility
                    if (acc.refreshToken) {
                        essential.refresh_token = acc.refreshToken;
                    }
                    if (acc.apiKey) {
                        essential.api_key = acc.apiKey;
                    }
                    return essential;
                });

            // Return plain array for simpler format
            res.json(exportData);
        } catch (error) {
            logger.error('[WebUI] Export accounts error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/accounts/import - Batch import accounts (supports Google OAuth, Manual, and Custom Providers)
     */
    app.post('/api/accounts/import', async (req, res) => {
        try {
            // Support both wrapped format { accounts: [...] } and plain array [...]
            let importAccounts = req.body;
            if (req.body.accounts && Array.isArray(req.body.accounts)) {
                importAccounts = req.body.accounts;
            }

            if (!Array.isArray(importAccounts) || importAccounts.length === 0) {
                return res.status(400).json({
                    status: 'error',
                    error: 'accounts must be a non-empty array'
                });
            }

            const results = { added: [], updated: [], failed: [] };

            // Load existing accounts once before the loop
            const { accounts: currentAccounts, settings, activeIndex } = await loadAccounts(ACCOUNT_CONFIG_PATH);

            for (const acc of importAccounts) {
                try {
                    // Check if account is a custom provider
                    const isCustom = acc.source === 'custom' ||
                        Boolean(acc.baseUrl || acc.base_url) ||
                        acc.type === 'openai' || acc.type === 'anthropic' ||
                        (acc.email && /\((OpenAI|Anthropic)\)$/i.test(acc.email)) ||
                        Boolean(acc.name && (acc.models || acc.pricing || acc.quotaType || acc.quota_type));

                    if (isCustom) {
                        const type = acc.type === 'anthropic' || (acc.email && /\(Anthropic\)$/i.test(acc.email))
                            ? 'anthropic'
                            : 'openai';

                        let cleanName = acc.name;
                        if (!cleanName && acc.email) {
                            cleanName = acc.email.replace(/\s*\((OpenAI|Anthropic)\)$/i, '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
                        }
                        if (!cleanName) cleanName = 'custom-provider';

                        const email = acc.email || `${cleanName} (${type === 'anthropic' ? 'Anthropic' : 'OpenAI'})`;
                        const apiKey = (acc.apiKey || acc.api_key || '').trim();
                        let baseUrl = (acc.baseUrl || acc.base_url || '').trim();

                        // Find existing account by name or email
                        const existingIdx = currentAccounts.findIndex(a =>
                            (a.source === 'custom' && a.name === cleanName) || a.email === email
                        );

                        // If baseUrl is missing (e.g. from an old stripped export), fallback to existing if available
                        if (!baseUrl && existingIdx !== -1 && currentAccounts[existingIdx].baseUrl) {
                            baseUrl = currentAccounts[existingIdx].baseUrl;
                        }

                        const initialBal = Number(acc.initialBalance ?? acc.initial_balance) || 0;
                        const currentBal = acc.currentBalance !== undefined ? Number(acc.currentBalance)
                            : (acc.current_balance !== undefined ? Number(acc.current_balance) : initialBal);
                        const initialTok = Number(acc.initialTokens ?? acc.initial_tokens) || 0;
                        const currentTok = acc.currentTokens !== undefined ? Number(acc.currentTokens)
                            : (acc.current_tokens !== undefined ? Number(acc.current_tokens) : initialTok);

                        const providerRecord = {
                            name: cleanName,
                            email: email,
                            source: 'custom',
                            type: type,
                            enabled: acc.enabled !== false,
                            baseUrl: baseUrl,
                            apiKey: apiKey,
                            models: Array.isArray(acc.models) ? acc.models.filter(Boolean) : (existingIdx !== -1 && Array.isArray(currentAccounts[existingIdx].models) ? currentAccounts[existingIdx].models : []),
                            quotaType: acc.quotaType || acc.quota_type || (existingIdx !== -1 ? currentAccounts[existingIdx].quotaType : 'dollar'),
                            initialBalance: initialBal || (existingIdx !== -1 ? currentAccounts[existingIdx].initialBalance : 0),
                            currentBalance: currentBal || (existingIdx !== -1 ? currentAccounts[existingIdx].currentBalance : 0),
                            initialTokens: initialTok || (existingIdx !== -1 ? currentAccounts[existingIdx].initialTokens : 0),
                            currentTokens: currentTok || (existingIdx !== -1 ? currentAccounts[existingIdx].currentTokens : 0),
                            pricing: acc.pricing || (existingIdx !== -1 ? currentAccounts[existingIdx].pricing : {
                                inputPricePerM: 0,
                                outputPricePerM: 0,
                                cachePricePerM: 0
                            }),
                            usage: acc.usage || (existingIdx !== -1 ? currentAccounts[existingIdx].usage : {
                                totalRequests: 0,
                                inputTokens: 0,
                                outputTokens: 0,
                                cacheTokens: 0,
                                totalCost: 0
                            }),
                            addedAt: acc.addedAt || acc.added_at || (existingIdx !== -1 ? currentAccounts[existingIdx].addedAt : new Date().toISOString()),
                            lastUsed: acc.lastUsed || acc.last_used || (existingIdx !== -1 ? currentAccounts[existingIdx].lastUsed : null)
                        };

                        if (existingIdx !== -1) {
                            currentAccounts[existingIdx] = {
                                ...currentAccounts[existingIdx],
                                ...providerRecord
                            };
                            results.updated.push(email);
                        } else {
                            currentAccounts.push(providerRecord);
                            results.added.push(email);
                        }
                        continue;
                    }

                    // Standard Google OAuth / Manual account
                    if (!acc.email) {
                        results.failed.push({ email: acc.email || 'unknown', reason: 'Missing email' });
                        continue;
                    }

                    // Support both snake_case and camelCase
                    const refreshToken = acc.refresh_token || acc.refreshToken;
                    const apiKey = acc.api_key || acc.apiKey;

                    // Must have at least one credential
                    if (!refreshToken && !apiKey) {
                        results.failed.push({ email: acc.email, reason: 'Missing refresh_token or api_key' });
                        continue;
                    }

                    const existingIdx = currentAccounts.findIndex(a => a.email === acc.email);
                    const isManual = Boolean(apiKey && !refreshToken);

                    const accountData = {
                        email: acc.email,
                        source: isManual ? 'manual' : 'oauth',
                        refreshToken: refreshToken || null,
                        apiKey: apiKey || null,
                        enabled: true,
                        isInvalid: false,
                        invalidReason: null,
                        modelRateLimits: {},
                        lastUsed: null,
                        addedAt: new Date().toISOString()
                    };

                    if (existingIdx !== -1) {
                        currentAccounts[existingIdx] = {
                            ...currentAccounts[existingIdx],
                            ...accountData,
                            addedAt: currentAccounts[existingIdx].addedAt || accountData.addedAt
                        };
                        results.updated.push(acc.email);
                    } else {
                        // Check MAX_ACCOUNTS limit
                        if (currentAccounts.length >= MAX_ACCOUNTS) {
                            results.failed.push({ email: acc.email, reason: `Maximum of ${MAX_ACCOUNTS} accounts reached` });
                            continue;
                        }
                        currentAccounts.push(accountData);
                        results.added.push(acc.email);
                    }
                } catch (err) {
                    results.failed.push({ email: acc.email, reason: err.message });
                }
            }

            // Save accounts and reload AccountManager
            await saveAccounts(ACCOUNT_CONFIG_PATH, currentAccounts, settings, activeIndex);
            await accountManager.reload();

            logger.info(`[WebUI] Import complete: ${results.added.length} added, ${results.updated.length} updated, ${results.failed.length} failed`);

            res.json({
                status: 'ok',
                results,
                message: `Imported ${results.added.length + results.updated.length} accounts`
            });
        } catch (error) {
            logger.error('[WebUI] Import accounts error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Configuration API
    // ==========================================

    /**
     * GET /api/config - Get server configuration
     */
    app.get('/api/config', (req, res) => {
        try {
            const publicConfig = getPublicConfig();
            res.json({
                status: 'ok',
                config: publicConfig,
                version: packageVersion,
                note: 'Edit ~/.config/gravityroute/config.json or use env vars to change these values'
            });
        } catch (error) {
            logger.error('[WebUI] Error getting config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/config - Update server configuration
     */
    app.post('/api/config', async (req, res) => {
        try {
            const { debug, devMode, logLevel, persistTokenCache, requestThrottlingEnabled, requestDelayMs } = req.body;

            // Validate tunable config fields via shared helper
            const updates = validateConfigFields(req.body);

            // Handle fields not covered by the shared helper
            if (typeof devMode === 'boolean') {
                updates.devMode = devMode;
                updates.debug = devMode;
                logger.setDebug(devMode);
            } else if (typeof debug === 'boolean') {
                updates.debug = debug;
                updates.devMode = debug;
                logger.setDebug(debug);
            }
            if (logLevel && ['info', 'warn', 'error', 'debug'].includes(logLevel)) {
                updates.logLevel = logLevel;
            }
            if (typeof persistTokenCache === 'boolean') {
                updates.persistTokenCache = persistTokenCache;
            }
            if (typeof requestThrottlingEnabled === 'boolean') {
                updates.requestThrottlingEnabled = requestThrottlingEnabled;
            }
            if (typeof requestDelayMs === 'number' && requestDelayMs >= 100 && requestDelayMs <= 5000) {
                updates.requestDelayMs = requestDelayMs;
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    status: 'error',
                    error: 'No valid configuration updates provided'
                });
            }

            const success = saveConfig(updates);

            if (success) {
                // Hot-reload strategy if it was changed (no server restart needed)
                if (updates.accountSelection?.strategy && accountManager) {
                    await accountManager.reload();
                    logger.info(`[WebUI] Strategy hot-reloaded to: ${updates.accountSelection.strategy}`);
                }

                res.json({
                    status: 'ok',
                    message: 'Configuration saved. Restart server to apply some changes.',
                    updates: updates,
                    config: getPublicConfig()
                });
            } else {
                res.status(500).json({
                    status: 'error',
                    error: 'Failed to save configuration file'
                });
            }
        } catch (error) {
            logger.error('[WebUI] Error updating config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/config/password - Change WebUI password
     */
    app.post('/api/config/password', (req, res) => {
        try {
            const { oldPassword, newPassword } = req.body;

            // Validate input
            if (!newPassword || typeof newPassword !== 'string') {
                return res.status(400).json({
                    status: 'error',
                    error: 'New password is required'
                });
            }

            // If current password exists, verify old password
            if (config.webuiPassword && config.webuiPassword !== oldPassword) {
                return res.status(403).json({
                    status: 'error',
                    error: 'Invalid current password'
                });
            }

            // Save new password
            const success = saveConfig({ webuiPassword: newPassword });

            if (success) {
                // Update in-memory config
                config.webuiPassword = newPassword;
                res.json({
                    status: 'ok',
                    message: 'Password changed successfully'
                });
            } else {
                throw new Error('Failed to save password to config file');
            }
        } catch (error) {
            logger.error('[WebUI] Error changing password:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/settings - Get runtime settings
     */
    app.get('/api/settings', async (req, res) => {
        try {
            const settings = accountManager.getSettings ? accountManager.getSettings() : {};
            res.json({
                status: 'ok',
                settings: {
                    ...settings,
                    port: process.env.PORT || DEFAULT_PORT
                }
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Claude CLI Configuration API
    // ==========================================

    /**
     * GET /api/claude/config - Get Claude CLI configuration
     */
    app.get('/api/claude/config', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();
            res.json({
                status: 'ok',
                config: claudeConfig,
                path: getClaudeConfigPath()
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/config - Update Claude CLI configuration
     */
    app.post('/api/claude/config', async (req, res) => {
        try {
            const updates = req.body;
            if (!updates || typeof updates !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Invalid config updates' });
            }

            const newConfig = await updateClaudeConfig(updates);
            res.json({
                status: 'ok',
                config: newConfig,
                message: 'Claude configuration updated'
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/config/restore - Restore Claude CLI to default (remove proxy settings)
     */
    app.post('/api/claude/config/restore', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();

            // Proxy-related environment variables to remove when restoring defaults
            const PROXY_ENV_VARS = [
                'ANTHROPIC_BASE_URL',
                'ANTHROPIC_AUTH_TOKEN',
                'ANTHROPIC_MODEL',
                'CLAUDE_CODE_SUBAGENT_MODEL',
                'ANTHROPIC_DEFAULT_OPUS_MODEL',
                'ANTHROPIC_DEFAULT_SONNET_MODEL',
                'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                'ENABLE_EXPERIMENTAL_MCP_CLI'
            ];

            // Remove proxy-related environment variables to restore defaults
            if (claudeConfig.env) {
                for (const key of PROXY_ENV_VARS) {
                    delete claudeConfig.env[key];
                }
                // Remove env entirely if empty to truly restore defaults
                if (Object.keys(claudeConfig.env).length === 0) {
                    delete claudeConfig.env;
                }
            }

            // Use replaceClaudeConfig to completely overwrite the config (not merge)
            const newConfig = await replaceClaudeConfig(claudeConfig);

            logger.info(`[WebUI] Restored Claude CLI config to defaults at ${getClaudeConfigPath()}`);

            res.json({
                status: 'ok',
                config: newConfig,
                message: 'Claude CLI configuration restored to defaults'
            });
        } catch (error) {
            logger.error('[WebUI] Error restoring Claude config:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Claude CLI Mode Toggle API (Proxy/Paid)
    // ==========================================

    /**
     * GET /api/claude/mode - Get current mode (proxy or paid)
     * Returns 'proxy' if ANTHROPIC_BASE_URL is set to localhost, 'paid' otherwise
     */
    app.get('/api/claude/mode', async (req, res) => {
        try {
            const claudeConfig = await readClaudeConfig();
            const baseUrl = claudeConfig.env?.ANTHROPIC_BASE_URL || '';

            // Determine mode based on ANTHROPIC_BASE_URL
            const isProxy = baseUrl && (
                baseUrl.includes('localhost') ||
                baseUrl.includes('127.0.0.1') ||
                baseUrl.includes('::1') ||
                baseUrl.includes('0.0.0.0')
            );

            res.json({
                status: 'ok',
                mode: isProxy ? 'proxy' : 'paid'
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/mode - Switch between proxy and paid mode
     * Body: { mode: 'proxy' | 'paid' }
     * 
     * When switching to 'paid' mode:
     * - Removes the entire 'env' object from settings.json
     * - Claude CLI uses its built-in defaults (official Anthropic API)
     * 
     * When switching to 'proxy' mode:
     * - Sets 'env' to the first default preset config (from constants.js)
     */
    app.post('/api/claude/mode', async (req, res) => {
        try {
            const { mode } = req.body;

            if (!mode || !['proxy', 'paid'].includes(mode)) {
                return res.status(400).json({
                    status: 'error',
                    error: 'mode must be "proxy" or "paid"'
                });
            }

            const claudeConfig = await readClaudeConfig();

            if (mode === 'proxy') {
                // Switch to proxy mode - use first default preset config (e.g., "Claude Thinking")
                claudeConfig.env = { ...DEFAULT_PRESETS[0].config };
            } else {
                // Switch to paid mode - remove env entirely
                delete claudeConfig.env;
            }

            // Save the updated config
            const newConfig = await replaceClaudeConfig(claudeConfig);

            logger.info(`[WebUI] Switched Claude CLI to ${mode} mode`);

            res.json({
                status: 'ok',
                mode,
                config: newConfig,
                message: `Switched to ${mode === 'proxy' ? 'Proxy' : 'Paid (Anthropic API)'} mode. Restart Claude CLI to apply.`
            });
        } catch (error) {
            logger.error('[WebUI] Error switching mode:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Claude CLI Presets API
    // ==========================================


    /**
     * GET /api/claude/presets - Get all saved presets
     */
    app.get('/api/claude/presets', async (req, res) => {
        try {
            const presets = await readPresets();
            res.json({ status: 'ok', presets });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/claude/presets - Save a new preset
     */
    app.post('/api/claude/presets', async (req, res) => {
        try {
            const { name, config: presetConfig } = req.body;
            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }
            if (!presetConfig || typeof presetConfig !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Config object is required' });
            }

            const presets = await savePreset(name.trim(), presetConfig);
            res.json({ status: 'ok', presets, message: `Preset "${name}" saved` });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/claude/presets/:name - Delete a preset
     */
    app.delete('/api/claude/presets/:name', async (req, res) => {
        try {
            const { name } = req.params;
            if (!name) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const presets = await deletePreset(name);
            res.json({ status: 'ok', presets, message: `Preset "${name}" deleted` });
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // Server Configuration Presets API
    // ==========================================

    /**
     * GET /api/server/presets - List all server config presets
     */
    app.get('/api/server/presets', async (req, res) => {
        try {
            const presets = await readServerPresets();
            res.json({ status: 'ok', presets });
        } catch (error) {
            logger.error('[WebUI] Error reading server presets:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/server/presets - Save a custom server config preset
     */
    app.post('/api/server/presets', async (req, res) => {
        try {
            const { name, config: presetConfig, description } = req.body;
            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }
            if (name.trim().length > 50) {
                return res.status(400).json({ status: 'error', error: 'Preset name must be 50 characters or fewer' });
            }
            if (!presetConfig || typeof presetConfig !== 'object' || Array.isArray(presetConfig)) {
                return res.status(400).json({ status: 'error', error: 'Config object is required' });
            }

            const validatedConfig = validateConfigFields(presetConfig);
            if (Object.keys(validatedConfig).length === 0) {
                return res.status(400).json({ status: 'error', error: 'No valid config fields provided' });
            }

            const presets = await saveServerPreset(name.trim(), validatedConfig, description);
            res.json({ status: 'ok', presets, message: `Server preset "${name}" saved` });
        } catch (error) {
            const status = error.message.includes('built-in') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });

    /**
     * PATCH /api/server/presets/:name - Update custom preset metadata and/or config
     */
    app.patch('/api/server/presets/:name', async (req, res) => {
        try {
            const { name: currentName } = req.params;
            if (!currentName) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const { name: newName, description, config: configInput } = req.body;
            if (typeof newName === 'string' && !newName.trim()) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }
            if (typeof newName === 'string' && newName.trim().length > 50) {
                return res.status(400).json({ status: 'error', error: 'Preset name must be 50 characters or fewer' });
            }
            const updates = {};
            if (newName !== undefined) updates.name = newName.trim();
            if (description !== undefined) updates.description = description;

            // Validate and include config updates if provided
            if (configInput && typeof configInput === 'object') {
                const validatedConfig = validateConfigFields(configInput);
                if (Object.keys(validatedConfig).length > 0) {
                    updates.config = validatedConfig;
                }
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ status: 'error', error: 'No updates provided' });
            }

            const presets = await updateServerPreset(currentName, updates);
            res.json({ status: 'ok', presets, message: `Server preset "${currentName}" updated` });
        } catch (error) {
            const status = error.message.includes('built-in') || error.message.includes('not found') || error.message.includes('already exists') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });

    /**
     * DELETE /api/server/presets/:name - Delete a custom server config preset
     */
    app.delete('/api/server/presets/:name', async (req, res) => {
        try {
            const { name } = req.params;
            if (!name) {
                return res.status(400).json({ status: 'error', error: 'Preset name is required' });
            }

            const presets = await deleteServerPreset(name);
            res.json({ status: 'ok', presets, message: `Server preset "${name}" deleted` });
        } catch (error) {
            const status = error.message.includes('built-in') ? 400 : 500;
            res.status(status).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/models/config - Update model configuration (hidden/pinned/alias)
     */
    app.post('/api/models/config', (req, res) => {
        try {
            const { modelId, config: newModelConfig } = req.body;

            if (!modelId || typeof newModelConfig !== 'object') {
                return res.status(400).json({ status: 'error', error: 'Invalid parameters' });
            }

            // Load current config
            const currentMapping = config.modelMapping || {};

            // Update specific model config
            currentMapping[modelId] = {
                ...currentMapping[modelId],
                ...newModelConfig
            };

            // Save back to main config
            const success = saveConfig({ modelMapping: currentMapping });

            if (success) {
                // Update in-memory config reference
                config.modelMapping = currentMapping;
                res.json({ status: 'ok', modelConfig: currentMapping[modelId] });
            } else {
                throw new Error('Failed to save configuration');
            }
        } catch (error) {
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/models/refresh - Re-fetch models and quotas directly from Antigravity server
     */
    app.post('/api/models/refresh', async (req, res) => {
        try {
            await accountManager.initialize();
            const allAccounts = accountManager.getAllAccounts().filter(a => !a.isInvalid && a.enabled !== false);
            if (allAccounts.length === 0) {
                return res.status(503).json({
                    status: 'error',
                    error: 'No active accounts available to fetch models. Please link and enable an account first.'
                });
            }

            const allModelIds = new Set();
            let primaryToken = null;

            // Fetch quotas and models in parallel across accounts
            await Promise.allSettled(
                allAccounts.map(async (account) => {
                    try {
                        const token = await accountManager.getTokenForAccount(account);
                        if (!primaryToken) primaryToken = token;

                        const subscription = await getSubscriptionTier(token);
                        const quotas = await getModelQuotas(token, subscription.projectId);

                        account.subscription = {
                            tier: subscription.tier,
                            projectId: subscription.projectId,
                            detectedAt: Date.now()
                        };
                        account.quota = {
                            models: quotas,
                            lastChecked: Date.now()
                        };

                        for (const mId of Object.keys(quotas)) {
                            allModelIds.add(mId);
                        }
                    } catch (err) {
                        logger.warn(`[WebUI] Failed to refresh models for account ${account.email}:`, err.message);
                    }
                })
            );

            // Persist updated account data to disk
            accountManager.saveToDisk().catch(err => {
                logger.error('[WebUI] Failed to save account data after model refresh:', err);
            });

            // Warm validation cache
            if (primaryToken) {
                try {
                    await listModels(primaryToken);
                } catch (e) { /* ignore */ }
            }

            const models = Array.from(allModelIds).sort();
            logger.info(`[WebUI] Manually re-fetched ${models.length} models from Antigravity server`);

            res.json({
                status: 'ok',
                models,
                count: models.length,
                message: `Successfully fetched ${models.length} models from Antigravity server`
            });
        } catch (error) {
            logger.error('[WebUI] Error re-fetching models:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // API Keys Management API
    // ==========================================

    /**
     * GET /api/my-ip - Return caller's IP address (for IP restriction auto-fill)
     */
    app.get('/api/my-ip', (req, res) => {
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress || '127.0.0.1';
        const cleanIp = clientIp.replace(/^::ffff:/, '');
        res.json({
            status: 'ok',
            ip: cleanIp
        });
    });

    /**
     * Helper to collect all available system models (native + custom providers)
     * Matches the exact models available in /account-limits (#models & Settings -> Models)
     */
    async function getAvailableSystemModels(accountMgr) {
        if (Array.isArray(accountMgr?.latestAvailableModels) && accountMgr.latestAvailableModels.length > 0) {
            return [...accountMgr.latestAvailableModels];
        }

        if (accountMgr && typeof accountMgr.initialize === 'function') {
            await accountMgr.initialize();
        }

        const modelSet = new Set();
        try {
            const allAccounts = accountMgr?.getAllAccounts ? accountMgr.getAllAccounts() : [];

            // Native Antigravity/Google accounts
            const nativeAccount = allAccounts.find(a => a.source !== 'custom' && !a.isInvalid);
            if (nativeAccount) {
                try {
                    const token = await accountMgr.getTokenForAccount(nativeAccount);
                    const nativeList = await listModels(token);
                    for (const m of (nativeList?.data || [])) {
                        modelSet.add(m.id);
                    }
                } catch (err) {
                    logger.warn('[WebUI] Failed to fetch native models for API keys list:', err.message);
                }
            }

            // Custom providers models: {provider_name}-{rawModel}
            const customProviders = (accountMgr?.getCustomProviders?.() || []).filter(p => p.enabled !== false);
            for (const p of customProviders) {
                for (const m of (p.models || [])) {
                    modelSet.add(`${p.name}-${m}`);
                }
            }
            for (const acc of allAccounts.filter(a => a.source === 'custom')) {
                for (const m of (acc.models || [])) {
                    modelSet.add(`${acc.name}-${m}`);
                }
            }
        } catch (err) {
            logger.warn('[WebUI] Error getting available system models:', err.message);
        }

        const result = Array.from(modelSet).sort();
        if (accountMgr && result.length > 0) {
            accountMgr.latestAvailableModels = result;
        }
        return result;
    }

    /**
     * GET /api/keys - List all API keys and available system models
     */
    app.get('/api/keys', async (req, res) => {
        try {
            const keys = apiKeyManager.getAllKeys();
            const availableModels = await getAvailableSystemModels(accountManager);
            res.json({
                status: 'ok',
                keys,
                total: keys.length,
                activeCount: keys.filter(k => k.effectiveStatus === 'active').length,
                availableModels
            });
        } catch (error) {
            logger.error('[WebUI] Error fetching API keys:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/keys - Generate a new API key
     */
    app.post('/api/keys', async (req, res) => {
        try {
            const {
                name,
                expiresAt,
                presetDays,
                tokenLimit,
                ipRestrictionEnabled,
                ipRestrictionMode,
                ipList,
                modelRestrictionEnabled,
                allowedModels
            } = req.body;
            if (!name || typeof name !== 'string' || !name.trim()) {
                return res.status(400).json({ status: 'error', error: 'API key name is required' });
            }

            const newKey = await apiKeyManager.createKey({
                name: name.trim(),
                expiresAt,
                presetDays,
                tokenLimit,
                ipRestrictionEnabled,
                ipRestrictionMode,
                ipList,
                modelRestrictionEnabled,
                allowedModels
            });

            res.json({
                status: 'ok',
                key: newKey,
                message: `API key "${newKey.name}" created successfully`
            });
        } catch (error) {
            logger.error('[WebUI] Error creating API key:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/keys/:id/toggle - Toggle revoked/active state
     */
    app.post('/api/keys/:id/toggle', async (req, res) => {
        try {
            const { id } = req.params;
            const updated = await apiKeyManager.toggleRevokeKey(id);
            res.json({
                status: 'ok',
                key: updated,
                message: `API key status changed to ${updated.status}`
            });
        } catch (error) {
            logger.error('[WebUI] Error toggling API key status:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * PUT/PATCH /api/keys/:id - Update an API key
     */
    const handleUpdateKey = async (req, res) => {
        try {
            const { id } = req.params;
            const {
                name,
                expiresAt,
                presetDays,
                tokenLimit,
                resetTokens,
                ipRestrictionEnabled,
                ipRestrictionMode,
                ipList,
                modelRestrictionEnabled,
                allowedModels
            } = req.body;

            const updated = await apiKeyManager.updateKey(id, {
                name,
                expiresAt,
                presetDays,
                tokenLimit,
                resetTokens,
                ipRestrictionEnabled,
                ipRestrictionMode,
                ipList,
                modelRestrictionEnabled,
                allowedModels
            });

            res.json({
                status: 'ok',
                key: updated,
                message: `API key "${updated.name}" updated successfully`
            });
        } catch (error) {
            logger.error('[WebUI] Error updating API key:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    };

    app.put('/api/keys/:id', handleUpdateKey);
    app.patch('/api/keys/:id', handleUpdateKey);

    /**
     * DELETE /api/keys/:id - Delete an API key
     */
    app.delete('/api/keys/:id', async (req, res) => {
        try {
            const { id } = req.params;
            await apiKeyManager.deleteKey(id);
            res.json({
                status: 'ok',
                message: 'API key deleted successfully'
            });
        } catch (error) {
            logger.error('[WebUI] Error deleting API key:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/keys/usage - Get token usage analytics (with filters for key, model, timeRange, interval)
     */
    app.get('/api/keys/usage', (req, res) => {
        try {
            const { keyId, model, timeRange, interval } = req.query;
            const analytics = apiKeyManager.getUsageAnalytics({
                keyId: keyId || 'all',
                model: model || 'all',
                timeRange: timeRange || '24h',
                interval: interval || 'hour'
            });
            res.json({
                status: 'ok',
                analytics
            });
        } catch (error) {
            logger.error('[WebUI] Error fetching usage analytics:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/keys/:id/usage - Get token usage analytics for a specific API key
     */
    app.get('/api/keys/:id/usage', (req, res) => {
        try {
            const { id } = req.params;
            const { model, timeRange, interval } = req.query;
            const analytics = apiKeyManager.getUsageAnalytics({
                keyId: id,
                model: model || 'all',
                timeRange: timeRange || '24h',
                interval: interval || 'hour'
            });
            res.json({
                status: 'ok',
                analytics
            });
        } catch (error) {
            logger.error('[WebUI] Error fetching key usage analytics:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/pricing/refresh - Re-sync live model pricing from LiteLLM database
     */
    app.post('/api/pricing/refresh', async (req, res) => {
        try {
            const result = await fetchLivePricing(true);
            res.json({
                status: result.success ? 'ok' : 'warning',
                result,
                pricingStatus: getPricingStatus()
            });
        } catch (error) {
            logger.error('[WebUI] Error refreshing pricing:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * GET /api/pricing/status - Get current model pricing status
     */
    app.get('/api/pricing/status', (req, res) => {
        res.json({
            status: 'ok',
            pricingStatus: getPricingStatus()
        });
    });


    // ==========================================
    // Logs API
    // ==========================================

    /**
     * GET /api/logs - Get log history
     */
    app.get('/api/logs', (req, res) => {
        res.json({
            status: 'ok',
            logs: logger.getHistory ? logger.getHistory() : []
        });
    });

    /**
     * GET /api/logs/stream - Stream logs via SSE
     */
    app.get('/api/logs/stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const sendLog = (log) => {
            res.write(`data: ${JSON.stringify(log)}\n\n`);
        };

        // Send recent history if requested
        if (req.query.history === 'true' && logger.getHistory) {
            const history = logger.getHistory();
            history.forEach(log => sendLog(log));
        }

        // Subscribe to new logs
        if (logger.on) {
            logger.on('log', sendLog);
        }

        // Cleanup on disconnect
        req.on('close', () => {
            if (logger.off) {
                logger.off('log', sendLog);
            }
        });
    });

    // ==========================================
    // Strategy Health API (Developer Mode)
    // ==========================================

    /**
     * GET /api/strategy/health - Get strategy health data for the inspector panel
     * Only available when devMode is enabled
     */
    app.get('/api/strategy/health', (req, res) => {
        try {
            if (!config.devMode) {
                return res.status(403).json({
                    status: 'error',
                    error: 'Developer mode is not enabled'
                });
            }

            const healthData = accountManager.getStrategyHealthData();
            res.json({
                status: 'ok',
                ...healthData
            });
        } catch (error) {
            logger.error('[WebUI] Error fetching strategy health:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    // ==========================================
    // OAuth API
    // ==========================================

    /**
     * GET /api/auth/url - Get OAuth URL to start the flow
     * Uses CLI's OAuth flow (localhost:51121) instead of WebUI's port
     * to match Google OAuth Console's authorized redirect URIs
     */
    app.get('/api/auth/url', async (req, res) => {
        try {
            // Clean up old flows (> 10 mins)
            const now = Date.now();
            for (const [key, val] of pendingOAuthFlows.entries()) {
                if (now - val.timestamp > 10 * 60 * 1000) {
                    pendingOAuthFlows.delete(key);
                }
            }

            // Generate OAuth URL using default redirect URI (localhost:51121)
            const { url, verifier, state } = getAuthorizationUrl();

            // Start callback server on port 51121 (same as CLI)
            const { promise: serverPromise, abort: abortServer } = startCallbackServer(state, 120000); // 2 min timeout

            // Store the flow data
            pendingOAuthFlows.set(state, {
                serverPromise,
                abortServer,
                verifier,
                state,
                timestamp: Date.now()
            });

            // Start async handler for the OAuth callback
            serverPromise
                .then(async (code) => {
                    try {
                        logger.info('[WebUI] Received OAuth callback, completing flow...');
                        const accountData = await completeOAuthFlow(code, verifier);

                        // Add or update the account
                        // Note: Don't set projectId here - it will be discovered and stored
                        // in the refresh token via getProjectForAccount() on first use
                        await addAccount({
                            email: accountData.email,
                            refreshToken: accountData.refreshToken,
                            source: 'oauth'
                        });

                        // Reload AccountManager to pick up the new account
                        await accountManager.reload();

                        logger.success(`[WebUI] Account ${accountData.email} added successfully`);
                    } catch (err) {
                        logger.error('[WebUI] OAuth flow completion error:', err);
                    } finally {
                        pendingOAuthFlows.delete(state);
                    }
                })
                .catch((err) => {
                    // Only log if not aborted (manual completion causes this)
                    if (!err.message?.includes('aborted')) {
                        logger.error('[WebUI] OAuth callback server error:', err);
                    }
                    pendingOAuthFlows.delete(state);
                });

            res.json({ status: 'ok', url, state });
        } catch (error) {
            logger.error('[WebUI] Error generating auth URL:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * POST /api/auth/complete - Complete OAuth with manually submitted callback URL/code
     * Used when auto-callback cannot reach the local server
     */
    app.post('/api/auth/complete', async (req, res) => {
        try {
            const { callbackInput, state } = req.body;

            if (!callbackInput || !state) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Missing callbackInput or state'
                });
            }

            // Find the pending flow
            const flowData = pendingOAuthFlows.get(state);
            if (!flowData) {
                return res.status(400).json({
                    status: 'error',
                    error: 'OAuth flow not found. The account may have been already added via auto-callback. Please refresh the account list.'
                });
            }

            const { verifier, abortServer } = flowData;

            // Extract code from input (URL or raw code)
            const { extractCodeFromInput, completeOAuthFlow } = await import('../auth/oauth.js');
            const { code } = extractCodeFromInput(callbackInput);

            // Complete the OAuth flow
            const accountData = await completeOAuthFlow(code, verifier);

            // Add or update the account
            await addAccount({
                email: accountData.email,
                refreshToken: accountData.refreshToken,
                projectId: accountData.projectId,
                source: 'oauth'
            });

            // Reload AccountManager to pick up the new account
            await accountManager.reload();

            // Abort the callback server since manual completion succeeded
            if (abortServer) {
                abortServer();
            }

            // Clean up
            pendingOAuthFlows.delete(state);

            logger.success(`[WebUI] Account ${accountData.email} added via manual callback`);

            res.json({
                status: 'ok',
                email: accountData.email,
                message: `Account ${accountData.email} added successfully`
            });
        } catch (error) {
            logger.error('[WebUI] Manual OAuth completion error:', error);
            res.status(500).json({ status: 'error', error: error.message });
        }
    });

    /**
     * Note: /oauth/callback route removed
     * OAuth callbacks are now handled by the temporary server on port 51121
     * (same as CLI) to match Google OAuth Console's authorized redirect URIs
     */

    logger.info('[WebUI] Mounted at /');
}
