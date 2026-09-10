# API Endpoints

GravityRoute exposes endpoints for AI proxying (Anthropic & OpenAI compatible), system health and monitoring, WebUI authentication, and SMTP configuration.

---

## 1. AI Proxy & Health Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/health` | GET | Health check returns server status, uptime, and active accounts count |
| `/account-limits` | GET | Account quota statuses, tier limits, and next reset times. Add `?format=table` for ASCII table output |
| `/v1/messages` | POST | **Anthropic Messages API** endpoint (compatible with Claude Code CLI, Cursor, Continue.dev, etc.) |
| `/v1/models` | GET | List available models in Anthropic / OpenAI compatible JSON format |
| `/v1/chat/completions` | POST | **OpenAI Chat Completions** endpoint for OpenAI SDKs and integrations |
| `/refresh-token` | POST | Force refresh OAuth access tokens for active accounts |

---

## 2. WebUI Authentication & Security Endpoints

These endpoints govern console security, session lifecycle, and credential updates:

| Endpoint | Method | Auth Required | Description |
| :--- | :--- | :--- | :--- |
| `/api/auth/status` | GET | No | Returns public auth state: `{ enabled: boolean, authenticated: boolean, user: string, hasEmail: boolean, hasSmtp: boolean }` |
| `/api/auth/login` | POST | No | Authenticate using `{ identifier, password, rememberMe }`. Returns session token and sets secure cookie |
| `/api/auth/logout` | POST | Yes | Invalidates the active session token and clears auth cookies |
| `/api/auth/config` | GET | Yes | Retrieves current WebUI authentication settings and recovery toggles |
| `/api/auth/config` | POST | Yes | Updates WebUI authentication settings (`enabled`, `cliEnabled`, `emailEnabled`) |
| `/api/auth/credentials`| POST | Yes | Update administrator credentials `{ username, email, currentPassword, newPassword }` |

---

## 3. Password Recovery Endpoints

Publicly accessible endpoints for restoring lost administrator credentials:

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/auth/recovery-status` | GET | Returns available recovery methods (`cliEnabled`, `emailEnabled`, `hasEmail`, `hasSmtp`, masked admin email) |
| `/api/auth/forgot-password` | POST | Generates a 15-minute cryptographic 6-digit OTP and delivers it to the admin email via SMTP. Body: `{ identifier }` |
| `/api/auth/reset-password` | POST | Validates OTP code and resets administrator password. Body: `{ code, newPassword }` |

---

## 4. SMTP Mail Server Endpoints

Endpoints for managing outbound notification and password recovery emails (requires WebUI authentication if enabled):

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/smtp/config` | GET | Returns current SMTP server settings (password is masked for security) |
| `/api/smtp/config` | POST | Saves SMTP configuration `{ host, port, user, pass, secure, from }` |
| `/api/smtp/test` | POST | Dispatches a live test email to a recipient address and returns SMTP diagnostic logs |

---

## 5. Account & Configuration Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/accounts` | GET | List configured Google accounts with quota metrics and health badges |
| `/api/accounts/add` | POST | Initiate OAuth flow or submit authorization code in headless mode |
| `/api/accounts/:id` | DELETE | Remove an account from the pool |
| `/api/accounts/export` | GET | Securely export configured accounts as JSON |
| `/api/accounts/import` | POST | Import accounts from JSON with schema validation and duplicate handling |
| `/api/models/config` | GET / POST | Get or update model alias mappings, hidden flags, and pinned preferences |
| `/api/config/server` | GET / POST | View and update server presets, timeouts, and developer mode settings |

---

## 6. Granular API Key Management Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/keys` | GET | List all generated API keys with usage stats, token quotas, and active status |
| `/api/keys` | POST | Generate a new proxy API key (`gr-...`) with optional model restrictions, token quotas, and IP whitelist |
| `/api/keys/:id` | PUT | Modify existing key limits, model restrictions, IP filtering, or name |
| `/api/keys/:id` | DELETE | Revoke and delete an API key |

---

## 7. Custom Providers Endpoints (OpenAI & Anthropic Compatible)

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/providers/custom` | GET | List all registered custom upstream providers |
| `/api/providers/custom` | POST | Register a new OpenAI-compatible or Anthropic-compatible provider with base URL, API key, model list, token limits, and spend cap |
| `/api/providers/custom/:id` | PUT | Update custom provider configurations, models, or rate limits |
| `/api/providers/custom/:id` | DELETE | Remove a custom provider |
| `/api/providers/custom/test` | POST | Test connectivity and model response from a custom provider |

