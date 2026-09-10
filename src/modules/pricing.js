import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import { getConfigDir } from '../config.js';

const DATA_DIR = getConfigDir();
const PRICING_CACHE_FILE = path.join(DATA_DIR, 'model-pricing.json');
const LITELLM_PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * Built-in fallback baseline prices per token (in USD)
 * Based on official Anthropic & Google Cloud rates
 */
const DEFAULT_PRICING_MAP = {
    // Claude Opus (Highest tier: $15/M in, $75/M out, $1.50/M cache read)
    'opus': {
        inputCostPerToken: 15 / 1000000,
        outputCostPerToken: 75 / 1000000,
        cacheReadCostPerToken: 1.50 / 1000000,
        cacheCreationCostPerToken: 18.75 / 1000000,
        name: 'Claude Opus Tier'
    },
    // Claude Sonnet (Mid tier: $3/M in, $15/M out, $0.30/M cache read)
    'sonnet': {
        inputCostPerToken: 3 / 1000000,
        outputCostPerToken: 15 / 1000000,
        cacheReadCostPerToken: 0.30 / 1000000,
        cacheCreationCostPerToken: 3.75 / 1000000,
        name: 'Claude Sonnet Tier'
    },
    // Claude Haiku (Fast tier: $0.80/M in, $4/M out, $0.08/M cache read)
    'haiku': {
        inputCostPerToken: 0.80 / 1000000,
        outputCostPerToken: 4 / 1000000,
        cacheReadCostPerToken: 0.08 / 1000000,
        cacheCreationCostPerToken: 1.00 / 1000000,
        name: 'Claude Haiku Tier'
    },
    // Gemini Pro ($1.25/M in, $5/M out, $0.3125/M cache read)
    'gemini-pro': {
        inputCostPerToken: 1.25 / 1000000,
        outputCostPerToken: 5 / 1000000,
        cacheReadCostPerToken: 0.3125 / 1000000,
        cacheCreationCostPerToken: 1.5625 / 1000000,
        name: 'Gemini Pro Tier'
    },
    // Gemini Flash ($0.10 - $0.15/M in, $0.40 - $0.60/M out)
    'gemini-flash': {
        inputCostPerToken: 0.15 / 1000000,
        outputCostPerToken: 0.60 / 1000000,
        cacheReadCostPerToken: 0.0375 / 1000000,
        cacheCreationCostPerToken: 0.1875 / 1000000,
        name: 'Gemini Flash Tier'
    },
    // Standard default
    'default': {
        inputCostPerToken: 3 / 1000000,
        outputCostPerToken: 15 / 1000000,
        cacheReadCostPerToken: 0.30 / 1000000,
        cacheCreationCostPerToken: 3.75 / 1000000,
        name: 'Standard Model Rate'
    }
};

let livePricingData = null;
let lastFetchedAt = null;
let isInitialized = false;

/**
 * Load cached pricing from disk
 */
function loadCachedPricing() {
    try {
        if (fs.existsSync(PRICING_CACHE_FILE)) {
            const raw = fs.readFileSync(PRICING_CACHE_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && parsed.pricing && typeof parsed.pricing === 'object') {
                livePricingData = parsed.pricing;
                lastFetchedAt = parsed.lastFetchedAt || null;
                logger.info(`[Pricing] Loaded cached model pricing (${Object.keys(livePricingData).length} models)`);
                return true;
            }
        }
    } catch (err) {
        logger.error('[Pricing] Failed to load cached pricing:', err.message);
    }
    return false;
}

/**
 * Save pricing to disk cache
 */
async function saveCachedPricing(pricing) {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const payload = {
            lastFetchedAt: Date.now(),
            pricing
        };
        await fs.promises.writeFile(PRICING_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
        logger.error('[Pricing] Failed to save pricing cache:', err.message);
    }
}

