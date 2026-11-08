# GravityRoute for Cloudflare Workers 🌐

High-performance AI proxy router and multi-account load balancer for **Claude** (3.5 Sonnet, 3.7 Sonnet thinking) and **Gemini** (2.5 Flash, 2.5 Pro, 3 Pro) models running entirely serverless on **Cloudflare Workers** backed by **Cloudflare D1**.

---

## Features

- ⚡ **Zero-Server Maintenance**: Runs on Cloudflare's global edge network across 300+ data centers.
- 🔀 **Multi-Account Quota Pooling**: Automatically load-balances across multiple Google accounts and rotates accounts on 429 rate limits.
- 💾 **Serverless SQLite (D1)**: Persistent account storage, API key management, and token analytics stored in Cloudflare D1.
- 🌊 **Real-Time Streaming**: Native Web `ReadableStream` SSE streaming with thinking block support.
- 🛠️ **Claude Code CLI & Cursor Compatibility**: Exposes standard Anthropic (`/v1/messages`) and OpenAI (`/v1/chat/completions`) endpoints.
- 🖥️ **Web Management Console**: Built-in dark mode dashboard to manage accounts, generate keys, and view usage metrics.

---

## Directory Structure

```
cloudflare-worker/
├── wrangler.toml       # Cloudflare Worker & D1 binding configuration
├── schema.sql          # D1 SQLite table initialization script
├── package.json        # Dependencies (Hono & Wrangler)
└── src/
    ├── index.js        # Main Hono application entry point
    ├── constants.js    # Cloud Code API endpoints & headers
    ├── db/queries.js   # Cloudflare D1 database operations
    ├── auth/oauth.js   # Google OAuth token refresh & web callback
    ├── format/         # Anthropic <-> Google Cloud Code schema conversion
    ├── openai/         # OpenAI <-> Anthropic schema conversion
    ├── cloudcode/      # Request builder, session manager, and SSE streamer
    ├── routes/         # API routes (/v1/messages, /v1/chat/completions, /v1/models)
    └── ui/dashboard.js # Web Management Console UI
```

---

## 1. Quickstart (Local Development)

### Step 1: Install Dependencies
```bash
cd cloudflare-worker
npm install
```

### Step 2: Initialize Local D1 Database
This creates the SQLite tables in your local `.wrangler` environment:
```bash
npm run db:init:local
```

### Step 3: Start Local Dev Server
```bash
npm run dev
```
Open [http://localhost:8787](http://localhost:8787) in your browser to open the Web Management Console!

---

## 2. Deploy to Cloudflare Workers

### Step 1: Log in to Cloudflare
```bash
npx wrangler login
```

### Step 2: Create your Cloudflare D1 Database
Run the following command to create a D1 database on your Cloudflare account:
```bash
npx wrangler d1 create gravityroute-db
```

Wrangler will output something like:
```toml
[[d1_databases]]
binding = "DB"
database_name = "gravityroute-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### Step 3: Update `wrangler.toml`
Open `wrangler.toml` and replace `database_id = "local-dev-db"` with your real `database_id` from Step 2.

### Step 4: Initialize the Remote Database Schema
Execute the schema script against your live D1 database:
```bash
npm run db:init:remote
```

### Step 5: Deploy the Worker
```bash
npm run deploy
```

Wrangler will output your live URL, e.g.:
```
https://gravityroute-worker.<your-subdomain>.workers.dev
```

---

## 3. Connecting Google Accounts

1. Open your Worker URL in your browser: `https://your-worker.workers.dev`
2. Click **"Connect Google"** at the top right to authorize your Google account.
3. Once authorized, the account and refresh token are securely saved into your Cloudflare D1 database.
4. *(Optional)* You can also click **"Add Token Manually"** to paste pre-generated OAuth refresh tokens.

---

## 4. Client Setup

### Claude Code CLI
Set the base URL to your Cloudflare Worker URL:
```bash
export ANTHROPIC_BASE_URL="https://gravityroute-worker.<your-subdomain>.workers.dev"
claude
```

### Cursor / Continue.dev / OpenAI SDK
Configure the OpenAI-compatible endpoint:
- **Base URL**: `https://gravityroute-worker.<your-subdomain>.workers.dev/v1`
- **API Key**: Any custom key generated under the **Proxy API Keys** section in your dashboard, or leave blank if no key is configured.
- **Model**: `claude-3-7-sonnet`, `claude-3-5-sonnet`, or `gemini-2.5-pro`.
