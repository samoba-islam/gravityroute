-- GravityRoute Cloudflare D1 Database Schema

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    refresh_token TEXT NOT NULL,
    project_id TEXT DEFAULT 'rising-fact-p41fc',
    subscription_tier TEXT DEFAULT 'unknown',
    enabled INTEGER DEFAULT 1,
    source TEXT DEFAULT 'oauth',
    custom_config TEXT DEFAULT NULL,
    cooldown_until INTEGER DEFAULT 0,
    last_used INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT DEFAULT 'Default Key',
    status TEXT DEFAULT 'active',
    enabled INTEGER DEFAULT 1,
    tokens_used INTEGER DEFAULT 0,
    token_limit INTEGER DEFAULT 0,
    expires_at INTEGER DEFAULT NULL,
    last_used_at INTEGER DEFAULT NULL,
    ip_restriction_enabled INTEGER DEFAULT 0,
    ip_restriction_mode TEXT DEFAULT 'allow',
    ip_list TEXT DEFAULT '[]',
    model_restriction_enabled INTEGER DEFAULT 0,
    allowed_models TEXT DEFAULT '[]',
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id TEXT PRIMARY KEY,
    key_id TEXT,
    model TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    cost REAL DEFAULT 0.0,
    timestamp INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    remember_me INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_flows (
    state TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Seed initial settings
INSERT OR IGNORE INTO settings (key, value) VALUES ('routing_strategy', 'round-robin');
INSERT OR IGNORE INTO settings (key, value) VALUES ('fallback_enabled', 'true');
INSERT OR IGNORE INTO settings (key, value) VALUES ('webui_auth_enabled', 'false');
INSERT OR IGNORE INTO settings (key, value) VALUES ('webui_username', 'admin');
INSERT OR IGNORE INTO settings (key, value) VALUES ('webui_email', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('webui_password', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('webui_recovery_mode', '{"cliEnabled":true,"emailEnabled":false}');
