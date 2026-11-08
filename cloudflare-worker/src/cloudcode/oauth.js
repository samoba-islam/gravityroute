/**
 * Google OAuth Management for Cloudflare Worker
 */

import { OAUTH_CONFIG, TOKEN_REFRESH_INTERVAL_MS } from '../constants.js';

// Global in-memory cache for access tokens per account (survives across warm requests)
const tokenCache = new Map();

export function parseRefreshParts(refresh) {
    const [refreshToken = '', projectId = '', managedProjectId = ''] = (refresh ?? '').split('|');
    return {
        refreshToken,
        projectId: projectId || undefined,
        managedProjectId: managedProjectId || undefined,
    };
}

export function formatRefreshParts(parts) {
    const projectSegment = parts.projectId ?? '';
    const base = `${parts.refreshToken}|${projectSegment}`;
    return parts.managedProjectId ? `${base}|${parts.managedProjectId}` : base;
}

export async function refreshAccessToken(compositeRefresh) {
    const parts = parseRefreshParts(compositeRefresh);

    const res = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            client_id: OAUTH_CONFIG.clientId,
            client_secret: OAUTH_CONFIG.clientSecret,
            refresh_token: parts.refreshToken,
            grant_type: 'refresh_token'
        })
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Google OAuth refresh failed: ${res.status} ${errorText}`);
    }

    const data = await res.json();
    return {
        accessToken: data.access_token,
        expiresIn: data.expires_in || 3600
    };
}

export async function getCachedAccessToken(account) {
    const cacheKey = account.id || account.email;
    const cached = tokenCache.get(cacheKey);

    if (cached && (Date.now() - cached.extractedAt) < TOKEN_REFRESH_INTERVAL_MS) {
        return cached.token;
    }

    const rawRefresh = account.refreshToken || account.refresh_token;
    if (!rawRefresh) {
        throw new Error('No refresh token available for account');
    }
    const { accessToken } = await refreshAccessToken(rawRefresh);

    tokenCache.set(cacheKey, {
        token: accessToken,
        extractedAt: Date.now()
    });

    return accessToken;
}

export async function getUserEmail(accessToken) {
    const res = await fetch(OAUTH_CONFIG.userInfoUrl, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch user info: ${res.status}`);
    }

    const info = await res.json();
    return info.email;
}

export function base64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        str += String.fromCharCode(bytes[i]);
    }
    return btoa(str)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export async function generatePKCE() {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    const verifier = base64url(randomBytes);

    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const challenge = base64url(hash);

    return { verifier, challenge };
}

export async function getAuthorizationUrl(customRedirectUri = null) {
    const { verifier, challenge } = await generatePKCE();
    const state = crypto.randomUUID();
    const redirectUri = customRedirectUri || 'http://localhost:51121/oauth-callback';

    const params = new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: OAUTH_CONFIG.scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: state
    });

    return {
        url: `${OAUTH_CONFIG.authUrl}?${params.toString()}`,
        verifier,
        state
    };
}

export async function exchangeAuthCode(code, redirectUri = 'http://localhost:51121/oauth-callback', verifier = null) {
    const bodyParams = {
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
    };

    if (verifier) {
        bodyParams.code_verifier = verifier;
    }

    const res = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(bodyParams)
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Token exchange failed: ${err}`);
    }

    const data = await res.json();
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in
    };
}
