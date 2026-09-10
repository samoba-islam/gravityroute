/**
 * IP-based Access Control Utility
 * Supports IPv4, IPv6, IPv4-mapped IPv6, CIDR ranges, and wildcards.
 */

/**
 * Normalize an IP address string
 * @param {string} ip
 * @returns {string}
 */
export function normalizeIp(ip) {
    if (!ip || typeof ip !== 'string') return '';
    let cleaned = ip.trim();

    // Strip port if formatted as ip:port (for IPv4)
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(cleaned)) {
        cleaned = cleaned.split(':')[0];
    }

    // Strip IPv4-mapped IPv6 prefix (e.g., "::ffff:127.0.0.1" -> "127.0.0.1")
    if (cleaned.startsWith('::ffff:')) {
        cleaned = cleaned.substring(7);
    }

    // Standardize localhost / loopback aliases
    if (cleaned === 'localhost') {
        cleaned = '127.0.0.1';
    }

    return cleaned;
}

/**
 * Check if an IP string is a loopback address
 * @param {string} ip
 * @returns {boolean}
 */
export function isLoopback(ip) {
    const norm = normalizeIp(ip);
    return norm === '127.0.0.1' || norm === '::1' || norm.startsWith('127.');
}

/**
 * Convert an IPv4 string to a 32-bit unsigned integer
 * @param {string} ip
 * @returns {number|null}
 */
function ipv4ToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let num = 0;
    for (let i = 0; i < 4; i++) {
        const byte = parseInt(parts[i], 10);
        if (isNaN(byte) || byte < 0 || byte > 255) return null;
        num = (num << 8) + byte;
    }
    return num >>> 0;
}

/**
 * Match IPv4 address against CIDR range (e.g. 192.168.1.0/24)
 * @param {string} ip
 * @param {string} cidr
 * @returns {boolean}
 */
export function matchCidr(ip, cidr) {
    const [rangeIp, prefixStr] = cidr.split('/');
    if (!rangeIp || !prefixStr) return false;

    const prefix = parseInt(prefixStr, 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;

    const ipInt = ipv4ToInt(normalizeIp(ip));
    const rangeInt = ipv4ToInt(normalizeIp(rangeIp));
    if (ipInt === null || rangeInt === null) return false;

    if (prefix === 0) return true;
    const mask = (~0 << (32 - prefix)) >>> 0;
    return (ipInt & mask) === (rangeInt & mask);
}

/**
 * Match IP against wildcard pattern (e.g. 192.168.1.*)
 * @param {string} ip
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchWildcard(ip, pattern) {
    const normIp = normalizeIp(ip);
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${escaped}$`, 'i');
    return regex.test(normIp);
}

/**
 * Match client IP against a single rule (exact, CIDR, wildcard, or loopback)
 * @param {string} clientIp
 * @param {string} rule
 * @returns {boolean}
 */
export function matchIpRule(clientIp, rule) {
    if (!clientIp || !rule) return false;

    const normClient = normalizeIp(clientIp);
    const normRule = normalizeIp(rule);

    // Loopback interchangeability (::1 and 127.0.0.1 match)
    if (isLoopback(normClient) && isLoopback(normRule)) {
        return true;
    }

    // CIDR notation (e.g., 10.0.0.0/8, 192.168.1.0/24)
    if (rule.includes('/')) {
        return matchCidr(normClient, rule.trim());
    }

    // Wildcard notation (e.g., 192.168.1.*)
    if (rule.includes('*')) {
        return matchWildcard(normClient, rule.trim());
    }

    // Exact string match
    return normClient.toLowerCase() === normRule.toLowerCase();
}

/**
 * Parse an IP list from array or delimited string (newlines, commas, spaces)
 * @param {Array<string>|string} input
 * @returns {Array<string>}
 */
export function parseIpList(input) {
    if (!input) return [];
    if (Array.isArray(input)) {
        return input
            .map(item => normalizeIp(item))
            .filter(Boolean);
    }
    if (typeof input === 'string') {
        return input
            .split(/[\r\n,;]+/)
            .map(item => normalizeIp(item))
            .filter(Boolean);
    }
    return [];
}

/**
 * Evaluate whether an incoming request IP is allowed according to key policy
 * @param {string} clientIp - Client remote IP address
 * @param {Object} policy - Policy configuration
 * @param {boolean} [policy.enabled=false] - Whether IP restriction is enabled
 * @param {'allow'|'deny'} [policy.mode='allow'] - 'allow' (allowlist) or 'deny' (denylist)
 * @param {Array<string>|string} [policy.ipList=[]] - List of IP rules
 * @returns {{ allowed: boolean, reason?: string, clientIp: string, mode: string }}
 */
export function isIpAllowed(clientIp, { enabled = false, mode = 'allow', ipList = [] } = {}) {
    const normClient = normalizeIp(clientIp) || 'unknown';

    // If IP restriction is disabled, all IPs are permitted
    if (!enabled) {
        return { allowed: true, clientIp: normClient, mode };
    }

    const rules = parseIpList(ipList);

    // If enabled with allowlist mode but no rules configured
    if (mode === 'allow' && rules.length === 0) {
        return {
            allowed: false,
            reason: `Access denied: IP restriction is set to Allowlist, but no allowed IPs are configured for this key`,
            clientIp: normClient,
            mode
        };
    }

    // Check match against any configured rule
    const matchesAny = rules.some(rule => matchIpRule(normClient, rule));

    if (mode === 'allow') {
        if (matchesAny) {
            return { allowed: true, clientIp: normClient, mode };
        }
        return {
            allowed: false,
            reason: `Client IP ${normClient} is not authorized for this API key (Allowed: ${rules.join(', ')})`,
            clientIp: normClient,
            mode
        };
    }

    if (mode === 'deny') {
        if (matchesAny) {
            return {
                allowed: false,
                reason: `Client IP ${normClient} is blocked for this API key`,
                clientIp: normClient,
                mode
            };
        }
        return { allowed: true, clientIp: normClient, mode };
    }

    return { allowed: true, clientIp: normClient, mode };
}

export default {
    normalizeIp,
    isLoopback,
    matchCidr,
    matchWildcard,
    matchIpRule,
    parseIpList,
    isIpAllowed
};