/**
 * Fetch real-time model pricing from public repository
 * @param {boolean} [force=false]
 * @returns {Promise<{ success: boolean, count: number, error?: string }>}
 */
export async function fetchLivePricing(force = false) {
    // Avoid re-fetching if fetched less than 1 hour ago unless forced
    if (!force && lastFetchedAt && (Date.now() - lastFetchedAt < 60 * 60 * 1000) && livePricingData) {
        return { success: true, count: Object.keys(livePricingData).length };
    }

    try {
        logger.info('[Pricing] Fetching real-time model pricing from LiteLLM public database...');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(LITELLM_PRICING_URL, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            throw new Error(`HTTP ${res.status} from pricing API`);
        }

        const data = await res.json();
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid JSON payload received from pricing API');
        }

        const count = Object.keys(data).length;
        livePricingData = data;
        lastFetchedAt = Date.now();

        await saveCachedPricing(data);
        logger.info(`[Pricing] Successfully synchronized ${count} model rates from live database`);
        return { success: true, count, lastFetchedAt };
    } catch (err) {
        logger.warn('[Pricing] Live pricing fetch failed, utilizing cached/built-in rates:', err.message);
        return { success: false, count: livePricingData ? Object.keys(livePricingData).length : 0, error: err.message };
    }
}

/**
 * Initialize pricing module
 */
export function initPricing() {
    if (isInitialized) return;
    isInitialized = true;

    loadCachedPricing();

    // If no cache or cache older than 24 hours, fetch in background
    const isStale = !lastFetchedAt || (Date.now() - lastFetchedAt > 24 * 60 * 60 * 1000);
    if (isStale) {
        fetchLivePricing(false).catch(() => {});
    }
}

/**
 * Match a model string to pricing data
 * @param {string} modelName - Raw model identifier (e.g., "claude-opus-4-6-thinking", "claude-3-5-sonnet-20241022")
 * @returns {{ inputCostPerToken: number, outputCostPerToken: number, cacheReadCostPerToken: number, cacheCreationCostPerToken: number, modelMatched: string, source: 'live' | 'baseline' }}
 */
