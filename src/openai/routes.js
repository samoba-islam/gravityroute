/**
 * OpenAI Routes Handler
 * Implements /v1/chat/completions, /v1/models, and helper endpoints matching OpenAI API specifications.
 */

import { logger } from '../utils/logger.js';
import { openAiToAnthropic, anthropicToOpenAi, OpenAiStreamTransformer } from './converter.js';
import { resolveOpenAiModel } from './model-mapper.js';
import { sendMessage, sendMessageStream, listModels, isValidModel } from '../cloudcode/index.js';
import apiKeyManager from '../modules/api-keys.js';
import { forceRefresh } from '../auth/token-extractor.js';
import { dispatchChatCompletionsRequest } from '../providers/custom-dispatcher.js';

/**
 * Format error in standard OpenAI error schema
 */
export function formatOpenAiError(message, type = 'invalid_request_error', code = null, param = null) {
    return {
        error: {
            message: String(message || 'An error occurred during request processing'),
            type,
            param,
            code
        }
    };
}

/**
 * Parse upstream error into OpenAI error parameters
 */
function parseOpenAiError(error) {
    const rawMsg = error?.message || 'Unknown error';
    let statusCode = 500;
    let errorType = 'api_error';
    let code = null;

    if (rawMsg.includes('RESOURCE_EXHAUSTED') || rawMsg.includes('429') || rawMsg.includes('Rate limit')) {
        statusCode = 429;
        errorType = 'rate_limit_error';
        code = 'rate_limit_exceeded';
    } else if (rawMsg.includes('UNAUTHENTICATED') || rawMsg.includes('401') || rawMsg.includes('invalid token')) {
        statusCode = 401;
        errorType = 'authentication_error';
        code = 'invalid_api_key';
    } else if (rawMsg.includes('PERMISSION_DENIED') || rawMsg.includes('403') || rawMsg.includes('forbidden')) {
        statusCode = 403;
        errorType = 'permission_error';
        code = 'permission_denied';
    } else if (rawMsg.includes('invalid_request_error') || rawMsg.includes('Invalid model') || rawMsg.includes('400')) {
        statusCode = 400;
        errorType = 'invalid_request_error';
    } else if (rawMsg.includes('No accounts available') || rawMsg.includes('503')) {
        statusCode = 503;
        errorType = 'service_unavailable';
        code = 'no_accounts_available';
    }

    return { statusCode, errorType, code, message: rawMsg };
}

/**
 * Create route handlers with injected server dependencies
 */
