# CLAUDE.md

**GravityRoute** is a Node.js proxy server and intelligent router exposing Anthropic-compatible and OpenAI-compatible APIs backed by Google Cloud Code, enabling Claude Code CLI, Cursor, Continue.dev, and OpenAI SDKs to use Claude and Gemini models seamlessly with multi-account quota pooling.

Request flow: `Client (Claude Code / Cursor / OpenAI SDK) → Express (src/index.js) → Strategy Router → CloudCode Client → Google Cloud Code API`

---

## Commands

```bash
npm install          # installs deps and builds CSS (prepare hook)
npm run build        # compiles minified Tailwind CSS
npm start            # starts GravityRoute server on port 8080
npm run dev          # watch server files
npm run dev:full     # watch CSS + server files concurrently

npm start -- --strategy=sticky       # cache-optimized routing (default: hybrid)
npm start -- --strategy=round-robin  # load-balanced routing
npm start -- --fallback              # fall back to alternate model on quota exhaustion
npm start -- --dev-mode              # enables debug logging + dev tools

npm run build:css    # compile Tailwind once
npm run watch:css    # watch CSS

npm run accounts:add                 # add Google account via OAuth
npm run accounts:add -- --no-browser # headless/manual authorization code input
npm run accounts:list                # list configured accounts
npm run accounts:verify              # verify account tokens and permissions

npm run reset-password <new_password> [username]  # direct CLI password reset
npm run password:reset                            # alias for reset-password

npm test                             # run full test suite (requires server on 8080)
node tests/run-all.cjs <filter>      # run matching tests only
node tests/test-webui-auth.cjs       # test WebUI authentication & sessions
node tests/test-password-recovery.cjs# test CLI reset & email OTP password recovery
node tests/test-smtp.cjs             # test SMTP configuration & diagnostics
node tests/test-strategies.cjs       # strategy unit tests (no server needed)
```

---

## Architecture & Non-Obvious Things

- **Config Directory**: Standard path is `~/.config/gravityroute/config.json`. Automatically checks and falls back to `~/.config/antigravity-proxy` to preserve legacy user data seamlessly.
- **CSS Architecture**: Source is `public/css/src/input.css` (Tailwind + `@apply`). Output is `public/css/style.css` — do not edit the compiled file directly.
- **WebUI Auth & Dual Recovery**:
  - WebUI Auth supports username, email ID, bcrypt passwords, and session tokens.
  - Recovery modes include **Host Terminal CLI reset** (`npm run reset-password`) and **Admin Email OTP** via SMTP (15-min TTL, 5-attempt rate limit).
  - Toggles for both modes are managed under `#settings/auth`.
- **SMTP Module**: Supports TLS (port 465) and STARTTLS (port 587), password masking, and live diagnostic testing.
- **Multi-Language Localization**: Full translation dictionaries in `public/js/translations/` (`en`, `bn`, `zh`, `tr`, `id`, `pt`). Global store automatically falls back: current language -> English -> blank.
- **Quota Thresholds**: Stored as fractions (`0` to `0.99`), displayed as percentages in UI. Hierarchy: per-model > per-account > global.
- **`cache_control` Stripping**: Claude Code sends `cache_control` on content blocks; Cloud Code API rejects them. Stripped at the start of `convertAnthropicToGoogle()` before request transmission.
- **Cross-Model Thinking Signatures**: Claude and Gemini signatures are distinct. When switching models mid-turn, mismatched signatures are stripped to avoid API rejection.
- **`CLAUDE_CONFIG_PATH`**: Set this when running as a systemd service so the proxy finds `~/.claude/settings.json` under the real user's home directory.
- **Dev Mode Sub-Toggles**: Client-side only (`localStorage` via `settings-store.js`): redact mode, debug logging, log export, health inspector.
