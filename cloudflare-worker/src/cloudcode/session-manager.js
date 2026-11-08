/**
 * Session Manager for Cloud Code in Cloudflare Worker
 */

const sessionMap = new Map();

export function deriveSessionId(anthropicRequest, accountEmail) {
    if (!accountEmail) {
        return crypto.randomUUID() + Date.now().toString();
    }

    if (sessionMap.has(accountEmail)) {
        return sessionMap.get(accountEmail);
    }

    const newId = crypto.randomUUID() + Date.now().toString();
    sessionMap.set(accountEmail, newId);
    return newId;
}
