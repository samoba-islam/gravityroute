import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './utils/logger.js';

function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

const DENIED_KEYS = ['__proto__', 'constructor', 'prototype'];

function deepMerge(target, source) {
    const output = { ...target };
    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (DENIED_KEYS.includes(key)) return;
            if (isObject(source[key])) {
                if (!(key in target)) {
                    Object.assign(output, { [key]: source[key] });
                } else {
                    output[key] = deepMerge(target[key], source[key]);
                }
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }
    return output;
}

// Default config
const DEFAULT_CONFIG = {
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
    defaultCooldownMs: 10000,  // 10 seconds
    maxWaitBeforeErrorMs: 120000, // 2 minutes
    maxAccounts: 10, // Maximum number of accounts allowed
    globalQuotaThreshold: 0, // 0 = disabled, 0.01-0.99 = minimum quota fraction before switching accounts
    requestThrottlingEnabled: false, // Opt-in: enable delay before Google API requests
    requestDelayMs: 200, // Delay in ms when throttling enabled (100-5000ms)
    // Rate limit handling (matches opencode-antigravity-auth)
    rateLimitDedupWindowMs: 2000,  // 2 seconds - prevents concurrent retry storms
    maxConsecutiveFailures: 3,     // Before applying extended cooldown
    extendedCooldownMs: 60000,     // 1 minute extended cooldown
    maxCapacityRetries: 5,         // Max retries for capacity exhaustion
    switchAccountDelayMs: 5000,    // Delay before switching accounts on rate limit
    capacityBackoffTiersMs: [5000, 10000, 20000, 30000, 60000], // Progressive backoff tiers for capacity exhaustion
    modelMapping: {},
    // Account selection strategy configuration
    accountSelection: {
        strategy: 'hybrid',           // 'sticky' | 'round-robin' | 'hybrid'
        // Hybrid strategy tuning (optional - sensible defaults)
        healthScore: {
            initial: 70,              // Starting score for new accounts
            successReward: 1,         // Points on successful request
            rateLimitPenalty: -10,    // Points on rate limit
            failurePenalty: -20,      // Points on other failures
            recoveryPerHour: 10,      // Passive recovery rate (matches health-tracker.js)
            minUsable: 50,            // Minimum score to be selected
            maxScore: 100             // Maximum score cap
        },
        tokenBucket: {
            maxTokens: 50,            // Maximum token capacity
            tokensPerMinute: 6,       // Regeneration rate
            initialTokens: 50         // Starting tokens
        },
        quota: {
            lowThreshold: 0.10,       // 10% - reduce score
            criticalThreshold: 0.05,  // 5% - exclude from candidates
            staleMs: 300000           // 5 min - max age of quota data to trust
        },
        weights: {
            health: 2,                // Weight for health score component
            tokens: 5,                // Weight for token bucket component
            quota: 3,                 // Weight for quota awareness component
            lru: 0.1                  // Weight for LRU freshness component
        }
    }
};

// Config locations with backward compatibility
const HOME_DIR = os.homedir();
const PRIMARY_CONFIG_DIR = path.join(HOME_DIR, '.config', 'gravityroute');
const LEGACY_CONFIG_DIR = path.join(HOME_DIR, '.config', 'antigravity-proxy');

export function getConfigDir() {
    if (fs.existsSync(PRIMARY_CONFIG_DIR)) return PRIMARY_CONFIG_DIR;
    if (fs.existsSync(LEGACY_CONFIG_DIR)) return LEGACY_CONFIG_DIR;
    return PRIMARY_CONFIG_DIR;
}

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Ensure config dir exists
if (!fs.existsSync(CONFIG_DIR)) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    } catch (err) {
        // Ignore
    }
}

// Load config
let config = { ...DEFAULT_CONFIG };

