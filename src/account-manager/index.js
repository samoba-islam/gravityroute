/**
 * Account Manager
 * Manages multiple Antigravity accounts with configurable selection strategies,
 * automatic failover, and smart cooldown for rate-limited accounts.
 */

import { ACCOUNT_CONFIG_PATH } from '../constants.js';
import { config } from '../config.js';
import { loadAccounts, loadDefaultAccount, saveAccounts } from './storage.js';
import {
    isAllRateLimited as checkAllRateLimited,
    getAvailableAccounts as getAvailable,
    getInvalidAccounts as getInvalid,
    clearExpiredLimits as clearLimits,
    resetAllRateLimits as resetLimits,
    markRateLimited as markLimited,
    markInvalid as markAccountInvalid,
    clearInvalid as clearAccountInvalid,
    getMinWaitTimeMs as getMinWait,
    getRateLimitInfo as getLimitInfo,
    getConsecutiveFailures as getFailures,
    resetConsecutiveFailures as resetFailures,
    incrementConsecutiveFailures as incrementFailures,
    markAccountCoolingDown as markCoolingDown,
    isAccountCoolingDown as checkCoolingDown,
    clearAccountCooldown as clearCooldown,
    getCooldownRemaining as getCooldownMs,
    CooldownReason
} from './rate-limits.js';
import {
    getTokenForAccount as fetchToken,
    getProjectForAccount as fetchProject,
    clearProjectCache as clearProject,
    clearTokenCache as clearToken
} from './credentials.js';
import { createStrategy, getStrategyLabel, DEFAULT_STRATEGY } from './strategies/index.js';
import { logger } from '../utils/logger.js';

export class AccountManager {
    #accounts = [];
    #currentIndex = 0;
    #configPath;
    #settings = {};
    #initialized = false;
    #strategy = null;
    #strategyName = DEFAULT_STRATEGY;

    // Per-account caches
    #tokenCache = new Map(); // email -> { token, extractedAt }
    #projectCache = new Map(); // email -> projectId

    constructor(configPath = ACCOUNT_CONFIG_PATH, strategyName = null) {
        this.#configPath = configPath;
        // Strategy name can be set at construction or later via initialize
        if (strategyName) {
            this.#strategyName = strategyName;
        }
    }

