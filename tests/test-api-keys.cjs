const assert = require('assert');

async function test() {
    console.log('--- Testing API Key Manager ---');
    const { apiKeyManager } = await import('../src/modules/api-keys.js');

    // Test 1: Create key with 7 days preset and unlimited tokens (0)
    const key1 = await apiKeyManager.createKey({
        name: 'Test Key 7d Unlimited',
        presetDays: '7',
        tokenLimit: 0
    });
    console.log('Created key1:', key1.id, key1.key, 'expiresAt:', new Date(key1.expiresAt).toISOString());
    assert(key1.key.startsWith('ag-sk-'), 'Key format should start with ag-sk-');
    assert(key1.tokenLimit === 0, 'Token limit should be 0');
    assert(key1.expiresAt > Date.now(), 'Should expire in the future');

    // Validate key1
    let val1 = apiKeyManager.validateKey(key1.key);
    assert(val1.valid === true, 'Key1 should be valid');

    // Test 2: Create key with token limit
    const key2 = await apiKeyManager.createKey({
        name: 'Test Key Limited',
        presetDays: 'never',
        tokenLimit: 100
    });
    console.log('Created key2 with limit 100 tokens:', key2.id);
    assert(key2.expiresAt === null, 'Never expires should have null expiresAt');
    assert(key2.tokenLimit === 100, 'Token limit should be 100');

    // Record usage up to limit
    apiKeyManager.recordUsage(key2.id, 50);
    let key2Updated = apiKeyManager.getKeyById(key2.id);
    assert(key2Updated.tokensUsed === 50, 'Tokens used should be 50');
    assert(apiKeyManager.validateKey(key2.key).valid === true, 'Key2 should still be valid at 50/100');

    apiKeyManager.recordUsage(key2.id, 60); // now 110/100
    key2Updated = apiKeyManager.getKeyById(key2.id);
    assert(key2Updated.tokensUsed === 110, 'Tokens used should be 110');
    const val2 = apiKeyManager.validateKey(key2.key);
    assert(val2.valid === false, 'Key2 should be invalid after exceeding limit');
    assert(val2.reason.includes('token limit exceeded'), 'Reason should mention token limit');
    console.log('Token limit exceeded test passed:', val2.reason);

    // Test 3: Toggle revoke
    const revoked = await apiKeyManager.toggleRevokeKey(key1.id);
    assert(revoked.status === 'revoked', 'Status should be revoked');
    const valRevoked = apiKeyManager.validateKey(key1.key);
    assert(valRevoked.valid === false, 'Revoked key should be invalid');
    assert(valRevoked.reason.includes('revoked'), 'Reason should mention revoked');
    console.log('Revoke test passed:', valRevoked.reason);

    // Reactivate
    const reactivated = await apiKeyManager.toggleRevokeKey(key1.id);
    assert(reactivated.status === 'active', 'Status should be active');
    assert(apiKeyManager.validateKey(key1.key).valid === true, 'Reactivated key should be valid');
    console.log('Reactivate test passed');

    // Test 4: Update key
    const updated = await apiKeyManager.updateKey(key1.id, {
        name: 'Renamed Key 1',
        tokenLimit: 99999,
        presetDays: '60'
    });
    assert(updated.name === 'Renamed Key 1', 'Name should be updated');
    assert(updated.tokenLimit === 99999, 'Token limit should be 99999');
    console.log('Update key test passed:', updated.name, updated.tokenLimit);

    // Test 5: Delete key
    await apiKeyManager.deleteKey(key1.id);
    await apiKeyManager.deleteKey(key2.id);
    assert(apiKeyManager.getKeyById(key1.id) === null, 'Key1 should be deleted');
    assert(apiKeyManager.getKeyById(key2.id) === null, 'Key2 should be deleted');
    console.log('Delete test passed');

    console.log('--- ALL API KEY UNIT TESTS PASSED SUCCESSFULLY ---');
}

test().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
