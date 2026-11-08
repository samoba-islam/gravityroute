const https = require('https');

const API_KEY = 'ag-sk-08cb05cdef744379565849d9dd632fce99758d621de27eae';
const HOST = 'gravityroute-worker.maskbd.workers.dev';

const models = [
    'claude-opus-4-6-thinking',
    'claude-sonnet-4-6',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash-thinking',
    'gemini-2.5-pro',
    'gemini-3-flash',
    'gemini-3-flash-agent',
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-high',
    'gemini-3.1-pro-low',
    'gemini-3.5-flash-extra-low',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash-low',
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-low',
    'gemini-3.6-flash-medium',
    'gemini-3.6-flash-tiered',
    'gemini-3.7-flash-tiered',
    'gemini-3.8-flash-tiered',
    'gemini-pro-agent'
];

function testModel(modelId) {
    return new Promise((resolve) => {
        const start = Date.now();
        const payload = JSON.stringify({
            model: modelId,
            max_tokens: 30,
            messages: [{ role: 'user', content: 'Say OK' }]
        });

        const req = https.request({
            hostname: HOST,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                const elapsed = Date.now() - start;
                let parsed = null;
                try { parsed = JSON.parse(body); } catch (e) {}

                let reply = '';
                if (parsed && parsed.content && Array.isArray(parsed.content)) {
                    reply = parsed.content.map(c => c.text || (c.thinking ? `[thinking: ${c.thinking.slice(0, 30)}...]` : '')).filter(Boolean).join(' ').trim();
                } else if (parsed && parsed.error) {
                    reply = `ERROR: ${parsed.error.message || JSON.stringify(parsed.error)}`;
                } else {
                    reply = body.slice(0, 100);
                }

                resolve({
                    model: modelId,
                    status: res.statusCode,
                    duration: elapsed,
                    reply: reply.replace(/[\r\n]+/g, ' ').slice(0, 60),
                    success: res.statusCode === 200
                });
            });
        });

        req.on('error', (err) => {
            resolve({
                model: modelId,
                status: 'ERR',
                duration: Date.now() - start,
                reply: err.message,
                success: false
            });
        });

        req.setTimeout(25000, () => {
            req.destroy(new Error('Timeout'));
        });

        req.write(payload);
        req.end();
    });
}

(async () => {
    console.log(`Starting test across all ${models.length} Antigravity models on ${HOST}...\n`);
    const results = [];

    // Run sequentially with small pause to avoid local connection pooling spikes
    for (let i = 0; i < models.length; i++) {
        const m = models[i];
        process.stdout.write(`[${i + 1}/${models.length}] Testing ${m}... `);
        const res = await testModel(m);
        results.push(res);
        if (res.success) {
            console.log(`✓ 200 OK (${res.duration}ms): "${res.reply}"`);
        } else {
            console.log(`✗ ${res.status}: "${res.reply}"`);
        }
        await new Promise(r => setTimeout(r, 600));
    }

    console.log('\n================ SUMMARY ================');
    const passed = results.filter(r => r.success).length;
    console.log(`Passed: ${passed}/${models.length}`);
    console.log(JSON.stringify(results, null, 2));
})();
