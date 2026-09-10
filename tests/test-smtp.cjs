/**
 * SMTP Configuration & Service Test Suite
 */

const http = require('http');
const assert = require('assert');

// Helper to make HTTP requests
function request(options, data = null) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                let parsed;
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
    console.log('\n--- 1. Testing src/config.js SMTP defaults & redaction ---');
    const configModule = await import('../src/config.js');
    const pubConfig = configModule.getPublicConfig();
    assert(pubConfig.smtp, 'Public config should include smtp object');
    assert.strictEqual(typeof pubConfig.smtp.enabled, 'boolean', 'smtp.enabled should be boolean');
    assert.strictEqual(typeof pubConfig.smtp.hasPassword, 'boolean', 'smtp.hasPassword should be boolean');
    assert.strictEqual(pubConfig.smtp.pass === '' || pubConfig.smtp.pass === '********', true, 'smtp.pass should be empty or redacted');
    console.log('✓ Public config exposes smtp safely without password leaks');

    console.log('\n--- 2. Testing src/utils/smtp.js exports ---');
    const smtpUtils = await import('../src/utils/smtp.js');
    assert.strictEqual(typeof smtpUtils.createTransporter, 'function', 'createTransporter should be exported');
    assert.strictEqual(typeof smtpUtils.verifySmtpConnection, 'function', 'verifySmtpConnection should be exported');
    assert.strictEqual(typeof smtpUtils.sendTestEmail, 'function', 'sendTestEmail should be exported');
    console.log('✓ src/utils/smtp.js functions available');

    console.log('\n--- 3. Testing createTransporter configuration ---');
    const transport = smtpUtils.createTransporter({
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        user: 'testuser',
        pass: 'testpass'
    });
    assert.strictEqual(transport.options.host, 'smtp.example.com', 'Host matched');
    assert.strictEqual(transport.options.port, 465, 'Port matched');
    assert.strictEqual(transport.options.secure, true, 'Secure matched');
    assert.strictEqual(transport.options.auth.user, 'testuser', 'User matched');
    assert.strictEqual(transport.options.auth.pass, 'testpass', 'Pass matched');
    console.log('✓ createTransporter builds valid transporter configuration');

    console.log('\n--- 4. Testing sendTestEmail parameter validation ---');
    const invalidRecipient = await smtpUtils.sendTestEmail({}, 'invalid-email');
    assert.strictEqual(invalidRecipient.success, false, 'Should fail on invalid recipient');
    assert(invalidRecipient.error.includes('valid recipient email'), 'Should indicate valid email required');
    console.log('✓ sendTestEmail validates recipient address properly');

    console.log('\n--- 5. Testing API Authentication with WebUI ---');
    // Login to get valid auth token
    const loginRes = await request({
        hostname: 'localhost',
        port: 8080,
        path: '/api/auth/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { username: 'admin', password: 'admin123' });

    assert.strictEqual(loginRes.status, 200, 'Login should succeed');
    const token = loginRes.body.token;
    assert(token, 'Should receive session token');
    console.log('✓ Authenticated as admin, received session token');

    console.log('\n--- 6. Testing GET /api/smtp/config (unauthorized vs authorized) ---');
    const unauthGet = await request({
        hostname: 'localhost',
        port: 8080,
        path: '/api/smtp/config',
        method: 'GET'
    });
    assert.strictEqual(unauthGet.status, 401, 'Unauthenticated GET should be rejected when auth is enabled');

    const authGet = await request({
        hostname: 'localhost',
        port: 8080,
        path: '/api/smtp/config',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.strictEqual(authGet.status, 200, 'Authenticated GET should succeed');
    assert.strictEqual(authGet.body.status, 'ok');
    assert(authGet.body.config, 'Should return config');
    console.log('✓ GET /api/smtp/config properly enforces authentication');

    console.log('\n--- 7. Testing POST /api/smtp/config Validation ---');
    // Invalid port
    const badPortRes = await request({
        hostname: 'localhost',
        port: 8080,
        path: '/api/smtp/config',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    }, { port: 99999 });
    assert.strictEqual(badPortRes.status, 400, 'Invalid port should return 400');
    assert(badPortRes.body.error.includes('Port must be a valid number'), 'Error message for port');

    // Invalid from email
    const badEmailRes = await request({
        hostname: 'localhost',
        port: 8080,
        path: '/api/smtp/config',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    }, { fromEmail: 'invalid-from-email' });
    assert.strictEqual(badEmailRes.status, 400, 'Invalid fromEmail should return 400');
    console.log('✓ Input validation rejects invalid port numbers and malformed email addresses');

    console.log('\n--- 8. Testing POST /api/smtp/config Saving Valid Settings ---');
    const saveRes = await request({
        hostname: 'localhost',
        port: 8080,
        path: '/api/smtp/config',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    }, {
        enabled: true,
        host: 'smtp.mailgun.org',
        port: 587,
        secure: false,
        user: 'postmaster@mg.example.com',
        pass: 'secret-smtp-password-123',
        fromEmail: 'noreply@example.com',
        fromName: 'Antigravity Notifications'
    });

    assert.strictEqual(saveRes.status, 200, 'Saving valid SMTP settings should succeed');
    assert.strictEqual(saveRes.body.status, 'ok');
    assert.strictEqual(saveRes.body.config.enabled, true);
    assert.strictEqual(saveRes.body.config.host, 'smtp.mailgun.org');
    assert.strictEqual(saveRes.body.config.port, 587);
    assert.strictEqual(saveRes.body.config.secure, false);
    assert.strictEqual(saveRes.body.config.user, 'postmaster@mg.example.com');
    assert.strictEqual(saveRes.body.config.pass, '********', 'Password must be redacted in response');
    assert.strictEqual(saveRes.body.config.hasPassword, true, 'hasPassword should be true');
    assert.strictEqual(saveRes.body.config.fromEmail, 'noreply@example.com');
    assert.strictEqual(saveRes.body.config.fromName, 'Antigravity Notifications');
    console.log('✓ SMTP configuration saved and password safely redacted');

    console.log('\n--- 9. Testing Password Preservation When Empty String Sent ---');
    const preserveRes = await request({
        hostname: 'localhost',
        port: 8080,
        path: '/api/smtp/config',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    }, {
        fromName: 'Antigravity Updated Name',
        pass: '' // Empty string should keep existing password
    });
    assert.strictEqual(preserveRes.status, 200);
    assert.strictEqual(preserveRes.body.config.hasPassword, true, 'Should preserve existing password');
    assert.strictEqual(preserveRes.body.config.fromName, 'Antigravity Updated Name');
    console.log('✓ Empty password string preserves existing stored credential');

    console.log('\n--- 10. Testing POST /api/smtp/test Handshake Diagnostics ---');
    const testRes = await request({
        hostname: 'localhost',
        port: 8080,
        path: '/api/smtp/test',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    }, {
        action: 'verify',
        host: '127.0.0.1',
        port: 65432, // Non-existent port to test error handling & diagnostics
        user: 'test',
        pass: 'test'
    });
    assert.strictEqual(testRes.status, 400, 'Connection failure should return 400 with diagnostic');
    assert(testRes.body.error, 'Should contain error description');
    console.log('✓ SMTP test endpoint captures and returns clean socket/credential diagnostics');

    console.log('\n🎉 ALL SMTP TESTS COMPLETED SUCCESSFULLY!\n');
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
