const http = require('http');
const { execSync } = require('child_process');
const assert = require('assert');

const BASE_URL = 'http://localhost:8080';

function makeRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = body ? JSON.parse(body) : null;
                    resolve({ status: res.statusCode, headers: res.headers, body: parsed, rawBody: body });
                } catch (e) {
                    resolve({ status: res.statusCode, headers: res.headers, body: null, rawBody: body });
                }
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
    console.log('--- Starting Password Recovery Tests ---\n');

    // 1. Test CLI Reset Command
    console.log('1. Testing CLI Reset Command via npm run reset-password:');
    try {
        const cliOutput = execSync('node bin/reset-password.js cliPass123 admin', { encoding: 'utf-8' });
        console.log('  CLI output:', cliOutput.trim().split('\n')[0]);
        assert(cliOutput.includes('successfully updated'), 'CLI reset should succeed');
        assert(cliOutput.includes('cliPass123'), 'CLI reset should show new password');
        console.log('  ✓ CLI reset password command executed successfully');

        // Test login with new CLI password
        const loginRes = await makeRequest({
            hostname: 'localhost',
            port: 8080,
            path: '/api/auth/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, { username: 'admin', password: 'cliPass123' });

        assert.strictEqual(loginRes.status, 200, 'Login should succeed with CLI reset password');
        assert.strictEqual(loginRes.body.status, 'ok', 'Status should be ok');
        console.log('  ✓ Login with CLI-reset password succeeded');
    } catch (e) {
        console.error('  ✗ CLI test failed:', e);
        process.exit(1);
    }

    // 2. Test Recovery Status Endpoint
    console.log('\n2. Testing GET /api/auth/recovery-status (public endpoint):');
    try {
        const statusRes = await makeRequest({
            hostname: 'localhost',
            port: 8080,
            path: '/api/auth/recovery-status',
            method: 'GET'
        });

        assert.strictEqual(statusRes.status, 200, 'recovery-status should return 200 without auth token');
        assert(statusRes.body.hasOwnProperty('cliEnabled'), 'Should contain cliEnabled');
        assert(statusRes.body.hasOwnProperty('emailEnabled'), 'Should contain emailEnabled');
        assert(statusRes.body.hasOwnProperty('hasEmail'), 'Should contain hasEmail');
        assert(statusRes.body.hasOwnProperty('hasSmtp'), 'Should contain hasSmtp');
        console.log('  Recovery status returned:', statusRes.body);
        console.log('  ✓ Public recovery status endpoint verified');
    } catch (e) {
        console.error('  ✗ Recovery status test failed:', e);
        process.exit(1);
    }

    // 3. Test Invalid Identifier on Forgot Password
    console.log('\n3. Testing POST /api/auth/forgot-password with unknown identifier:');
    try {
        const forgotRes = await makeRequest({
            hostname: 'localhost',
            port: 8080,
            path: '/api/auth/forgot-password',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, { identifier: 'non_existent_user_9999' });

        assert.strictEqual(forgotRes.status, 400, 'Unknown identifier should return 400');
        assert(forgotRes.body.error.includes('does not match'), 'Should return does not match error message');
        console.log('  ✓ Unknown identifier correctly rejected with 400 & error message');
    } catch (e) {
        console.error('  ✗ Forgot password test failed:', e);
        process.exit(1);
    }

    // 4. Test Password Reset Validation
    console.log('\n4. Testing POST /api/auth/reset-password validation:');
    try {
        // Missing code
        const noCodeRes = await makeRequest({
            hostname: 'localhost',
            port: 8080,
            path: '/api/auth/reset-password',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, { identifier: 'admin', code: '', newPassword: 'newPassword123' });
        assert.strictEqual(noCodeRes.status, 400, 'Empty code should return 400');

        // Non-existent or invalid code
        const invalidCodeRes = await makeRequest({
            hostname: 'localhost',
            port: 8080,
            path: '/api/auth/reset-password',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, { identifier: 'admin', code: '000000', newPassword: 'newPassword123' });
        assert.strictEqual(invalidCodeRes.status, 400, 'Invalid code should return 400');
        console.log('  ✓ Invalid / missing OTP code rejected properly');
    } catch (e) {
        console.error('  ✗ Reset password validation test failed:', e);
        process.exit(1);
    }

    // 5. Reset back to admin123
    console.log('\n5. Restoring password to admin123:');
    execSync('node bin/reset-password.js admin123 admin', { encoding: 'utf-8' });
    const finalLoginRes = await makeRequest({
        hostname: 'localhost',
        port: 8080,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { username: 'admin', password: 'admin123' });
    assert.strictEqual(finalLoginRes.status, 200, 'Login with admin123 should succeed');
    console.log('  ✓ Password successfully restored to admin123');

    console.log('\n========================================');
    console.log('All Password Recovery Backend Tests PASSED!');
    console.log('========================================');
}

runTests().catch(err => {
    console.error('Test run failed:', err);
    process.exit(1);
});
