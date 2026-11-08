const http = require('http');

async function runTests() {
    console.log('Testing server stability and memory leak fixes...');
    
    // Set PORT to 8098 for testing
    process.env.PORT = '8098';
    process.env.DEBUG = 'false';

    const { default: app } = await import('../src/server.js');
    const { logger } = await import('../src/utils/logger.js');

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(8098, '127.0.0.1', resolve));
    console.log('Test server listening on http://127.0.0.1:8098');

    try {
        // Authenticate to get session token
        let authToken = '';
        const loginRes = await fetch('http://127.0.0.1:8098/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'admin123' })
        });
        const loginData = await loginRes.json();
        if (loginData.token) {
            authToken = loginData.token;
            console.log('Authenticated successfully for WebUI');
        }

        const authHeaders = authToken ? { 'Authorization': `Bearer ${authToken}` } : {};

        // Test 1: SSE connection and listener cleanup
        console.log('\n--- Test 1: SSE Streaming & Cleanup ---');
        const initialListeners = logger.listenerCount('log');
        console.log(`Initial logger 'log' listeners: ${initialListeners}`);

        // Open SSE connection
        const sseReq = http.request({
            hostname: '127.0.0.1',
            port: 8098,
            path: '/api/logs/stream?history=false',
            method: 'GET',
            headers: authHeaders
        });

        const connectedPromise = new Promise((resolve, reject) => {
            sseReq.on('response', (res) => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Expected 200, got ${res.statusCode}`));
                }
                res.on('data', (chunk) => {
                    const text = chunk.toString();
                    if (text.includes(': connected')) {
                        resolve(res);
                    }
                });
            });
            sseReq.on('error', reject);
        });

        sseReq.end();
        const sseRes = await connectedPromise;
        console.log('SSE connection established and : connected comment received');

        const listenersDuringSSE = logger.listenerCount('log');
        console.log(`Listeners during active SSE: ${listenersDuringSSE}`);
        if (listenersDuringSSE !== initialListeners + 1) {
            throw new Error(`Expected ${initialListeners + 1} listeners, got ${listenersDuringSSE}`);
        }

        // Test log emission
        const testLogPromise = new Promise((resolve) => {
            sseRes.on('data', (chunk) => {
                const text = chunk.toString();
                if (text.includes('Stability test message')) {
                    resolve(true);
                }
            });
        });

        logger.info('Stability test message');
        await testLogPromise;
        console.log('Successfully received live log event via SSE');

        // Close connection from client side
        sseReq.destroy();
        // Wait a tick for close event
        await new Promise((r) => setTimeout(r, 200));

        const listenersAfterClose = logger.listenerCount('log');
        console.log(`Listeners after client disconnect: ${listenersAfterClose}`);
        if (listenersAfterClose !== initialListeners) {
            throw new Error(`Listener leak! Expected ${initialListeners}, got ${listenersAfterClose}`);
        }
        console.log('PASS: Single SSE connection cleanly removed listener on disconnect');

        // Test 2: Multiple reconnects cycle (simulating laptop sleep/tab refresh)
        console.log('\n--- Test 2: Rapid Connect/Disconnect Cycles (Leak check) ---');
        for (let i = 0; i < 20; i++) {
            const req = http.request({
                hostname: '127.0.0.1',
                port: 8098,
                path: '/api/logs/stream?history=false',
                method: 'GET',
                headers: authHeaders
            });
            req.end();
            await new Promise((r) => setTimeout(r, 20));
            req.destroy();
        }
        await new Promise((r) => setTimeout(r, 300));

        const listenersAfterBurst = logger.listenerCount('log');
        console.log(`Listeners after 20 rapid disconnects: ${listenersAfterBurst} (baseline: ${initialListeners})`);
        if (listenersAfterBurst !== initialListeners) {
            throw new Error(`Leak detected in reconnect burst! Count is ${listenersAfterBurst}`);
        }
        console.log('PASS: Zero leaked listeners across rapid reconnects');

        // Test 3: /account-limits caching and response speed
        console.log('\n--- Test 3: /account-limits Caching & Fast Response ---');
        const start1 = Date.now();
        const res1 = await fetch('http://127.0.0.1:8098/account-limits', { headers: authHeaders });
        const time1 = Date.now() - start1;
        const data1 = await res1.json();
        console.log(`First /account-limits took ${time1}ms, status: ${res1.status}`);

        const start2 = Date.now();
        const res2 = await fetch('http://127.0.0.1:8098/account-limits', { headers: authHeaders });
        const time2 = Date.now() - start2;
        const data2 = await res2.json();
        console.log(`Second /account-limits took ${time2}ms (cached), status: ${res2.status}`);

        if (time2 > 50) {
            console.warn(`Warning: Cached response took ${time2}ms (expected <50ms)`);
        } else {
            console.log(`PASS: Second request was served from memory cache in ${time2}ms!`);
        }

        // Test 4: Concurrent /account-limits requests
        console.log('\n--- Test 4: Concurrent Request Coalescing ---');
        const concurrentStarts = Array(8).fill(null).map(() => fetch('http://127.0.0.1:8098/account-limits', { headers: authHeaders }));
        const concurrentResults = await Promise.all(concurrentStarts);
        for (const res of concurrentResults) {
            if (res.status !== 200) {
                throw new Error(`Concurrent fetch returned status ${res.status}`);
            }
        }
        console.log(`PASS: All 8 concurrent /account-limits requests completed with status 200`);

        console.log('\n ALL STABILITY & MEMORY LEAK TESTS PASSED SUCCESSFULLY!');
    } finally {
        server.close();
    }
}

runTests().catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
