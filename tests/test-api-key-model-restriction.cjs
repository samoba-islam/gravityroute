const assert = require('assert');
const http = require('http');

async function request(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    parsed = data;
                }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        if (postData) {
            req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
        }
        req.end();
    });
}

async function runTests() {
    console.log('=== Testing API Key Model Access Control ===');

    // 1. Unit Test ApiKeyManager logic
    const { default: mgr } = await import('../src/modules/api-keys.js');
    const { config } = await import('../src/config.js');
    const webuiHeaders = config.webuiPassword ? { 'x-webui-password': config.webuiPassword } : {};

    // Test unrestricted key
    const unrestrictedKey = {
        id: 'test_unrestricted',
        modelRestrictionEnabled: false,
        allowedModels: []
    };
    assert.strictEqual(mgr.isModelAllowed(unrestrictedKey, 'claude-sonnet-4-6').allowed, true);
    assert.strictEqual(mgr.isModelAllowed(unrestrictedKey, 'gemini-2.5-pro').allowed, true);
    console.log('✔ Unrestricted key allows all models');

    // Test restricted key with exact and wildcard models
    const restrictedKey = {
        id: 'test_restricted',
        modelRestrictionEnabled: true,
        allowedModels: ['claude-sonnet-4-6', 'gemini-2.5-*', 'custom-provider/*']
    };
    assert.strictEqual(mgr.isModelAllowed(restrictedKey, 'claude-sonnet-4-6').allowed, true);
    assert.strictEqual(mgr.isModelAllowed(restrictedKey, 'CLAUDE-SONNET-4-6').allowed, true); // case insensitive
    assert.strictEqual(mgr.isModelAllowed(restrictedKey, 'gemini-2.5-pro').allowed, true);
    assert.strictEqual(mgr.isModelAllowed(restrictedKey, 'gemini-2.5-flash').allowed, true);
    assert.strictEqual(mgr.isModelAllowed(restrictedKey, 'custom-provider/gpt-4o').allowed, true);

    const blockedOpus = mgr.isModelAllowed(restrictedKey, 'claude-opus-4-6-thinking');
    assert.strictEqual(blockedOpus.allowed, false);
    assert.ok(blockedOpus.reason.includes('not allowed'));

    const blockedGemini3 = mgr.isModelAllowed(restrictedKey, 'gemini-3.1-pro-high');
    assert.strictEqual(blockedGemini3.allowed, false);
    console.log('✔ Restricted key enforces exact & wildcard match logic');

    // 2. Test Live WebUI Endpoints
    console.log('\n--- Testing Live Proxy Server Endpoints ---');

    // Test GET /api/keys returns availableModels
    const keysRes = await request({
        hostname: 'localhost',
        port: 8080,
        path: '/api/keys',
        method: 'GET',
        headers: { ...webuiHeaders }
    });
    assert.strictEqual(keysRes.status, 200);
    assert.ok(Array.isArray(keysRes.body.availableModels), 'availableModels must be an array');
    assert.ok(keysRes.body.availableModels.length > 0, 'availableModels must not be empty');
    assert.ok(keysRes.body.availableModels.includes('claude-sonnet-4-6'), 'must contain standard models');
    console.log(`✔ GET /api/keys returned ${keysRes.body.availableModels.length} available models`);

    // Create a restricted test API key via POST /api/keys
    const createRes = await request({
        hostname: 'localhost',
        port: 8080,
        path: '/api/keys',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...webuiHeaders }
    }, {
        name: 'Model Restriction Test Key',
        modelRestrictionEnabled: true,
        allowedModels: ['claude-sonnet-4-6', 'gemini-2.5-flash']
    });
    assert.ok(createRes.status === 200 || createRes.status === 201, `Expected 200 or 201, got ${createRes.status}`);
    assert.ok(createRes.body.key, 'Created key must be returned');
    assert.strictEqual(createRes.body.key.modelRestrictionEnabled, true);
    assert.deepStrictEqual(createRes.body.key.allowedModels, ['claude-sonnet-4-6', 'gemini-2.5-flash']);
    const testKeySecret = createRes.body.key.key;
    const testKeyId = createRes.body.key.id;
    console.log(`✔ Created restricted key with secret: ${testKeySecret.substring(0, 15)}... (id: ${testKeyId})`);

    try {
        // 3. Test /v1/messages with unauthorized model -> Should get HTTP 403
        const forbiddenMessagesRes = await request({
            hostname: 'localhost',
            port: 8080,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': testKeySecret,
                'anthropic-version': '2023-06-01'
            }
        }, {
            model: 'claude-opus-4-6-thinking',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'Hello' }]
        });
        assert.strictEqual(forbiddenMessagesRes.status, 403, `Expected 403 for forbidden model in /v1/messages, got ${forbiddenMessagesRes.status}`);
        assert.strictEqual(forbiddenMessagesRes.body.type, 'error');
        assert.strictEqual(forbiddenMessagesRes.body.error.type, 'permission_error');
        assert.ok(forbiddenMessagesRes.body.error.message.includes('not allowed'), 'Error message mentions model not allowed');
        console.log(`✔ /v1/messages blocked forbidden model with 403 permission_error: ${forbiddenMessagesRes.body.error.message}`);

        // 4. Test /v1/messages/count_tokens with unauthorized model -> Should get HTTP 403
        const forbiddenTokensRes = await request({
            hostname: 'localhost',
            port: 8080,
            path: '/v1/messages/count_tokens',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': testKeySecret,
                'anthropic-version': '2023-06-01'
            }
        }, {
            model: 'claude-opus-4-6-thinking',
            messages: [{ role: 'user', content: 'Hello' }]
        });
        assert.strictEqual(forbiddenTokensRes.status, 403, `Expected 403 for /v1/messages/count_tokens, got ${forbiddenTokensRes.status}`);
        console.log('✔ /v1/messages/count_tokens blocked forbidden model with 403');

        // 5. Test /v1/chat/completions with unauthorized model -> Should get HTTP 403
        const forbiddenChatRes = await request({
            hostname: 'localhost',
            port: 8080,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${testKeySecret}`
            }
        }, {
            model: 'claude-opus-4-6-thinking',
            messages: [{ role: 'user', content: 'Hello' }]
        });
        assert.strictEqual(forbiddenChatRes.status, 403, `Expected 403 for /v1/chat/completions, got ${forbiddenChatRes.status}`);
        assert.strictEqual(forbiddenChatRes.body.error.type, 'permission_error');
        assert.strictEqual(forbiddenChatRes.body.error.code, 'model_not_allowed');
        console.log('✔ /v1/chat/completions blocked forbidden model with 403 permission_error model_not_allowed');

        // 6. Test GET /v1/models with restricted key -> Should ONLY list the 2 allowed models
        const modelsRes = await request({
            hostname: 'localhost',
            port: 8080,
            path: '/v1/models',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${testKeySecret}`
            }
        });
        assert.strictEqual(modelsRes.status, 200);
        assert.ok(Array.isArray(modelsRes.body.data), 'models response must contain data array');
        const returnedIds = modelsRes.body.data.map(m => m.id);
        console.log('✔ /v1/models filtered models for restricted key. Returned:', returnedIds);
        assert.ok(returnedIds.includes('claude-sonnet-4-6'), 'Must contain allowed claude-sonnet-4-6');
        assert.ok(!returnedIds.includes('claude-opus-4-6-thinking'), 'Must NOT contain blocked claude-opus-4-6-thinking');

        // 7. Test PATCH /api/keys/:id to update allowed models
        const updateRes = await request({
            hostname: 'localhost',
            port: 8080,
            path: `/api/keys/${testKeyId}`,
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...webuiHeaders }
        }, {
            modelRestrictionEnabled: true,
            allowedModels: ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']
        });
        assert.strictEqual(updateRes.status, 200);
        assert.deepStrictEqual(updateRes.body.key.allowedModels, ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']);
        console.log('✔ PATCH /api/keys/:id successfully updated allowed models');

        // Now verify that claude-opus-4-6-thinking is now allowed in /v1/models
        const updatedModelsRes = await request({
            hostname: 'localhost',
            port: 8080,
            path: '/v1/models',
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${testKeySecret}`
            }
        });
        const updatedReturnedIds = updatedModelsRes.body.data.map(m => m.id);
        assert.ok(updatedReturnedIds.includes('claude-opus-4-6-thinking'), 'claude-opus-4-6-thinking should now be in allowed models');
        console.log('✔ /v1/models reflects newly updated permissions');

    } finally {
        // Clean up test key
        await request({
            hostname: 'localhost',
            port: 8080,
            path: `/api/keys/${testKeyId}`,
            method: 'DELETE',
            headers: { ...webuiHeaders }
        });
        console.log(`✔ Cleaned up test key ${testKeyId}`);
    }

    console.log('\nALL MODEL RESTRICTION TESTS PASSED SUCCESSFULLY! 🎉');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
