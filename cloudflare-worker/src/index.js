/**
 * GravityRoute Cloudflare Worker - Main Entry Point
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handleMessages } from './routes/messages.js';
import { handleOpenAiChat } from './routes/openai.js';
import { handleListModels, handleGetSingleModel } from './routes/models.js';
import { registerAdminRoutes } from './routes/admin.js';

const app = new Hono();

// Enable CORS for all incoming client requests
app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-webui-token', 'x-webui-password', 'anthropic-version', 'anthropic-beta']
}));

// Health check endpoint
app.get('/health', (c) => {
    return c.json({
        status: 'ok',
        service: 'gravityroute-cloudflare-worker',
        timestamp: new Date().toISOString()
    });
});

// Force token refresh endpoint
app.post('/refresh-token', (c) => {
    return c.json({ status: 'ok', message: 'Tokens refreshed' });
});

// Anthropic API proxy routes
app.post('/v1/messages', handleMessages);

// OpenAI API proxy routes
app.post('/v1/chat/completions', handleOpenAiChat);
app.post('/chat/completions', handleOpenAiChat);

// Model listing (Dual OpenAI & Anthropic compatibility)
app.get('/v1/models', handleListModels);
app.get('/models', handleListModels);
app.get('/v1/models/:model', handleGetSingleModel);
app.get('/models/:model', handleGetSingleModel);

// Register complete WebUI & Admin API suite
registerAdminRoutes(app);

// Serve root SPA shell
app.get('/', (c) => {
    const url = new URL(c.req.url);
    return c.redirect('/index.html' + url.search);
});

// Fallback to Cloudflare Static Assets for WebUI frontend (views, styles, scripts)
app.get('*', async (c) => {
    if (c.env.ASSETS) {
        return c.env.ASSETS.fetch(c.req.raw);
    }
    return c.text('Not found', 404);
});

// Global error handler
app.onError((err, c) => {
    console.error('Worker unhandled error:', err);
    return c.json({
        error: {
            message: err.message || 'Internal Server Error',
            type: 'api_error'
        }
    }, 500);
});

export default app;
