/**
 * Constants for Cloudflare Worker GravityRoute
 */

export const ANTIGRAVITY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com';

export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
    ANTIGRAVITY_ENDPOINT_DAILY,
    ANTIGRAVITY_ENDPOINT_PROD
];

export const LOAD_CODE_ASSIST_ENDPOINTS = [
    ANTIGRAVITY_ENDPOINT_PROD,
    ANTIGRAVITY_ENDPOINT_DAILY
];

export const SYSTEM_MODELS = [
    'claude-3-7-sonnet',
    'claude-3-5-sonnet',
    'claude-3-5-haiku',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
];

export const CLIENT_VERSION = '1.10.0';
export const USER_AGENT = 'antigravity/1.10.0 darwin/arm64';

export const ANTIGRAVITY_HEADERS = {
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
    'X-Client-Name': 'antigravity',
    'X-Client-Version': CLIENT_VERSION,
    'x-goog-api-client': 'gl-node/18.18.2 fire/0.8.6 grpc/1.10.x'
};

export const LOAD_CODE_ASSIST_HEADERS = ANTIGRAVITY_HEADERS;

export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';
export const TOKEN_REFRESH_INTERVAL_MS = 50 * 60 * 1000; // 50 mins

export const MIN_SIGNATURE_LENGTH = 50;
export const GEMINI_MAX_OUTPUT_TOKENS = 16384;
export const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';

export const OAUTH_CONFIG = {
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    clientSecret: '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',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo',
    scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/cclog',
        'https://www.googleapis.com/auth/experimentsandconfigs'
    ]
};

export const OAUTH_REDIRECT_URI = 'http://localhost:51121/oauth-callback';

export const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**`;

export const MODEL_FALLBACK_MAP = {
    'gemini-3.1-pro-high': 'gemini-3.1-pro-low',
    'gemini-3-pro-high': 'gemini-3.1-pro-low',
    'claude-opus-4-6-thinking': 'claude-sonnet-4-6',
    'gemini-2.5-pro': 'gemini-2.5-flash-thinking',
    'claude-3-7-sonnet': 'claude-sonnet-4-6',
    'claude-3-7-sonnet-thinking': 'claude-sonnet-4-6',
    'claude-3-5-sonnet': 'claude-sonnet-4-6',
    'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
    'claude-3-5-haiku': 'gemini-2.5-flash'
};

export function getModelFamily(modelName) {
    const lower = (modelName || '').toLowerCase();
    if (lower.includes('claude')) return 'claude';
    if (lower.includes('gemini')) return 'gemini';
    return 'unknown';
}

export function isThinkingModel(modelName) {
    const lower = (modelName || '').toLowerCase();
    if (lower.includes('claude') && lower.includes('thinking')) return true;
    if (lower.includes('gemini')) {
        if (lower.includes('thinking')) return true;
        const versionMatch = lower.match(/gemini-(\d+)/);
        if (versionMatch && parseInt(versionMatch[1], 10) >= 3) return true;
    }
    return false;
}
