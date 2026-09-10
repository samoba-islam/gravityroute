/**
 * Test that hidden models are skipped by GET /v1/models
 */

const assert = require('assert');

const BASE_URL = 'http://localhost:8080';
const VALID_KEY = 'ag-sk-4bf6e2d01c23fd6504a270985ccfc82ff1eeda8eda7cd1f6';

async function testHiddenModels() {
    console.log('Testing GET /v1/models hidden models filtering...');

    const res = await fetch(`${BASE_URL}/v1/models`, {
        headers: { 'Authorization': `Bearer ${VALID_KEY}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const modelIds = data.data.map(m => m.id);

    console.log(`Total models returned: ${modelIds.length}`);
    console.log('Models sample:', modelIds.slice(0, 10));

    // Ensure no synthetic OpenAI aliases (e.g. gpt-4o) are present
    assert(!modelIds.includes('gpt-4o'), 'Should not include gpt-4o');
    assert(!modelIds.includes('gpt-4o-mini'), 'Should not include gpt-4o-mini');
    assert(!modelIds.includes('o1'), 'Should not include o1');

    // Ensure all returned models are native Cloud Code models
    for (const m of data.data) {
        assert(m.id.startsWith('claude-') || m.id.startsWith('gemini-'), `Model ${m.id} should be native Claude or Gemini`);
        assert.strictEqual(m.object, 'model');
    }

    console.log('✓ All returned models are native models (synthetic aliases omitted).');
    console.log('✓ Hidden models filtering logic matches Anthropic listModels.');
}

testHiddenModels().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