    /**
     * Initialize the account manager by loading config
     * @param {string} [strategyOverride] - Override strategy name (from CLI flag or env var)
     */
    async initialize(strategyOverride = null) {
        if (this.#initialized) return;

        const { accounts, settings, activeIndex } = await loadAccounts(this.#configPath);

        this.#accounts = accounts;
        this.#settings = settings;
        this.#currentIndex = activeIndex;

        // If config exists but has no accounts, fall back to Antigravity database
        if (this.#accounts.length === 0) {
            logger.warn('[AccountManager] No accounts in config. Falling back to Antigravity database');
            const { accounts: defaultAccounts, tokenCache } = loadDefaultAccount();
            this.#accounts = defaultAccounts;
            this.#tokenCache = tokenCache;
        }

        // Determine strategy: CLI override > env var > config file > default
        const configStrategy = config?.accountSelection?.strategy;
        const envStrategy = process.env.ACCOUNT_STRATEGY;
        this.#strategyName = strategyOverride || envStrategy || configStrategy || this.#strategyName;

        // Create the strategy instance
        const strategyConfig = config?.accountSelection || {};
        this.#strategy = createStrategy(this.#strategyName, strategyConfig);
        logger.info(`[AccountManager] Using ${getStrategyLabel(this.#strategyName)} selection strategy`);

        // Clear any expired rate limits
        this.clearExpiredLimits();

        this.#initialized = true;
    }

    /**
     * Reload accounts from disk (force re-initialization)
     * Useful when accounts.json is modified externally (e.g., by WebUI)
     */
    async reload() {
        this.#initialized = false;
        await this.initialize();
        logger.info('[AccountManager] Accounts reloaded from disk');
    }

    /**
     * Get the number of accounts
     * @returns {number} Number of configured accounts
     */
    getAccountCount() {
        return this.#accounts.length;
    }

    /**
     * Check if all accounts are rate-limited
     * @param {string} [modelId] - Optional model ID
     * @returns {boolean} True if all accounts are rate-limited
     */
    isAllRateLimited(modelId = null) {
        return checkAllRateLimited(this.#accounts, modelId);
    }

    /**
     * Get list of available (non-rate-limited, non-invalid) accounts
     * @param {string} [modelId] - Optional model ID
     * @returns {Array<Object>} Array of available account objects
     */
    getAvailableAccounts(modelId = null) {
        return getAvailable(this.#accounts, modelId);
    }

    /**
     * Get list of invalid accounts
     * @returns {Array<Object>} Array of invalid account objects
     */
    getInvalidAccounts() {
        return getInvalid(this.#accounts);
    }

    /**
     * Check if all enabled accounts are invalid (need user intervention).
     * Unlike rate limits, invalid accounts won't self-recover — waiting is pointless.
     * @returns {boolean} True if every enabled account is invalid
     */
    isAllAccountsInvalid() {
        const enabled = this.#accounts.filter(a => a.enabled !== false);
        return enabled.length > 0 && enabled.every(a => a.isInvalid);
    }

    /**
     * Clear expired rate limits
     * @returns {number} Number of rate limits cleared
     */
    clearExpiredLimits() {
        const cleared = clearLimits(this.#accounts);
        if (cleared > 0) {
            this.saveToDisk();
        }
        return cleared;
    }

    /**
     * Clear all rate limits to force a fresh check
     * (Optimistic retry strategy)
     * @returns {void}
     */
    resetAllRateLimits() {
        resetLimits(this.#accounts);
    }

    /**
     * Select an account using the configured strategy.
     * This is the main method to use for account selection.
     * @param {string} [modelId] - Model ID for the request
     * @param {Object} [options] - Additional options
     * @param {string} [options.sessionId] - Session ID for cache continuity
     * @returns {{account: Object|null, waitMs: number}} Account to use and optional wait time
     */
    selectAccount(modelId = null, options = {}) {
        if (!this.#strategy) {
            throw new Error('AccountManager not initialized. Call initialize() first.');
        }

        const result = this.#strategy.selectAccount(this.#accounts, modelId, {
            currentIndex: this.#currentIndex,
            onSave: () => this.saveToDisk(),
            ...options
        });

        this.#currentIndex = result.index;
        return { account: result.account, waitMs: result.waitMs || 0 };
    }

    /**
     * Notify the strategy of a successful request
     * @param {Object} account - The account that was used
     * @param {string} modelId - The model ID that was used
     */
    notifySuccess(account, modelId) {
        if (this.#strategy) {
            this.#strategy.onSuccess(account, modelId);
        }
        // Reset consecutive failures on success (matches opencode-antigravity-auth)
        if (account?.email) {
            resetFailures(this.#accounts, account.email);
        }
    }

    /**
     * Notify the strategy of a rate limit
     * @param {Object} account - The account that was rate-limited
     * @param {string} modelId - The model ID that was rate-limited
     */
    notifyRateLimit(account, modelId) {
        if (this.#strategy) {
            this.#strategy.onRateLimit(account, modelId);
        }
    }

    /**
     * Notify the strategy of a failure
     * @param {Object} account - The account that failed
     * @param {string} modelId - The model ID that failed
     */
    notifyFailure(account, modelId) {
        if (this.#strategy) {
            this.#strategy.onFailure(account, modelId);
        }
    }

    /**
     * Get the consecutive failure count for an account
     * Used for progressive backoff calculation
     * @param {string} email - Account email
     * @returns {number} Number of consecutive failures
     */
    getConsecutiveFailures(email) {
        return getFailures(this.#accounts, email);
    }

    /**
     * Increment the consecutive failure count without marking as rate limited
     * Used for quick retries to track failures while staying on same account
     * @param {string} email - Account email
     * @returns {number} New consecutive failure count
     */
    incrementConsecutiveFailures(email) {
        return incrementFailures(this.#accounts, email);
    }

    /**
     * Get the current strategy name
     * @returns {string} Strategy name
     */
    getStrategyName() {
        return this.#strategyName;
    }

    /**
     * Get the strategy display label
     * @returns {string} Strategy display label
     */
    getStrategyLabel() {
        return getStrategyLabel(this.#strategyName);
    }

    /**
     * Get the health tracker from the current strategy (if available)
     * Used by handlers for consecutive failure tracking
     * Only available when using hybrid strategy
     * @returns {Object|null} Health tracker instance or null if not available
     */
    getHealthTracker() {
        if (this.#strategy && typeof this.#strategy.getHealthTracker === 'function') {
            return this.#strategy.getHealthTracker();
        }
        return null;
    }

    /**
     * Mark an account as rate-limited
     * @param {string} email - Email of the account to mark
     * @param {number|null} resetMs - Time in ms until rate limit resets (optional)
     * @param {string} [modelId] - Optional model ID to mark specific limit
     */
    markRateLimited(email, resetMs = null, modelId = null) {
        markLimited(this.#accounts, email, resetMs, modelId);
        this.saveToDisk();
    }

    /**
     * Mark an account as invalid (credentials need re-authentication)
     * @param {string} email - Email of the account to mark
     * @param {string} reason - Reason for marking as invalid
     * @param {string|null} verifyUrl - Optional verification URL (for 403 VALIDATION_REQUIRED)
     */
    markInvalid(email, reason = 'Unknown error', verifyUrl = null) {
        markAccountInvalid(this.#accounts, email, reason, verifyUrl);
        this.saveToDisk();
    }

    /**
     * Clear invalid status for an account (after user completes verification)
     * @param {string} email - Email of the account to clear
     */
    clearInvalid(email) {
        clearAccountInvalid(this.#accounts, email);
        this.saveToDisk();
    }

    /**
     * Get the minimum wait time until any account becomes available
     * @param {string} [modelId] - Optional model ID
     * @returns {number} Wait time in milliseconds
     */
    getMinWaitTimeMs(modelId = null) {
        return getMinWait(this.#accounts, modelId);
    }

    /**
     * Get rate limit info for a specific account and model
     * @param {string} email - Email of the account
     * @param {string} modelId - Model ID to check
     * @returns {{isRateLimited: boolean, actualResetMs: number|null, waitMs: number}} Rate limit info
     */
    getRateLimitInfo(email, modelId) {
        return getLimitInfo(this.#accounts, email, modelId);
    }

    // ============================================================================
    // Cooldown Methods (matches opencode-antigravity-auth)
    // ============================================================================

    /**
     * Mark an account as cooling down for a specified duration
     * Used for temporary backoff separate from rate limits
     * @param {string} email - Email of the account
     * @param {number} cooldownMs - Duration of cooldown in milliseconds
     * @param {string} [reason] - Reason for the cooldown (use CooldownReason constants)
     */
    markAccountCoolingDown(email, cooldownMs, reason = CooldownReason.RATE_LIMIT) {
        markCoolingDown(this.#accounts, email, cooldownMs, reason);
    }

    /**
     * Check if an account is currently cooling down
     * @param {string} email - Email of the account
     * @returns {boolean} True if account is cooling down
     */
    isAccountCoolingDown(email) {
        const account = this.#accounts.find(a => a.email === email);
        return account ? checkCoolingDown(account) : false;
    }

    /**
     * Clear the cooldown for an account
     * @param {string} email - Email of the account
     */
    clearAccountCooldown(email) {
        const account = this.#accounts.find(a => a.email === email);
        if (account) {
            clearCooldown(account);
        }
    }

    /**
     * Get time remaining until cooldown expires for an account
     * @param {string} email - Email of the account
     * @returns {number} Milliseconds until cooldown expires, 0 if not cooling down
     */
    getCooldownRemaining(email) {
        const account = this.#accounts.find(a => a.email === email);
        return account ? getCooldownMs(account) : 0;
    }

    /**
     * Get OAuth token for an account
     * @param {Object} account - Account object with email and credentials
     * @returns {Promise<string>} OAuth access token
     * @throws {Error} If token refresh fails
     */
    async getTokenForAccount(account) {
        return fetchToken(
            account,
            this.#tokenCache,
            (email, reason) => this.markInvalid(email, reason),
            () => this.saveToDisk()
        );
    }

    /**
     * Get project ID for an account
     * @param {Object} account - Account object
     * @param {string} token - OAuth access token
     * @returns {Promise<string>} Project ID
     */
    async getProjectForAccount(account, token) {
        // Pass onSave callback to persist managedProjectId in refresh token
        return fetchProject(account, token, this.#projectCache, () => this.saveToDisk());
    }

    /**
     * Clear project cache for an account (useful on auth errors)
     * @param {string|null} email - Email to clear cache for, or null to clear all
     */
    clearProjectCache(email = null) {
        clearProject(this.#projectCache, email);
    }

    /**
     * Clear token cache for an account (useful on auth errors)
     * @param {string|null} email - Email to clear cache for, or null to clear all
     */
    clearTokenCache(email = null) {
        clearToken(this.#tokenCache, email);
    }

    /**
     * Save current state to disk (async)
     * @returns {Promise<void>}
     */
    async saveToDisk() {
        await saveAccounts(this.#configPath, this.#accounts, this.#settings, this.#currentIndex);
    }

    /**
     * Get status object for logging/API
     * @returns {{accounts: Array, settings: Object}} Status object with accounts and settings
     */
    getStatus() {
        const available = this.getAvailableAccounts();
        const invalid = this.getInvalidAccounts();

        // Count accounts that have any active model-specific rate limits
        const rateLimited = this.#accounts.filter(a => {
            if (!a.modelRateLimits) return false;
            return Object.values(a.modelRateLimits).some(
                limit => limit.isRateLimited && limit.resetTime > Date.now()
            );
        });

        return {
            total: this.#accounts.length,
            available: available.length,
            rateLimited: rateLimited.length,
            invalid: invalid.length,
            summary: `${this.#accounts.length} total, ${available.length} available, ${rateLimited.length} rate-limited, ${invalid.length} invalid`,
            accounts: this.#accounts.map(a => {
                if (a.source === 'custom') {
                    return {
                        name: a.name,
                        email: a.email,
                        source: 'custom',
                        type: a.type || 'openai',
                        enabled: a.enabled !== false,
                        baseUrl: a.baseUrl,
                        apiKey: a.apiKey ? (a.apiKey.length > 8 ? `${a.apiKey.slice(0, 4)}...${a.apiKey.slice(-4)}` : '****') : '',
                        models: a.models || [],
                        quotaType: a.quotaType || 'dollar',
                        initialBalance: a.initialBalance || 0,
                        currentBalance: a.currentBalance !== undefined ? a.currentBalance : (a.initialBalance || 0),
                        initialTokens: a.initialTokens || 0,
                        currentTokens: a.currentTokens !== undefined ? a.currentTokens : (a.initialTokens || 0),
                        pricing: a.pricing || { inputPricePerM: 0, outputPricePerM: 0, cachePricePerM: 0 },
                        usage: a.usage || { totalRequests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalCost: 0 },
                        lastUsed: a.lastUsed
                    };
                }

                return {
                    email: a.email,
                    source: a.source,
                    enabled: a.enabled !== false,  // Default to true if undefined
                    projectId: a.projectId || null,
                    modelRateLimits: a.modelRateLimits || {},
                    isInvalid: a.isInvalid || false,
                    invalidReason: a.invalidReason || null,
                    verifyUrl: a.verifyUrl || null,
                    lastUsed: a.lastUsed,
                    // Include quota threshold settings
                    quotaThreshold: a.quotaThreshold,
                    modelQuotaThresholds: a.modelQuotaThresholds || {}
                };
            })
        };
    }

    /**
     * Get settings
     * @returns {Object} Current settings object
     */
    getSettings() {
        return { ...this.#settings };
    }

    /**
     * Get strategy health data for the health inspector panel.
     * Only returns tracker data when using the hybrid strategy.
     * @returns {Object} Strategy health data
     */
    getStrategyHealthData() {
        const strategyName = this.#strategyName;

        // Only hybrid strategy has trackers
        if (!this.#strategy || typeof this.#strategy.getHealthTracker !== 'function') {
            return { strategy: strategyName, trackers: null };
        }

        const healthTracker = this.#strategy.getHealthTracker();
        const tokenBucketTracker = this.#strategy.getTokenBucketTracker();

        const accounts = this.#accounts
            .filter(a => a.enabled !== false)
            .map(account => {
                const email = account.email;
                const healthScore = healthTracker ? healthTracker.getScore(email) : null;
                const isUsable = healthTracker ? healthTracker.isUsable(email) : null;
                const consecutiveFailures = healthTracker ? healthTracker.getConsecutiveFailures(email) : 0;
                const tokens = tokenBucketTracker ? tokenBucketTracker.getTokens(email) : null;
                const hasTokens = tokenBucketTracker ? tokenBucketTracker.hasTokens(email) : null;
                const maxTokens = tokenBucketTracker ? tokenBucketTracker.getMaxTokens() : null;

                return {
                    email,
                    healthScore: healthScore != null ? Math.round(healthScore * 10) / 10 : null,
                    isUsable,
                    consecutiveFailures,
                    tokens: tokens != null ? Math.round(tokens * 10) / 10 : null,
                    hasTokens,
                    maxTokens
                };
            });

        return {
            strategy: strategyName,
            trackers: { accounts }
        };
    }

    /**
     * Get all accounts (internal use for quota fetching)
     * Returns the full account objects including credentials
     * @returns {Array<Object>} Array of account objects
     */
    getAllAccounts() {
        return this.#accounts;
    }

    /**
     * Get all custom providers
     * @returns {Array<Object>} Array of custom provider objects
     */
    getCustomProviders() {
        return this.#accounts.filter(a => a.source === 'custom');
    }

    /**
     * Find a custom provider configured for the requested model.
     * Custom models follow the naming format: {provider_name}-{model_name}
     *
     * @param {string} requestedModel - The model requested by the client
     * @returns {{provider: Object, rawModel: string}|null}
     */
    findCustomProviderForModel(requestedModel) {
        if (!requestedModel || typeof requestedModel !== 'string') return null;

        const customProviders = this.#accounts.filter(a => a.source === 'custom' && a.enabled !== false);

        for (const provider of customProviders) {
            const prefix = `${provider.name}-`;
            if (requestedModel.startsWith(prefix)) {
                const rawModel = requestedModel.slice(prefix.length);
                return { provider, rawModel };
            }
            // Direct model match if model is in provider.models
            if (Array.isArray(provider.models) && provider.models.includes(requestedModel)) {
                return { provider, rawModel: requestedModel };
            }
        }

        return null;
    }

    /**
     * Record token usage and update balance/quota for a custom provider
     *
     * @param {string} providerName - Provider name or email
     * @param {Object} tokenStats - Token stats { inputTokens, outputTokens, cacheTokens }
     */
    async recordCustomProviderUsage(providerName, tokenStats = {}) {
        const provider = this.#accounts.find(a =>
            a.source === 'custom' && (a.name === providerName || a.email === providerName)
        );
        if (!provider) return;

        const inputTokens = Number(tokenStats.inputTokens) || 0;
        const outputTokens = Number(tokenStats.outputTokens) || 0;
        const cacheTokens = Number(tokenStats.cacheTokens) || 0;

        provider.usage = provider.usage || { totalRequests: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalCost: 0 };
        provider.pricing = provider.pricing || { inputPricePerM: 0, outputPricePerM: 0, cachePricePerM: 0 };

        const inputCost = (inputTokens * (Number(provider.pricing.inputPricePerM) || 0)) / 1_000_000;
        const outputCost = (outputTokens * (Number(provider.pricing.outputPricePerM) || 0)) / 1_000_000;
        const cacheCost = (cacheTokens * (Number(provider.pricing.cachePricePerM) || 0)) / 1_000_000;
        const requestCost = inputCost + outputCost + cacheCost;

        provider.usage.totalRequests = (provider.usage.totalRequests || 0) + 1;
        provider.usage.inputTokens = (provider.usage.inputTokens || 0) + inputTokens;
        provider.usage.outputTokens = (provider.usage.outputTokens || 0) + outputTokens;
        provider.usage.cacheTokens = (provider.usage.cacheTokens || 0) + cacheTokens;
        provider.usage.totalCost = Math.round(((provider.usage.totalCost || 0) + requestCost) * 100000) / 100000;
        provider.lastUsed = Date.now();

        if (provider.quotaType === 'dollar') {
            const current = provider.currentBalance !== undefined ? provider.currentBalance : provider.initialBalance || 0;
            provider.currentBalance = Math.max(0, Math.round((current - requestCost) * 100000) / 100000);
        } else if (provider.quotaType === 'token') {
            const totalTokensUsed = inputTokens + outputTokens;
            const current = provider.currentTokens !== undefined ? provider.currentTokens : provider.initialTokens || 0;
            provider.currentTokens = Math.max(0, current - totalTokensUsed);
        }

        // Persist updated balance & metrics to disk
        this.saveToDisk().catch(err => {
            logger.error('[AccountManager] Failed to persist custom provider usage:', err.message);
        });
    }
}

// Re-export CooldownReason for use by handlers
export { CooldownReason };

export default AccountManager;
