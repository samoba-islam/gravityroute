/**
 * Integration test for IP restriction API and enforcement
 */
const http = require('http');

function request(options, data = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(body);
                } catch (e) {
                    parsed = body;
                }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) {
            req.write(typeof data === 'string' ? data : JSON.stringify(data));
        }
        req.end();
    });
}

async function runTests() {
    console.log('--- Testing IP Restriction Feature ---');

    // 1. Test /api/my-ip
    console.log('1. Testing GET /api/my-ip');
    const myIpRes = await request({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/api/my-ip',
        method: 'GET'
    });
    console.log('GET /api/my-ip status:', myIpRes.status, 'body:', myIpRes.body);
    if (myIpRes.status !== 200 || !myIpRes.body.ip) {
        throw new Error('Failed GET /api/my-ip');
    }

    // 2. Create Key with Allowlist [10.20.30.40]
    console.log('\n2. Creating Key with Allowlist [10.20.30.40]');
    const createAllowRes = await request({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/api/keys',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, {
        name: 'Test Allow Key',
        presetDays: 7,
        tokenLimit: 10000,
        ipRestrictionEnabled: true,
        ipRestrictionMode: 'allow',
        ipList: ['10.20.30.40']
    });

    console.log('Create Allow Key status:', createAllowRes.status, 'name:', createAllowRes.body.key?.name);
    const allowKey = createAllowRes.body.key;
    if (!allowKey || !allowKey.ipRestrictionEnabled || allowKey.ipRestrictionMode !== 'allow') {
        throw new Error('Allow key creation failed or wrong IP settings');
    }

    // 3. Test access with Allow Key from wrong IP (1.2.3.4) -> Expected 403
    console.log('\n3. Testing access with Allow Key from unauthorized IP (1.2.3.4)');
    const blockedRes = await request({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/v1/models',
        method: 'GET',
        headers: {
            'x-api-key': allowKey.key,
            'x-forwarded-for': '1.2.3.4'
        }
    });
    console.log('Blocked response status:', blockedRes.status, 'body:', blockedRes.body);
    if (blockedRes.status !== 403 || blockedRes.body?.error?.type !== 'permission_error') {
        throw new Error(`Expected 403 permission_error, got ${blockedRes.status}`);
    }

    // 4. Test access with Allow Key from permitted IP (10.20.30.40) -> Expected 200
    console.log('\n4. Testing access with Allow Key from allowed IP (10.20.30.40)');
    const allowedRes = await request({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/v1/models',
        method: 'GET',
        headers: {
            'x-api-key': allowKey.key,
            'x-forwarded-for': '10.20.30.40'
        }
    });
    console.log('Allowed response status:', allowedRes.status);
    if (allowedRes.status !== 200) {
        throw new Error(`Expected 200, got ${allowedRes.status}`);
    }

    // 5. Create Key with Denylist [192.168.1.100]
    console.log('\n5. Creating Key with Denylist [192.168.1.100]');
    const createDenyRes = await request({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/api/keys',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, {
        name: 'Test Deny Key',
        presetDays: 'never',
        ipRestrictionEnabled: true,
        ipRestrictionMode: 'deny',
        ipList: ['192.168.1.100']
    });

    const denyKey = createDenyRes.body.key;
    console.log('Create Deny Key status:', createDenyRes.status, 'id:', denyKey.id);

    // 6. Test access with Deny Key from blocked IP (192.168.1.100) -> Expected 403
    console.log('\n6. Testing access with Deny Key from blocked IP (192.168.1.100)');
    const denyBlocked = await request({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/v1/models',
        method: 'GET',
        headers: {
            'x-api-key': denyKey.key,
            'x-forwarded-for': '192.168.1.100'
        }
    });
    console.log('Deny Blocked response status:', denyBlocked.status, 'body:', denyBlocked.body);
    if (denyBlocked.status !== 403) {
        throw new Error(`Expected 403, got ${denyBlocked.status}`);
    }

    // 7. Test access with Deny Key from unlisted IP (192.168.1.55) -> Expected 200
    console.log('\n7. Testing access with Deny Key from unlisted IP (192.168.1.55)');
    const denyPass = await request({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/v1/models',
        method: 'GET',
        headers: {
            'x-api-key': denyKey.key,
            'x-forwarded-for': '192.168.1.55'
        }
    });
    console.log('Deny Pass response status:', denyPass.status);
    if (denyPass.status !== 200) {
        throw new Error(`Expected 200, got ${denyPass.status}`);
    }

    // 8. Update Deny Key: Disable IP restriction -> Now 192.168.1.100 should pass!
    console.log('\n8. Updating Deny Key to disable IP restriction');
    const updateRes = await request({
        hostname: '127.0.0.1',
        port: 8080,
        path: `/api/keys/${denyKey.id}`,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
    }, {
        ipRestrictionEnabled: false
    });
    console.log('Update status:', updateRes.status, 'enabled:', updateRes.body.key?.ipRestrictionEnabled);

    const disabledPass = await request({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/v1/models',
        method: 'GET',
        headers: {
            'x-api-key': denyKey.key,
            'x-forwarded-for': '192.168.1.100'
        }
    });
    console.log('Disabled IP restriction response status:', disabledPass.status);
    if (disabledPass.status !== 200) {
        throw new Error(`Expected 200 when disabled, got ${disabledPass.status}`);
    }

    // 9. Clean up test keys
    console.log('\n9. Cleaning up test keys');
    await request({
        hostname: '127.0.0.1',
        port: 8080,
        path: `/api/keys/${allowKey.id}`,
        method: 'DELETE'
    });
    await request({
        hostname: '127.0.0.1',
        port: 8080,
        path: `/api/keys/${denyKey.id}`,
        method: 'DELETE'
    });
    console.log('Test keys cleaned up successfully.');

    console.log('\n ALL IP RESTRICTION TESTS PASSED! ');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
