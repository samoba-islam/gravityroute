/**
 * Test Suite for WebUI Authentication
 * Tests:
 * 1. Default disabled state (access allowed)
 * 2. Status endpoint /api/auth/status
 * 3. Lockout prevention (cannot enable without password)
 * 4. Enabling auth via /api/auth/config
 * 5. Protected endpoints return 401 when auth is enabled
 * 6. Login via /api/auth/login (invalid and valid credentials, rememberMe cookie)
 * 7. Access with Bearer token, x-webui-token header, and cookie
 * 8. Password change validation (current password check)
 * 9. Logout via /api/auth/logout (invalidates token)
 * 10. Disabling auth restores open access
 */

const assert = require('assert');
const http = require('http');

async function runTests() {
    console.log('=== Running WebUI Auth Tests ===\n');

    // Dynamically import modules
    const express = (await import('express')).default;
    const { mountWebUI } = await import('../src/webui/index.js');
    const { config, saveConfig } = await import('../src/config.js');

    // Save original config to restore at the end
    const originalAuthEnabled = config.webuiAuthEnabled;
    const originalUsername = config.webuiUsername;
    const originalPassword = config.webuiPassword;

    // Reset to default disabled
    config.webuiAuthEnabled = false;
    config.webuiUsername = 'admin';
    config.webuiPassword = '';

    // Create a mock account manager
    const mockAccountManager = {
        getStatus: () => ({ total: 1, available: 1, accounts: [] }),
        getAllAccounts: () => [],
        getSettings: () => ({})
    };

    const app = express();
    app.use(express.json());
    mountWebUI(app, __dirname, mockAccountManager);

    // Start server on ephemeral port
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`Test server running at ${baseUrl}`);

    function request(path, options = {}) {
        return new Promise((resolve, reject) => {
            const url = new URL(path, baseUrl);
            const req = http.request(url, {
                method: options.method || 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch (e) {}
                    resolve({ status: res.statusCode, data, json, headers: res.headers });
                });
            });
            req.on('error', reject);
            if (options.body) req.write(JSON.stringify(options.body));
            req.end();
        });
    }

    let testToken = null;
    let sessionCookie = null;

    try {
        // Test 1: Status endpoint when disabled
        console.log('Test 1: Status endpoint when auth is disabled');
        const res1 = await request('/api/auth/status');
        assert.strictEqual(res1.status, 200);
        assert.strictEqual(res1.json.authEnabled, false);
        assert.strictEqual(res1.json.authenticated, true);
        console.log('  Passed: Status correctly reports auth disabled and authenticated=true');

        // Test 2: Protected endpoints accessible when auth is disabled
        console.log('Test 2: Access endpoints when auth is disabled');
        const res2 = await request('/api/accounts');
        assert.strictEqual(res2.status, 200);
        console.log('  Passed: /api/accounts accessible without credentials');

        // Test 3: Lockout prevention (cannot enable auth without password)
        console.log('Test 3: Lockout prevention (cannot enable without password)');
        const res3 = await request('/api/auth/config', {
            method: 'POST',
            body: { enabled: true, username: 'admin' }
        });
        assert.strictEqual(res3.status, 400);
        assert(res3.json.error.includes('password is required'));
        console.log('  Passed: Rejected enabling auth without a password');

        // Test 4: Enable auth with username and password
        console.log('Test 4: Enable auth with username and password');
        const res4 = await request('/api/auth/config', {
            method: 'POST',
            body: {
                enabled: true,
                username: 'admin',
                newPassword: 'SuperSecretPassword123'
            }
        });
        assert.strictEqual(res4.status, 200);
        assert.strictEqual(res4.json.config.webuiAuthEnabled, true);
        assert(res4.json.token, 'Should return a valid session token on enabling auth');
        testToken = res4.json.token;
        console.log('  Passed: Auth enabled and session token returned');

        // Test 5: Unauthenticated request should now be blocked with 401
        console.log('Test 5: Protected endpoints blocked when unauthenticated');
        const res5 = await request('/api/accounts');
        assert.strictEqual(res5.status, 401);
        assert.strictEqual(res5.json.authRequired, true);
        console.log('  Passed: /api/accounts returned 401 Unauthorized');

        // Test 6: Access with Bearer token succeeds
        console.log('Test 6: Access with Authorization Bearer header');
        const res6 = await request('/api/accounts', {
            headers: { 'Authorization': `Bearer ${testToken}` }
        });
        assert.strictEqual(res6.status, 200);
        console.log('  Passed: Authorized request succeeded with Bearer token');

        // Test 7: Access with x-webui-token header succeeds
        console.log('Test 7: Access with x-webui-token header');
        const res7 = await request('/api/accounts', {
            headers: { 'x-webui-token': testToken }
        });
        assert.strictEqual(res7.status, 200);
        console.log('  Passed: Authorized request succeeded with x-webui-token header');

        // Test 8: Login with invalid credentials returns 401
        console.log('Test 8: Login with invalid credentials');
        const res8 = await request('/api/auth/login', {
            method: 'POST',
            body: { username: 'admin', password: 'WrongPassword' }
        });
        assert.strictEqual(res8.status, 401);
        console.log('  Passed: Login rejected invalid credentials');

        // Test 9: Login with valid credentials and rememberMe: true (saved login)
        console.log('Test 9: Login with valid credentials (rememberMe: true)');
        const res9 = await request('/api/auth/login', {
            method: 'POST',
            body: {
                username: 'admin',
                password: 'SuperSecretPassword123',
                rememberMe: true
            }
        });
        assert.strictEqual(res9.status, 200);
        assert(res9.json.token, 'Should return session token');
        const setCookie = res9.headers['set-cookie'];
        assert(setCookie, 'Should set cookie');
        assert(setCookie[0].includes('Max-Age='), 'Cookie with rememberMe=true should have Max-Age for saved login');
        sessionCookie = setCookie[0].split(';')[0];
        console.log('  Passed: Logged in and received persistent cookie with Max-Age');

        // Test 10: Login with rememberMe: false (session cookie)
        console.log('Test 10: Login with rememberMe: false (session cookie)');
        const res10 = await request('/api/auth/login', {
            method: 'POST',
            body: {
                username: 'admin',
                password: 'SuperSecretPassword123',
                rememberMe: false
            }
        });
        assert.strictEqual(res10.status, 200);
        const setCookieSession = res10.headers['set-cookie'];
        assert(setCookieSession, 'Should set cookie');
        assert(!setCookieSession[0].includes('Max-Age='), 'Session cookie should NOT have Max-Age');
        console.log('  Passed: Logged in and received true session cookie');

        // Test 11: Request using cookie authentication
        console.log('Test 11: Request with Cookie header');
        const res11 = await request('/api/accounts', {
            headers: { 'Cookie': sessionCookie }
        });
        assert.strictEqual(res11.status, 200);
        console.log('  Passed: Request with cookie succeeded');

        // Test 12: Changing password requires valid current password
        console.log('Test 12: Changing password requires valid current password');
        const res12 = await request('/api/auth/config', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${testToken}` },
            body: {
                currentPassword: 'WrongCurrentPassword',
                newPassword: 'NewPassword999'
            }
        });
        assert.strictEqual(res12.status, 403);
        console.log('  Passed: Rejected password change with incorrect current password');

        // Test 13: Changing password with correct current password
        console.log('Test 13: Change password with correct current password');
        const res13 = await request('/api/auth/config', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${testToken}` },
            body: {
                currentPassword: 'SuperSecretPassword123',
                newPassword: 'NewPassword999'
            }
        });
        assert.strictEqual(res13.status, 200);
        console.log('  Passed: Successfully updated password');

        // Test 14: Logout invalidates session
        console.log('Test 14: Logout invalidates session token');
        const res14 = await request('/api/auth/logout', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${testToken}` }
        });
        assert.strictEqual(res14.status, 200);
        // Subsequent request with old token should fail
        const res14b = await request('/api/accounts', {
            headers: { 'Authorization': `Bearer ${testToken}` }
        });
        assert.strictEqual(res14b.status, 401);
        console.log('  Passed: Logout successfully invalidated token');

        // Test 15: Configure Admin Email & Login with Email
        console.log('Test 15: Configure Admin Email & Login with Email');
        // Login with username to get token
        const preEmailLogin = await request('/api/auth/login', {
            method: 'POST',
            body: { username: 'admin', password: 'NewPassword999' }
        });
        const emailAuthToken = preEmailLogin.json.token;

        // Invalid email format rejected
        const invalidEmailRes = await request('/api/auth/config', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${emailAuthToken}` },
            body: { email: 'not-a-valid-email' }
        });
        assert.strictEqual(invalidEmailRes.status, 400);

        // Valid email accepted
        const validEmailRes = await request('/api/auth/config', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${emailAuthToken}` },
            body: { email: 'superadmin@company.org' }
        });
        assert.strictEqual(validEmailRes.status, 200);
        assert.strictEqual(validEmailRes.json.config.webuiEmail, 'superadmin@company.org');

        // Login using email address instead of username
        const emailLoginRes = await request('/api/auth/login', {
            method: 'POST',
            body: { username: 'superadmin@company.org', password: 'NewPassword999' }
        });
        assert.strictEqual(emailLoginRes.status, 200);
        assert.strictEqual(emailLoginRes.json.status, 'ok');
        console.log('  Passed: Successfully configured email ID and logged in using email');

        // Test 16: Disable auth restores open access
        console.log('Test 16: Disable authentication');
        const freshToken = emailLoginRes.json.token;

        const res16 = await request('/api/auth/config', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${freshToken}` },
            body: { enabled: false }
        });
        assert.strictEqual(res16.status, 200);
        assert.strictEqual(res16.json.config.webuiAuthEnabled, false);

        // Access without any credentials should succeed again
        const res16b = await request('/api/accounts');
        assert.strictEqual(res16b.status, 200);
        console.log('  Passed: Open access restored after disabling auth');

        console.log('\n=== ALL 16 WEBUI AUTH TESTS PASSED! ===\n');
    } finally {
        // Restore original config
        saveConfig({
            webuiAuthEnabled: originalAuthEnabled,
            webuiUsername: originalUsername,
            webuiPassword: originalPassword
        });
        server.close();
    }
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
