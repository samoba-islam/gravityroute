#!/usr/bin/env node

/**
 * GravityRoute Cloudflare Worker - Local OAuth Callback Listener
 * 
 * Automatically captures Google OAuth redirects on port 51121 and forwards
 * them to your deployed Cloudflare Worker database.
 * 
 * Usage:
 *   node oauth-listener.js [WORKER_URL]
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

const WORKER_URL = process.argv[2] || process.env.WORKER_URL || 'https://gravityroute-worker.maskbd.workers.dev';
const PORT = parseInt(process.env.OAUTH_PORT || '51121', 10);

const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    
    if (reqUrl.pathname === '/oauth-callback') {
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');
        const error = reqUrl.searchParams.get('error');

        if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <html>
                <body style="font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                    <div style="background:#1e293b;padding:32px;border-radius:12px;border:1px solid #ef4444;text-align:center;max-width:480px;">
                        <h2 style="color:#ef4444;margin-top:0;">❌ Authentication Error</h2>
                        <p style="color:#94a3b8;">${error}</p>
                    </div>
                </body>
                </html>
            `);
            return;
        }

        if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('Missing code parameter');
            return;
        }

        console.log(`[OAuth Listener] Received auth callback code, forwarding to ${WORKER_URL}...`);

        try {
            // Forward to Cloudflare Worker
            const postData = JSON.stringify({
                callbackInput: code,
                state: state
            });

            const workerEndpoint = new URL('/api/auth/complete', WORKER_URL);
            const client = workerEndpoint.protocol === 'https:' ? https : http;

            const proxyReq = client.request(workerEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            }, (proxyRes) => {
                let body = '';
                proxyRes.on('data', chunk => body += chunk);
                proxyRes.on('end', () => {
                    let result = {};
                    try { result = JSON.parse(body); } catch (e) {}

                    if (proxyRes.statusCode === 200 && result.status === 'ok') {
                        console.log(`[OAuth Listener] Successfully added account: ${result.email}`);
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`
                            <html>
                            <head><title>Authentication Successful</title></head>
                            <body style="font-family:system-ui,sans-serif;background:#0b0f19;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                                <div style="background:#161f30;padding:40px;border-radius:16px;border:1px solid #10b981;text-align:center;max-width:480px;box-shadow:0 20px 25px -5px rgba(0,0,0,0.5);">
                                    <div style="font-size:48px;margin-bottom:16px;">✨</div>
                                    <h2 style="color:#34d399;margin-top:0;font-size:24px;">Connected Successfully!</h2>
                                    <p style="color:#94a3b8;font-size:15px;margin-bottom:24px;">Account <strong>${result.email || ''}</strong> has been added to your GravityRoute console.</p>
                                    <p style="color:#64748b;font-size:13px;">This window will close automatically...</p>
                                    <script>setTimeout(() => { window.close(); }, 2000);</script>
                                </div>
                            </body>
                            </html>
                        `);
                    } else {
                        console.error(`[OAuth Listener] Worker returned error:`, body);
                        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`
                            <html>
                            <body style="font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                                <div style="background:#1e293b;padding:32px;border-radius:12px;border:1px solid #ef4444;text-align:center;max-width:480px;">
                                    <h2 style="color:#ef4444;margin-top:0;">Failed to Add Account</h2>
                                    <p style="color:#94a3b8;">${result.error || 'Server error'}</p>
                                </div>
                            </body>
                            </html>
                        `);
                    }
                });
            });

            proxyReq.on('error', (err) => {
                console.error('[OAuth Listener] Request error:', err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Error contacting worker: ${err.message}`);
            });

            proxyReq.write(postData);
            proxyReq.end();

        } catch (err) {
            console.error('[OAuth Listener] Error:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(err.message);
        }
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[OAuth Listener] Ready on http://localhost:${PORT}/oauth-callback`);
    console.log(`[OAuth Listener] Forwarding to: ${WORKER_URL}`);
});