export function createOpenAiHandlers({ accountManager, ensureInitialized, fallbackEnabled = false }) {
    return {
        /**
         * POST /v1/chat/completions (and /chat/completions)
         */
        async handleChatCompletions(req, res) {
            try {
                await ensureInitialized();

                const { messages, model } = req.body;

                if (!messages || !Array.isArray(messages) || messages.length === 0) {
                    return res.status(400).json(formatOpenAiError(
                        "'messages' is a required property and must be a non-empty array",
                        'invalid_request_error',
                        null,
                        'messages'
                    ));
                }

                // Resolve model (supports both OpenAI aliases like gpt-4o and native model IDs like claude-sonnet-4-6)
                const requestedModel = model || 'gpt-4o';

                // Check if model targets a custom provider ({provider_name}-{model_name} or direct rawModel)
                const customMatch = accountManager.findCustomProviderForModel(requestedModel);
                const targetModel = !customMatch ? resolveOpenAiModel(requestedModel) : requestedModel;

                // Check API key model access permissions before proceeding
                if (req.apiKeyRecord?.modelRestrictionEnabled) {
                    const checkReq = apiKeyManager.isModelAllowed(req.apiKeyRecord, requestedModel);
                    const checkRaw = customMatch ? apiKeyManager.isModelAllowed(req.apiKeyRecord, customMatch.rawModel) : { allowed: false };
                    const checkTarget = apiKeyManager.isModelAllowed(req.apiKeyRecord, targetModel);
                    if (!checkReq.allowed && !checkRaw.allowed && !checkTarget.allowed) {
                        logger.warn(`[APIKeys] Key "${req.apiKeyRecord.name}" (${req.apiKeyRecord.id}) blocked from calling model "${requestedModel}"`);
                        return res.status(403).json(formatOpenAiError(
                            checkReq.reason || `Model '${requestedModel}' is not allowed for this API key. Allowed models: ${(req.apiKeyRecord.allowedModels || []).join(', ')}`,
                            'permission_error',
                            'model_not_allowed',
                            'model'
                        ));
                    }
                }

                if (customMatch) {
                    return await dispatchChatCompletionsRequest(
                        customMatch.provider,
                        customMatch.rawModel,
                        req.body,
                        res,
                        accountManager
                    );
                }

                // Check model validity against active accounts
                const { account: validationAccount } = accountManager.selectAccount();
                if (validationAccount) {
                    const token = await accountManager.getTokenForAccount(validationAccount);
                    const projectId = validationAccount.subscription?.projectId || null;
                    const valid = await isValidModel(targetModel, token, projectId);

                    if (!valid) {
                        return res.status(400).json(formatOpenAiError(
                            `The model '${requestedModel}' (resolved to '${targetModel}') does not exist or is not supported. Use /v1/models to see available models.`,
                            'invalid_request_error',
                            'model_not_found',
                            'model'
                        ));
                    }
                }

                // Optimistic retry if all accounts are rate-limited for target model
                if (accountManager.isAllRateLimited(targetModel)) {
                    logger.warn(`[OpenAI-API] All accounts rate-limited for ${targetModel}. Resetting state for optimistic retry.`);
                    accountManager.resetAllRateLimits();
                }

                // Convert OpenAI request body to Anthropic Messages format
                const anthropicRequest = openAiToAnthropic(req.body, targetModel);

                logger.info(`[OpenAI-API] Request for model: ${requestedModel} -> ${targetModel}, stream: ${!!req.body.stream}`);

                if (req.body.stream) {
                    // Streaming Response
                    const transformer = new OpenAiStreamTransformer(requestedModel, req.body.stream_options);

                    try {
                        const generator = sendMessageStream(anthropicRequest, accountManager, fallbackEnabled);

                        // Buffer first event before sending headers to catch immediate errors
                        const firstResult = await generator.next();

                        res.status(200);
                        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                        res.setHeader('Cache-Control', 'no-cache');
                        res.setHeader('Connection', 'keep-alive');
                        res.setHeader('X-Accel-Buffering', 'no');
                        res.flushHeaders();

                        // Write first event
                        if (!firstResult.done && firstResult.value) {
                            const initialChunks = transformer.transformEvent(firstResult.value);
                            for (const chunk of initialChunks) {
                                res.write(chunk);
                            }
                            if (res.flush) res.flush();
                        }

                        // Stream rest of generator
                        for await (const event of generator) {
                            const chunks = transformer.transformEvent(event);
                            for (const chunk of chunks) {
                                res.write(chunk);
                            }
                            if (res.flush) res.flush();
                        }

                        // Record token usage for API key
                        if (req.apiKeyRecord) {
                            apiKeyManager.recordDetailedUsage({
                                keyId: req.apiKeyRecord.id,
                                model: targetModel,
                                inputTokens: transformer.inputTokens,
                                cacheTokens: transformer.cacheTokens,
                                outputTokens: transformer.outputTokens
                            });
                        }

                        res.end();
                    } catch (streamError) {
                        if (!res.headersSent) {
                            logger.error('[OpenAI-API] Initial stream error:', streamError);
                            const parsed = parseOpenAiError(streamError);
                            return res.status(parsed.statusCode).json(formatOpenAiError(
                                parsed.message,
                                parsed.errorType,
                                parsed.code
                            ));
                        }

                        logger.error('[OpenAI-API] Mid-stream error:', streamError);
                        const parsed = parseOpenAiError(streamError);
                        res.write(`data: ${JSON.stringify(formatOpenAiError(parsed.message, parsed.errorType, parsed.code))}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    }
                } else {
                    // Non-streaming Response
                    const anthropicResponse = await sendMessage(anthropicRequest, accountManager, fallbackEnabled);
                    const openAiResponse = anthropicToOpenAi(anthropicResponse, requestedModel);

                    // Record token usage
                    if (req.apiKeyRecord) {
                        const usage = anthropicResponse.usage || {};
                        const inputTokens = usage.input_tokens || 0;
                        const outputTokens = usage.output_tokens || 0;
                        const cacheTokens = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);

                        apiKeyManager.recordDetailedUsage({
                            keyId: req.apiKeyRecord.id,
                            model: targetModel,
                            inputTokens,
                            cacheTokens,
                            outputTokens
                        });
                    }

                    res.json(openAiResponse);
                }
            } catch (error) {
                logger.error('[OpenAI-API] Request error:', error);
                const parsed = parseOpenAiError(error);

                // Token refresh attempt on auth error
                if (parsed.errorType === 'authentication_error') {
                    try {
                        accountManager.clearProjectCache();
                        accountManager.clearTokenCache();
                        await forceRefresh();
                    } catch (refreshErr) {
                        logger.warn('[OpenAI-API] Token refresh failed:', refreshErr.message);
                    }
                }

                res.status(parsed.statusCode).json(formatOpenAiError(
                    parsed.message,
                    parsed.errorType,
                    parsed.code
                ));
            }
        },

        /**
         * GET /v1/models and GET /models
         * Returns models matching Anthropic compatibility list plus enabled custom provider models
         */
        async handleGetModels(req, res) {
            try {
                await ensureInitialized();
                let models = [];

                let account = accountManager.getAllAccounts().find(a => a.source !== 'custom' && !a.isInvalid);
                if (!account) {
                    const sel = accountManager.selectAccount();
                    account = sel?.account;
                }
                if (account && account.source !== 'custom') {
                    try {
                        const token = await accountManager.getTokenForAccount(account);
                        const nativeResult = await listModels(token);
                        models = nativeResult?.data ? [...nativeResult.data] : [];
                    } catch (err) {
                        logger.warn(`[OpenAI-API] Failed to fetch native models: ${err.message}`);
                    }
                }

                // Append models from enabled custom providers
                const customProviders = (accountManager.getCustomProviders?.() || []).filter(p => p.enabled !== false);
                for (const provider of customProviders) {
                    for (const rawModel of (provider.models || [])) {
                        const fullId = `${provider.name}-${rawModel}`;

                        // Check if the current API key explicitly allowed the raw model name (without provider prefix)
                        const userAllowedRaw = req.apiKeyRecord?.modelRestrictionEnabled &&
                            Array.isArray(req.apiKeyRecord.allowedModels) &&
                            req.apiKeyRecord.allowedModels.some(a => a.toLowerCase().trim() === rawModel.toLowerCase().trim());

                        // If user specifically configured rawModel, add rawModel. Otherwise add fullId.
                        const modelIdToAdd = userAllowedRaw ? rawModel : fullId;

                        if (!models.some(m => m.id === modelIdToAdd)) {
                            models.push({
                                id: modelIdToAdd,
                                object: 'model',
                                created: Math.floor(Date.now() / 1000),
                                owned_by: provider.name
                            });
                        }
                    }
                }

                if (models.length === 0 && !account) {
                    return res.status(503).json(formatOpenAiError('No accounts or custom providers available', 'service_unavailable'));
                }

                // Filter models based on API key permissions if restricted
                if (req.apiKeyRecord?.modelRestrictionEnabled && Array.isArray(req.apiKeyRecord.allowedModels) && req.apiKeyRecord.allowedModels.length > 0) {
                    models = models.filter(m => apiKeyManager.isModelAllowed(req.apiKeyRecord, m.id).allowed);
                }

                res.json({
                    object: 'list',
                    data: models
                });
            } catch (error) {
                logger.error('[OpenAI-API] Error listing models:', error);
                res.status(500).json(formatOpenAiError(error.message, 'api_error'));
            }
        },

        /**
         * GET /v1/models/:model and GET /models/:model
         */
        async handleGetSingleModel(req, res) {
            try {
                await ensureInitialized();
                const requestedId = Array.isArray(req.params.model) ? req.params.model.join('/') : (req.params.model || req.params[0]);

                // Check API key model permission
                if (req.apiKeyRecord?.modelRestrictionEnabled) {
                    const check = apiKeyManager.isModelAllowed(req.apiKeyRecord, requestedId);
                    if (!check.allowed) {
                        return res.status(403).json(formatOpenAiError(
                            check.reason || `Model '${requestedId}' is not allowed for this API key.`,
                            'permission_error',
                            'model_not_allowed',
                            'model'
                        ));
                    }
                }

                // Check custom providers first
                const customProviders = (accountManager.getCustomProviders?.() || []).filter(p => p.enabled !== false);
                for (const provider of customProviders) {
                    for (const rawModel of (provider.models || [])) {
                        const fullId = `${provider.name}-${rawModel}`;
                        if (fullId === requestedId || rawModel === requestedId) {
                            return res.json({
                                id: requestedId,
                                object: 'model',
                                created: Math.floor(Date.now() / 1000),
                                owned_by: provider.name
                            });
                        }
                    }
                }

                const { account } = accountManager.selectAccount();
                if (!account) {
                    return res.status(503).json(formatOpenAiError('No accounts available', 'service_unavailable'));
                }

                const token = await accountManager.getTokenForAccount(account);
                const nativeResult = await listModels(token);
                const models = nativeResult?.data || [];

                const found = models.find(m => m.id === requestedId);

                if (!found) {
                    return res.status(404).json(formatOpenAiError(
                        `The model '${requestedId}' does not exist`,
                        'invalid_request_error',
                        'model_not_found',
                        'model'
                    ));
                }

                res.json(found);
            } catch (error) {
                logger.error('[OpenAI-API] Error retrieving model:', error);
                res.status(500).json(formatOpenAiError(error.message, 'api_error'));
            }
        },

        /**
         * POST /v1/embeddings
         */
        handleEmbeddings(req, res) {
            res.status(501).json(formatOpenAiError(
                'Embeddings endpoint is not supported by Antigravity proxy. Please configure your client to use an embedding-specific model/provider.',
                'invalid_request_error',
                'unsupported_endpoint'
            ));
        }
    };
}

export default {
    formatOpenAiError,
    createOpenAiHandlers
};
