/**
 * Test Suite: API Key Proxy Access with WebUI Authentication Enabled
 * Verifies that enabling WebUI password authentication does NOT block client API calls
 * that use valid API keys, while keeping WebUI administration endpoints secure.
 */

const assert = require('assert');
const http = require('http');

async function runTest() {
    console.log('=== Running API Key & WebUI Auth Integration Test ===\n');

    const express = (await import('express')).default;
    const { mountWebUI } = await import('../src/webui/index.js');
    const { config } = await import('../src/config.js');
    const apiKeyManager = (await import('../src/modules/api-keys.js')).default;
    const { createOpenAiHandlers } = await import('../src/openai/routes.js');

    const originalWebuiAuth = config.webuiAuthEnabled;
    const originalPassword = config.webuiPassword;

    try {
        // Create a test API key
        const testKeyRecord = await apiKeyManager.createKey({
            name: 'Integration Test Key',
            tokenLimit: 0,
            presetDays: 'never'
        });
        const validApiKey = testKeyRecord.key;
        console.log(`Created test API key: ${validApiKey}`);

        // Enable WebUI authentication
        config.webuiAuthEnabled = true;
        config.webuiUsername = 'admin';
        config.webuiPassword = 'TestWebuiPassword123!';

        // Create test app with the same middleware order as src/server.js
        const app = express();
        app.use(express.json());

        // 1. API key authentication middleware (from server.js)
        app.use(['/v1', '/chat/completions', '/models', '/embeddings'], (req, res, next) => {
            const authHeader = req.headers['authorization'];
            const xApiKey = req.headers['x-api-key'];

            let providedKey = '';
            if (authHeader && authHeader.startsWith('Bearer ')) {
                providedKey = authHeader.substring(7);
            } else if (xApiKey) {
                providedKey = xApiKey;
            }

            const hasCustomKeys = apiKeyManager.hasKeys();
            const masterKeyConfigured = !!config.apiKey;

            if (!masterKeyConfigured && !hasCustomKeys) {
                return next();
            }

            if (masterKeyConfigured && providedKey === config.apiKey) {
                return next();
            }

            const isOpenAiReq = req.originalUrl?.includes('chat/completions') || req.originalUrl?.includes('models') || req.originalUrl?.includes('embeddings');

            if (hasCustomKeys && providedKey) {
                const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress;
                const validation = apiKeyManager.validateKey(providedKey, clientIp);
                if (validation.valid) {
                    req.apiKeyRecord = validation.keyRecord;
                    return next();
                } else {
                    const status = validation.status || 401;
                    const errorType = validation.errorType || 'authentication_error';
                    if (isOpenAiReq) {
                        return res.status(status).json({
                            error: {
                                message: validation.reason,
                                type: errorType,
                                param: null,
                                code: status === 401 ? 'invalid_api_key' : 'permission_denied'
                            }
                        });
                    }
                    return res.status(status).json({
                        type: 'error',
                        error: {
                            type: errorType,
                            message: validation.reason
                        }
                    });
                }
            }

            if (isOpenAiReq) {
                return res.status(401).json({
                    error: {
                        message: 'Invalid or missing API key',
                        type: 'authentication_error',
                        param: null,
                        code: 'invalid_api_key'
                    }
                });
            }

            return res.status(401).json({
                type: 'error',
                error: {
                    type: 'authentication_error',
                    message: 'Invalid or missing API key'
                }
            });
        });

        // 2. Mount WebUI
        const mockAccountManager = {
            getStatus: () => ({ total: 1, available: 1, accounts: [] }),
            getAllAccounts: () => [],
            getSettings: () => ({}),
            findCustomProviderForModel: () => null,
            selectAccount: () => ({ account: null }),
            getCustomProviders: () => [{ name: 'custom', enabled: true, models: ['gpt-4o'] }]
        };
        mountWebUI(app, __dirname, mockAccountManager);

        // 3. Mount proxy endpoints
        const openAiHandlers = createOpenAiHandlers({
            accountManager: mockAccountManager,
            ensureInitialized: async () => {},
            fallbackEnabled: false
        });
        app.get('/v1/models', openAiHandlers.handleGetModels);
        app.post('/v1/messages', (req, res) => {
            res.json({ id: 'msg_test123', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hello from proxy' }] });
        });

        // Start server
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, resolve));
        const port = server.address().port;
        const baseUrl = `http://127.0.0.1:${port}`;

        function request(path, options = {}) {
            return new Promise((resolve, reject) => {
                const url = new URL(path, baseUrl);
                const req = http.request(url, {
                    method: options.method || 'GET',
                    headers: options.headers || {}
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        let json = null;
                        try { json = JSON.parse(data); } catch (e) {}
                        resolve({ status: res.statusCode, data, json });
                    });
                });
                req.on('error', reject);
                if (options.body) req.write(JSON.stringify(options.body));
                req.end();
            });
        }

        // Test 1: WebUI Auth is enabled, access to /api/accounts without session token is BLOCKED
        console.log('Test 1: WebUI route /api/accounts blocked without WebUI credentials');
        const res1 = await request('/api/accounts');
        assert.strictEqual(res1.status, 401);
        assert.strictEqual(res1.json?.authRequired, true);
        console.log('  Passed: /api/accounts returned 401 authRequired: true');

        // Test 2: WebUI route /api/accounts with API key is ALSO BLOCKED (API key cannot access WebUI admin)
        console.log('Test 2: WebUI route /api/accounts blocked even with an API key');
        const res2 = await request('/api/accounts', {
            headers: { 'Authorization': `Bearer ${validApiKey}` }
        });
        assert.strictEqual(res2.status, 401);
        assert.strictEqual(res2.json?.authRequired, true);
        console.log('  Passed: API key cannot access administrative WebUI routes');

        // Test 3: Proxy endpoint /v1/models with VALID API key SUCCEEDS (not blocked by WebUI auth)
        console.log('Test 3: Proxy endpoint /v1/models with valid API key');
        const res3 = await request('/v1/models', {
            headers: { 'Authorization': `Bearer ${validApiKey}` }
        });
        assert.strictEqual(res3.status, 200, `Expected 200 but got ${res3.status}: ${res3.data}`);
        assert.strictEqual(res3.json?.object, 'list');
        console.log('  Passed: /v1/models returned 200 with model list');

        // Test 4: Proxy endpoint /v1/messages with VALID API key via x-api-key header SUCCEEDS
        console.log('Test 4: Proxy endpoint /v1/messages with valid API key via x-api-key');
        const res4 = await request('/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': validApiKey
            },
            body: { model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'Hi' }] }
        });
        assert.strictEqual(res4.status, 200, `Expected 200 but got ${res4.status}: ${res4.data}`);
        assert.strictEqual(res4.json?.content[0]?.text, 'Hello from proxy');
        console.log('  Passed: /v1/messages returned 200');

        // Test 5: Proxy endpoint /v1/models with INVALID API key returns OpenAI-formatted 401 (not WebUI authRequired)
        console.log('Test 5: Proxy endpoint /v1/models with invalid API key returns OpenAI 401');
        const res5 = await request('/v1/models', {
            headers: { 'Authorization': 'Bearer sk-invalid-key-123' }
        });
        assert.strictEqual(res5.status, 401);
        assert.strictEqual(res5.json?.error?.code, 'invalid_api_key');
        assert.strictEqual(res5.json?.authRequired, undefined);
        console.log('  Passed: /v1/models returned OpenAI error schema for invalid key');

        // Test 6: Proxy endpoint /v1/messages with INVALID API key returns Anthropic-formatted 401
        console.log('Test 6: Proxy endpoint /v1/messages with invalid API key returns Anthropic 401');
        const res6 = await request('/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'sk-invalid-key-123'
            },
            body: { model: 'claude-3-5-sonnet-20241022', messages: [] }
        });
        assert.strictEqual(res6.status, 401);
        assert.strictEqual(res6.json?.type, 'error');
        assert.strictEqual(res6.json?.error?.type, 'authentication_error');
        assert.strictEqual(res6.json?.authRequired, undefined);
        console.log('  Passed: /v1/messages returned Anthropic error schema for invalid key');

        // Cleanup
        await apiKeyManager.deleteKey(testKeyRecord.id);
        server.close();
        console.log('\n=== ALL API KEY & WEBUI AUTH INTEGRATION TESTS PASSED! ===\n');
    } finally {
        config.webuiAuthEnabled = originalWebuiAuth;
        config.webuiPassword = originalPassword;
    }
}

runTest().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
