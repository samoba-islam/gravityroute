/**
 * Test Suite: Custom Providers (OpenAI & Anthropic Compatible)
 * Run: node tests/test-custom-providers.mjs
 */
import http from 'http';
import { config, loadConfig } from '../src/config.js';
import AccountManager from '../src/account-manager/index.js';
import { anthropicRequestToOpenAi } from '../src/providers/custom-dispatcher.js';
import apiKeyManager from '../src/modules/api-keys.js';

loadConfig();

const accountManager = new AccountManager();
const proxyKeys = apiKeyManager.hasKeys() ? apiKeyManager.getAllKeys().filter(k => k.status === 'active') : [];
const testApiKey = proxyKeys.length > 0 ? proxyKeys[0].key : null;

const PORT = process.env.PORT || config.port || 8080;
const BASE_URL = `http://localhost:${PORT}`;

let authToken = null;
let authHeaders = {};

if (config.webuiAuthEnabled) {
    if (config.webuiPassword) {
        authHeaders['x-webui-password'] = config.webuiPassword;
    }
}

function makeRequest(path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const headers = {
            'Content-Type': 'application/json',
            ...authHeaders,
            ...(options.headers || {})
        };

        if (authToken && !options.headers?.['Authorization'] && !options.headers?.['x-api-key']) {
            headers['Authorization'] = `Bearer ${authToken}`;
        }

        const reqOptions = {
            method: options.method || 'GET',
            headers
        };

        const req = http.request(url, reqOptions, (res) => {
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

        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

async function runTests() {
    console.log('=== RUNNING CUSTOM PROVIDER TEST SUITE ===');
    let passed = 0;
    let failed = 0;

    const assert = (condition, name, details = '') => {
        if (condition) {
            console.log(`  [PASS] ${name}`);
            passed++;
        } else {
            console.error(`  [FAIL] ${name} ${details ? '- ' + details : ''}`);
            failed++;
        }
    };

    try {
        // Step 0: Login if WebUI auth is enabled
        if (config.webuiAuthEnabled) {
            console.log('\n0. Logging into WebUI to acquire session token');
            const loginRes = await makeRequest('/api/auth/login', {
                method: 'POST',
                body: {
                    username: config.webuiUsername || 'admin',
                    password: config.webuiPassword || ''
                }
            });
            if (loginRes.status === 200 && loginRes.body?.token) {
                authToken = loginRes.body.token;
                console.log('  [PASS] Successfully authenticated with WebUI');
            } else {
                console.log('  [WARN] Login did not return token, falling back to x-webui-password header');
            }
        }

        // Test 1: Create custom OpenAI provider
        console.log('\n1. Creating Custom OpenAI Provider: deepseek-test');
        const createRes = await makeRequest('/api/providers/custom', {
            method: 'POST',
            body: {
                name: 'deepseek-test',
                type: 'openai',
                baseUrl: 'https://api.deepseek.com/v1',
                apiKey: 'sk-test-mock-key-12345',
                models: ['deepseek-chat', 'deepseek-coder'],
                quotaType: 'dollar',
                initialBalance: 10.0,
                pricing: {
                    inputPricePerM: 0.14,
                    outputPricePerM: 0.28,
                    cachePricePerM: 0.014
                }
            }
        });

        assert(createRes.status === 200 && createRes.body?.status === 'ok', 'Provider created successfully', JSON.stringify(createRes.body));
        assert(createRes.body?.provider?.name === 'deepseek-test', 'Provider name is deepseek-test');
        assert(createRes.body?.provider?.models?.length === 2, 'Provider has 2 registered models');

        // Test 2: Check /account-limits exposes custom provider and models
        console.log('\n2. Verifying /account-limits metadata');
        const limitsRes = await makeRequest('/account-limits');
        assert(limitsRes.status === 200, '/account-limits returns 200', `Got ${limitsRes.status}`);
        
        const accounts = limitsRes.body?.accounts || [];
        const customAcc = accounts.find(a => a.name === 'deepseek-test' || a.email?.includes('deepseek-test'));
        assert(Boolean(customAcc), 'Found custom account in /account-limits');
        assert(customAcc?.source === 'custom', 'Account source is custom');
        assert(customAcc?.models?.includes('deepseek-chat'), 'Registered model deepseek-chat exists in models array');
        assert(customAcc?.initialBalance === 10, 'Initial balance is $10.00');

        // Test 3: Check /v1/models includes custom models with provider prefix
        console.log('\n3. Verifying /v1/models exposes {provider}-{model}');
        const modelsHeaders = testApiKey ? { 'Authorization': `Bearer ${testApiKey}` } : {};
        const modelsRes = await makeRequest('/v1/models', { headers: modelsHeaders });
        assert(modelsRes.status === 200, '/v1/models returns 200', `Got ${modelsRes.status}`);
        const modelList = modelsRes.body?.data || [];
        const chatModel = modelList.find(m => m.id === 'deepseek-test-deepseek-chat');
        const coderModel = modelList.find(m => m.id === 'deepseek-test-deepseek-coder');
        assert(Boolean(chatModel), 'deepseek-test-deepseek-chat appears in /v1/models');
        assert(Boolean(coderModel), 'deepseek-test-deepseek-coder appears in /v1/models');

        // Test 4: Top up balance via PATCH /api/providers/custom/:name
        console.log('\n4. Testing Top-Up & Settings Update via PATCH');
        const patchRes = await makeRequest('/api/providers/custom/deepseek-test', {
            method: 'PATCH',
            body: {
                topUpBalance: 5.0,
                pricing: {
                    inputPricePerM: 0.15,
                    outputPricePerM: 0.30,
                    cachePricePerM: 0.02
                }
            }
        });
        assert(patchRes.status === 200 && patchRes.body?.status === 'ok', 'PATCH returns 200 ok');
        assert(patchRes.body?.provider?.currentBalance === 15.0, 'Balance topped up to $15.00', `Current: ${patchRes.body?.provider?.currentBalance}`);
        assert(patchRes.body?.provider?.pricing?.inputPricePerM === 0.15, 'Updated input price to $0.15');

        // Test 5: Unit test request converter in custom-dispatcher.js
        console.log('\n5. Testing anthropicRequestToOpenAi translation');
        const anthropicPayload = {
            model: 'deepseek-test-deepseek-chat',
            messages: [
                { role: 'user', content: 'Hello deepseek!' }
            ],
            system: 'You are a helpful assistant',
            temperature: 0.7,
            max_tokens: 1000
        };
        const openAiPayload = anthropicRequestToOpenAi(anthropicPayload, 'deepseek-chat');
        assert(openAiPayload.model === 'deepseek-chat', 'Model stripped provider prefix for upstream: deepseek-chat');
        assert(openAiPayload.messages[0].role === 'system', 'System prompt prepended as first message');
        assert(openAiPayload.messages[1].content === 'Hello deepseek!', 'User message preserved');
        assert(openAiPayload.max_tokens === 1000, 'max_tokens preserved');

        // Test 6: Testing Usage Recording & Balance Deduction
        console.log('\n6. Testing Usage Recording & Balance Deduction');
        await accountManager.reload();
        const initialStatus = accountManager.getCustomProviders().find(p => p.name === 'deepseek-test');
        const balanceBefore = initialStatus.currentBalance;

        // Record usage of 1,000,000 input tokens at $0.15/M and 1,000,000 output tokens at $0.30/M -> total cost $0.45
        accountManager.recordCustomProviderUsage('deepseek-test', {
            inputTokens: 1000000,
            outputTokens: 1000000,
            cacheTokens: 0
        });

        const updatedStatus = accountManager.getCustomProviders().find(p => p.name === 'deepseek-test');
        const expectedBalance = balanceBefore - 0.45;
        assert(Math.abs(updatedStatus.currentBalance - expectedBalance) < 0.001, `Balance deducted correctly: $${updatedStatus.currentBalance} (expected ~$${expectedBalance})`);
        assert(updatedStatus.usage.totalRequests === 1, 'Total requests incremented to 1');
        assert(updatedStatus.usage.inputTokens === 1000000, 'Usage input tokens recorded accurately');

        // Test 7: Cleanup test provider via DELETE
        console.log('\n7. Cleaning up test provider');
        const deleteRes = await makeRequest('/api/accounts/deepseek-test', {
            method: 'DELETE'
        });
        assert(deleteRes.status === 200 && deleteRes.body?.status === 'ok', 'DELETE /api/accounts/deepseek-test succeeded');

        // Verify it was removed
        const limitsAfter = await makeRequest('/account-limits');
        const stillExists = (limitsAfter.body?.accounts || []).some(a => a.name === 'deepseek-test');
        assert(!stillExists, 'Provider no longer appears in /account-limits');

    } catch (err) {
        console.error('Unexpected test error:', err);
        failed++;
    }

    console.log(`\n=== TEST SUMMARY: ${passed} PASSED, ${failed} FAILED ===`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests();
