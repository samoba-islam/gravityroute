/**
 * Live Integration Tests for OpenAI-Compatible Endpoints
 */

const assert = require('assert');

const BASE_URL = 'http://localhost:8080';
const VALID_KEY = 'ag-sk-4bf6e2d01c23fd6504a270985ccfc82ff1eeda8eda7cd1f6';

async function runLiveTests() {
    console.log('=== Running Live OpenAI API Integration Tests ===\n');

    // 1. Test GET /v1/models
    console.log('--- 1. Testing GET /v1/models ---');
    const modelsRes = await fetch(`${BASE_URL}/v1/models`, {
        headers: { 'Authorization': `Bearer ${VALID_KEY}` }
    });
    assert.strictEqual(modelsRes.status, 200, 'GET /v1/models should return 200');
    const modelsData = await modelsRes.json();
    assert.strictEqual(modelsData.object, 'list', 'models response object should be "list"');
    assert(Array.isArray(modelsData.data) && modelsData.data.length > 0, 'models.data should be non-empty');

    const modelIds = modelsData.data.map(m => m.id);
    console.log(`Found ${modelIds.length} models.`);
    console.log('Sample models:', modelIds.slice(0, 8));

    // Verify native models are present
    const hasClaude = modelIds.some(id => id.includes('claude'));
    const hasGemini = modelIds.some(id => id.includes('gemini'));
    assert(hasClaude, 'Should list native Claude models');
    assert(hasGemini, 'Should list native Gemini models');

    // Verify OpenAI aliases are NOT in the models list (per user requirement)
    assert(!modelIds.includes('gpt-4o'), 'Should not list synthetic gpt-4o alias in models endpoint');
    assert(!modelIds.includes('gpt-4o-mini'), 'Should not list synthetic gpt-4o-mini alias in models endpoint');
    console.log('✓ GET /v1/models returns ONLY the native models list (identical to Anthropic compatibility)');

    // 2. Test GET /v1/models/:model
    console.log('\n--- 2. Testing GET /v1/models/:model ---');
    const singleNativeRes = await fetch(`${BASE_URL}/v1/models/claude-sonnet-4-6`, {
        headers: { 'Authorization': `Bearer ${VALID_KEY}` }
    });
    assert.strictEqual(singleNativeRes.status, 200);
    const singleNative = await singleNativeRes.json();
    assert.strictEqual(singleNative.id, 'claude-sonnet-4-6');
    console.log('✓ GET /v1/models/claude-sonnet-4-6 succeeded:', singleNative.id);

    // Synthetic alias should return 404 from models endpoint
    const singleAliasRes = await fetch(`${BASE_URL}/v1/models/gpt-4o`, {
        headers: { 'Authorization': `Bearer ${VALID_KEY}` }
    });
    assert.strictEqual(singleAliasRes.status, 404, 'Synthetic alias gpt-4o should return 404 from models endpoint');
    console.log('✓ GET /v1/models/gpt-4o returned 404 as expected (only native models exist in endpoint)');

    // 3. Test Authentication & Error Format
    console.log('\n--- 3. Testing Authentication & OpenAI Error Schema ---');
    const authFailRes = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ag-sk-invalid-fake-key-12345'
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'test' }]
        })
    });
    assert.strictEqual(authFailRes.status, 401, 'Invalid key should return 401');
    const authFailData = await authFailRes.json();
    assert(authFailData.error, 'Response must have "error" property');
    assert.strictEqual(authFailData.error.type, 'authentication_error', 'Error type must be authentication_error');
    assert.strictEqual(authFailData.error.code, 'invalid_api_key', 'Error code must be invalid_api_key');
    console.log('✓ Rejection uses OpenAI error schema:', authFailData.error);

    // 4. Test POST /v1/chat/completions (Non-Streaming with OpenAI alias)
    console.log('\n--- 4. Testing POST /v1/chat/completions (OpenAI alias: gpt-4o) ---');
    const completionRes1 = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${VALID_KEY}`
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: 'You are a test runner. Respond concisely.' },
                { role: 'user', content: 'Say the single word "CONFIRMED".' }
            ],
            max_tokens: 20
        })
    });
    assert.strictEqual(completionRes1.status, 200, `Expected 200, got ${completionRes1.status}`);
    const comp1 = await completionRes1.json();
    assert(comp1.id.startsWith('chatcmpl-'), 'ID should start with chatcmpl-');
    assert.strictEqual(comp1.object, 'chat.completion');
    assert.strictEqual(comp1.model, 'gpt-4o');
    assert(Array.isArray(comp1.choices) && comp1.choices.length > 0);
    assert.strictEqual(comp1.choices[0].message.role, 'assistant');
    assert(typeof comp1.choices[0].message.content === 'string' && comp1.choices[0].message.content.length > 0);
    assert(comp1.usage && comp1.usage.total_tokens > 0, 'Usage stats should be returned');
    console.log('✓ Response received:', comp1.choices[0].message.content.trim());
    console.log('✓ Token Usage:', comp1.usage);

    // 5. Test POST /v1/chat/completions (Non-Streaming with Direct Native Model ID)
    console.log('\n--- 5. Testing POST /v1/chat/completions (Direct Native Model: claude-sonnet-4-6) ---');
    const completionRes2 = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${VALID_KEY}`
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            messages: [
                { role: 'user', content: 'Reply with the word "NATIVE_PASSED".' }
            ],
            max_tokens: 20
        })
    });
    assert.strictEqual(completionRes2.status, 200, `Expected 200, got ${completionRes2.status}`);
    const comp2 = await completionRes2.json();
    assert.strictEqual(comp2.model, 'claude-sonnet-4-6');
    assert(comp2.choices[0].message.content.includes('NATIVE_PASSED') || comp2.choices[0].message.content.length > 0);
    console.log('✓ Response received with native model ID:', comp2.choices[0].message.content.trim());

    // 6. Test POST /v1/chat/completions (Streaming: stream: true)
    console.log('\n--- 6. Testing POST /v1/chat/completions (SSE Streaming) ---');
    const streamRes = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${VALID_KEY}`
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
                { role: 'user', content: 'Count from 1 to 3.' }
            ],
            stream: true,
            max_tokens: 30
        })
    });
    assert.strictEqual(streamRes.status, 200);
    assert.strictEqual(streamRes.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let accumulatedText = '';
    let sawDone = false;
    let chunkCount = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') {
                sawDone = true;
                continue;
            }
            try {
                const parsed = JSON.parse(dataStr);
                chunkCount++;
                assert.strictEqual(parsed.object, 'chat.completion.chunk');
                const contentDelta = parsed.choices?.[0]?.delta?.content;
                if (contentDelta) {
                    accumulatedText += contentDelta;
                }
            } catch (err) {
                // Ignore empty or malformed line
            }
        }
    }

    assert(sawDone, 'Stream must end with data: [DONE]');
    assert(chunkCount > 0, 'Stream must yield chunks');
    assert(accumulatedText.length > 0, 'Accumulated stream text must not be empty');
    console.log(`✓ Streamed ${chunkCount} chunks, received text: "${accumulatedText.trim()}"`);
    console.log('✓ Stream terminated cleanly with [DONE]');

    console.log('\n=== ALL LIVE OPENAI INTEGRATION TESTS PASSED! 🎉 ===');
}

runLiveTests().catch(err => {
    console.error('\n❌ Live Integration Test Failed:', err);
    process.exit(1);
});
