const http = require('http');

async function testUpdateEndpoints() {
    console.log('Testing System Updater Endpoints...');

    process.env.PORT = '8097';
    process.env.DEBUG = 'false';

    const { default: app } = await import('../src/server.js');
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(8097, '127.0.0.1', resolve));

    try {
        // Authenticate
        const loginRes = await fetch('http://127.0.0.1:8097/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin123' })
        });
        const loginData = await loginRes.json();
        const authToken = loginData.token;
        const authHeaders = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};

        // Test GET /api/system/update/check
        console.log('Testing GET /api/system/update/check...');
        const checkRes = await fetch('http://127.0.0.1:8097/api/system/update/check?force=true', {
            headers: authHeaders
        });

        if (checkRes.status !== 200) {
            throw new Error(`Expected 200, got ${checkRes.status}`);
        }

        const data = await checkRes.json();
        console.log('Update Check Result:', JSON.stringify(data, null, 2));

        if (data.status !== 'ok') {
            throw new Error('Expected status to be ok');
        }

        if (typeof data.isGitRepo !== 'boolean') {
            throw new Error('Expected isGitRepo boolean');
        }

        console.log('PASS: GET /api/system/update/check responded correctly!');
    } finally {
        server.close();
    }
}

testUpdateEndpoints().then(() => {
    console.log('ALL UPDATER ENDPOINT TESTS PASSED!');
    process.exit(0);
}).catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});

