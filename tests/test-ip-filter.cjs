const assert = require('assert');

async function runTests() {
    console.log('Testing ip-filter.js...');
    const { normalizeIp, matchCidr, matchWildcard, matchIpRule, isIpAllowed } = await import('../src/utils/ip-filter.js');

    // 1. Normalization
    assert.strictEqual(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
    assert.strictEqual(normalizeIp('192.168.1.5:8080'), '192.168.1.5');
    assert.strictEqual(normalizeIp(' localhost '), '127.0.0.1');

    // 2. Loopback match
    assert.strictEqual(matchIpRule('::1', '127.0.0.1'), true);
    assert.strictEqual(matchIpRule('127.0.0.1', '::1'), true);
    assert.strictEqual(matchIpRule('::ffff:127.0.0.1', '127.0.0.1'), true);

    // 3. CIDR match
    assert.strictEqual(matchCidr('192.168.1.50', '192.168.1.0/24'), true);
    assert.strictEqual(matchCidr('192.168.2.50', '192.168.1.0/24'), false);
    assert.strictEqual(matchCidr('10.50.2.1', '10.0.0.0/8'), true);

    // 4. Wildcard match
    assert.strictEqual(matchWildcard('192.168.1.100', '192.168.1.*'), true);
    assert.strictEqual(matchWildcard('192.168.2.100', '192.168.1.*'), false);

    // 5. isIpAllowed - Disabled
    const disabled = isIpAllowed('203.0.113.1', { enabled: false, mode: 'allow', ipList: ['127.0.0.1'] });
    assert.strictEqual(disabled.allowed, true);

    // 6. isIpAllowed - Allowlist
    const allowPass = isIpAllowed('192.168.1.50', { enabled: true, mode: 'allow', ipList: ['192.168.1.0/24', '127.0.0.1'] });
    assert.strictEqual(allowPass.allowed, true);

    const allowFail = isIpAllowed('203.0.113.1', { enabled: true, mode: 'allow', ipList: ['192.168.1.0/24', '127.0.0.1'] });
    assert.strictEqual(allowFail.allowed, false);
    assert(allowFail.reason.includes('not authorized'));

    // 7. isIpAllowed - Denylist
    const denyBlocked = isIpAllowed('192.168.1.50', { enabled: true, mode: 'deny', ipList: ['192.168.1.50'] });
    assert.strictEqual(denyBlocked.allowed, false);
    assert(denyBlocked.reason.includes('blocked'));

    const denyOtherPass = isIpAllowed('192.168.1.51', { enabled: true, mode: 'deny', ipList: ['192.168.1.50'] });
    assert.strictEqual(denyOtherPass.allowed, true);

    console.log('All ip-filter tests passed!');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
