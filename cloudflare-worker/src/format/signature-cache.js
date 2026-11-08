/**
 * In-memory signature cache for Gemini thoughtSignatures & thinking blocks
 */

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MIN_SIGNATURE_LENGTH = 50;

const signatureCache = new Map();
const thinkingSignatureCache = new Map();

export function cacheSignature(toolUseId, signature) {
    if (!toolUseId || !signature) return;
    signatureCache.set(toolUseId, {
        signature,
        timestamp: Date.now()
    });
}

export function getCachedSignature(toolUseId) {
    if (!toolUseId) return null;
    const entry = signatureCache.get(toolUseId);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        signatureCache.delete(toolUseId);
        return null;
    }

    return entry.signature;
}

export function cacheThinkingSignature(signature, modelFamily) {
    if (!signature || signature.length < MIN_SIGNATURE_LENGTH) return;
    thinkingSignatureCache.set(signature, {
        modelFamily,
        timestamp: Date.now()
    });
}

export function getCachedSignatureFamily(signature) {
    if (!signature) return null;
    const entry = thinkingSignatureCache.get(signature);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        thinkingSignatureCache.delete(signature);
        return null;
    }

    return entry.modelFamily;
}

export function clearThinkingSignatureCache() {
    thinkingSignatureCache.clear();
}