export function loadConfig() {
    try {
        // Env vars take precedence for initial defaults, but file overrides them if present?
        // Usually Env > File > Default.

        if (fs.existsSync(CONFIG_FILE)) {
            const fileContent = fs.readFileSync(CONFIG_FILE, 'utf8');
            const userConfig = JSON.parse(fileContent);
            config = deepMerge(DEFAULT_CONFIG, userConfig);
        } else {
             // Try looking in current dir for config.json as fallback
             const localConfigPath = path.resolve('config.json');
             if (fs.existsSync(localConfigPath)) {
                 const fileContent = fs.readFileSync(localConfigPath, 'utf8');
                 const userConfig = JSON.parse(fileContent);
                 config = deepMerge(DEFAULT_CONFIG, userConfig);
             }
        }

        // Environment overrides
        if (process.env.API_KEY) config.apiKey = process.env.API_KEY;
        if (process.env.WEBUI_AUTH_ENABLED !== undefined) config.webuiAuthEnabled = process.env.WEBUI_AUTH_ENABLED === 'true';
        if (process.env.WEBUI_USERNAME) config.webuiUsername = process.env.WEBUI_USERNAME;
        if (process.env.WEBUI_EMAIL) config.webuiEmail = process.env.WEBUI_EMAIL;
        if (process.env.WEBUI_PASSWORD) config.webuiPassword = process.env.WEBUI_PASSWORD;
        if (!config.webuiRecoveryMode) config.webuiRecoveryMode = { ...DEFAULT_CONFIG.webuiRecoveryMode };
        if (process.env.WEBUI_RECOVERY_CLI_ENABLED !== undefined) {
            config.webuiRecoveryMode.cliEnabled = process.env.WEBUI_RECOVERY_CLI_ENABLED === 'true';
        }
        if (process.env.WEBUI_RECOVERY_EMAIL_ENABLED !== undefined) {
            config.webuiRecoveryMode.emailEnabled = process.env.WEBUI_RECOVERY_EMAIL_ENABLED === 'true';
        }
        if (!config.smtp) config.smtp = { ...DEFAULT_CONFIG.smtp };
        if (process.env.SMTP_ENABLED !== undefined) config.smtp.enabled = process.env.SMTP_ENABLED === 'true';
        if (process.env.SMTP_HOST) config.smtp.host = process.env.SMTP_HOST;
        if (process.env.SMTP_PORT) config.smtp.port = parseInt(process.env.SMTP_PORT, 10) || 587;
        if (process.env.SMTP_SECURE !== undefined) config.smtp.secure = process.env.SMTP_SECURE === 'true';
        if (process.env.SMTP_USER) config.smtp.user = process.env.SMTP_USER;
        if (process.env.SMTP_PASS) config.smtp.pass = process.env.SMTP_PASS;
        if (process.env.SMTP_FROM_EMAIL) config.smtp.fromEmail = process.env.SMTP_FROM_EMAIL;
        if (process.env.SMTP_FROM_NAME) config.smtp.fromName = process.env.SMTP_FROM_NAME;
        if (process.env.DEBUG === 'true') config.debug = true;
        if (process.env.DEV_MODE === 'true') config.devMode = true;

        // Backward compat: debug implies devMode
        if (config.debug && !config.devMode) config.devMode = true;

    } catch (error) {
        logger.error('[Config] Error loading config:', error);
    }
}

// Initial load
loadConfig();

export function getPublicConfig() {
    // Create a deep copy and redact sensitive fields
    const publicConfig = JSON.parse(JSON.stringify(config));

    // Redact sensitive values
    if (publicConfig.webuiPassword) publicConfig.webuiPassword = '********';
    if (publicConfig.apiKey) publicConfig.apiKey = '********';
    if (publicConfig.smtp) {
        publicConfig.smtp.hasPassword = Boolean(config.smtp?.pass);
        if (publicConfig.smtp.pass) publicConfig.smtp.pass = '********';
    }

    return publicConfig;
}

export function saveConfig(updates) {
    try {
        // Apply updates (deep merge to preserve nested configs)
        config = deepMerge(config, updates);

        // Save to disk
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (error) {
        logger.error('[Config] Failed to save config:', error);
        return false;
    }
}

export { config };