export function getModelPricing(modelName = '') {
    initPricing();

    const normalized = (modelName || '').toLowerCase().trim();
    if (!normalized) {
        return { ...DEFAULT_PRICING_MAP.default, modelMatched: 'default', source: 'baseline' };
    }

    // 1. Direct match in live pricing data if available
    if (livePricingData) {
        if (livePricingData[normalized]) {
            const entry = livePricingData[normalized];
            return extractPricingFromEntry(entry, normalized, 'live');
        }

        // Try stripping common prefixes/suffixes (e.g. anthropic/, google/, -thinking)
        const stripped = normalized
            .replace(/^(anthropic|google|openai)\//, '')
            .replace(/-thinking$/, '');

        if (livePricingData[stripped]) {
            return extractPricingFromEntry(livePricingData[stripped], stripped, 'live');
        }

        // Check keys containing model base in live pricing
        for (const [key, entry] of Object.entries(livePricingData)) {
            const lKey = key.toLowerCase();
            if (normalized.includes('opus') && (lKey.includes('opus-4') || lKey.includes('claude-3-opus') || lKey.includes('opus'))) {
                return extractPricingFromEntry(entry, key, 'live');
            }
            if (normalized.includes('sonnet') && (lKey.includes('sonnet-4') || lKey.includes('claude-3-7-sonnet') || lKey.includes('claude-3-5-sonnet') || lKey.includes('sonnet-5'))) {
                return extractPricingFromEntry(entry, key, 'live');
            }
            if (normalized.includes('haiku') && (lKey.includes('claude-3-5-haiku') || lKey.includes('haiku'))) {
                return extractPricingFromEntry(entry, key, 'live');
            }
            if (normalized.includes('flash') && (lKey.includes('gemini-2.0-flash') || lKey.includes('gemini-1.5-flash') || lKey.includes('flash'))) {
                return extractPricingFromEntry(entry, key, 'live');
            }
            if (normalized.includes('pro') && (lKey.includes('gemini-2.5-pro') || lKey.includes('gemini-1.5-pro') || lKey.includes('pro'))) {
                return extractPricingFromEntry(entry, key, 'live');
            }
        }
    }

    // 2. Built-in tier fallback
    if (normalized.includes('opus')) {
        return { ...DEFAULT_PRICING_MAP.opus, modelMatched: 'Claude Opus (Tier)', source: 'baseline' };
    }
    if (normalized.includes('sonnet')) {
        return { ...DEFAULT_PRICING_MAP.sonnet, modelMatched: 'Claude Sonnet (Tier)', source: 'baseline' };
    }
    if (normalized.includes('haiku')) {
        return { ...DEFAULT_PRICING_MAP.haiku, modelMatched: 'Claude Haiku (Tier)', source: 'baseline' };
    }
    if (normalized.includes('flash')) {
        return { ...DEFAULT_PRICING_MAP['gemini-flash'], modelMatched: 'Gemini Flash (Tier)', source: 'baseline' };
    }
    if (normalized.includes('pro')) {
        return { ...DEFAULT_PRICING_MAP['gemini-pro'], modelMatched: 'Gemini Pro (Tier)', source: 'baseline' };
    }

    return { ...DEFAULT_PRICING_MAP.default, modelMatched: 'Standard Tier', source: 'baseline' };
}

/**
 * Helper to normalize and extract pricing numbers from an entry
 */
function extractPricingFromEntry(entry, matchedKey, source) {
    const input = entry.input_cost_per_token || 0.000003;
    const output = entry.output_cost_per_token || 0.000015;
    const cacheRead = entry.cache_read_input_token_cost !== undefined ? entry.cache_read_input_token_cost : (input * 0.1);
    const cacheWrite = entry.cache_creation_input_token_cost !== undefined ? entry.cache_creation_input_token_cost : (input * 1.25);

    return {
        inputCostPerToken: input,
        outputCostPerToken: output,
        cacheReadCostPerToken: cacheRead,
        cacheCreationCostPerToken: cacheWrite,
        modelMatched: matchedKey,
        source
    };
}

/**
 * Compute the exact cost and prompt caching savings for a token usage event
 * @param {Object} params
 * @param {string} params.model - Model identifier
 * @param {number} [params.inputTokens] - Standard prompt tokens
 * @param {number} [params.cacheTokens] - Prompt cache read tokens
 * @param {number} [params.outputTokens] - Output/generation tokens
 * @returns {{ cost: number, cacheSavings: number, pricing: Object }}
 */
export function calculateUsageCost({ model, inputTokens = 0, cacheTokens = 0, outputTokens = 0 }) {
    const pricing = getModelPricing(model);

    const inCost = (inputTokens || 0) * pricing.inputCostPerToken;
    const cacheCost = (cacheTokens || 0) * pricing.cacheReadCostPerToken;
    const outCost = (outputTokens || 0) * pricing.outputCostPerToken;

    const totalCost = inCost + cacheCost + outCost;

    // What cache read would have cost if billed as normal input tokens
    const uncachedCost = (cacheTokens || 0) * pricing.inputCostPerToken;
    const cacheSavings = Math.max(0, uncachedCost - cacheCost);

    return {
        cost: totalCost,
        cacheSavings,
        pricing
    };
}

/**
 * Get pricing module health status
 */
export function getPricingStatus() {
    initPricing();
    return {
        isLive: !!livePricingData && Object.keys(livePricingData).length > 0,
        totalModels: livePricingData ? Object.keys(livePricingData).length : 0,
        lastFetchedAt,
        source: livePricingData ? 'LiteLLM Public Database' : 'Built-in Provider Baselines'
    };
}

export default {
    fetchLivePricing,
    initPricing,
    getModelPricing,
    calculateUsageCost,
    getPricingStatus
};
