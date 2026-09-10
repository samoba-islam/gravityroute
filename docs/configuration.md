# Advanced Configuration

While most users can use the default settings, you can tune **GravityRoute** proxy behavior via the **Settings** tabs in the WebUI or by modifying the JSON configuration file located at:

- **macOS / Linux**: `~/.config/gravityroute/config.json`
- **Windows**: `%USERPROFILE%\.config\gravityroute\config.json`

*(Note: GravityRoute automatically maintains backward compatibility with existing `~/.config/antigravity-proxy` installations).*

---

## Environment Variables

The proxy supports the following environment variables:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | WebUI and proxy server port | `8080` |
| `HOST` | Bind address | `0.0.0.0` |
| `HTTP_PROXY` | Outbound HTTP proxy URL | - |
| `HTTPS_PROXY` | Outbound HTTPS proxy URL | - |
| `API_KEY` | Protect `/v1/*` API endpoints with an API key | - |
| `WEBUI_AUTH_ENABLED` | Enable WebUI login authentication (`true`/`false`) | `false` |
| `WEBUI_USERNAME` | WebUI administrator username | `admin` |
| `WEBUI_PASSWORD` | WebUI administrator password (plain text or bcrypt hash) | - |
| `WEBUI_EMAIL` | Administrator recovery email address | - |
| `WEBUI_RECOVERY_CLI_ENABLED` | Enable Host Terminal / CLI password reset (`true`/`false`) | `true` |
| `WEBUI_RECOVERY_EMAIL_ENABLED` | Enable Admin Email OTP password recovery (`true`/`false`) | `true` |
| `SMTP_HOST` | Outbound SMTP mail server hostname | - |
| `SMTP_PORT` | Outbound SMTP mail server port (e.g. `587`, `465`) | `587` |
| `SMTP_USER` | Outbound SMTP username | - |
| `SMTP_PASS` | Outbound SMTP password | - |
| `SMTP_SECURE` | Use SSL/TLS connection (`true`/`false`) | `false` |
| `SMTP_FROM` | Outbound email "From" header address | - |
| `DEBUG` | Enable verbose debug logging (`true`/`false`) | `false` |
| `DEV_MODE` | Enable developer mode (`true`/`false`) | `false` |
| `FALLBACK` | Enable model fallback on quota exhaustion (`true`/`false`) | `false` |
| `FALLBACK_ANTIGRAVITY_VERSION` | Override the User-Agent version string | `1.23.2` |
| `ANTIGRAVITY_CLIENT_VERSION` | Override the `X-Client-Version` header | Auto-detected |
| `CLAUDE_CONFIG_PATH` | Path to `.claude` directory for CLI settings (for systemd/services) | `~/.claude` |

---

## Setting Environment Variables

### Inline (Single Command)
```bash
PORT=3000 WEBUI_AUTH_ENABLED=true WEBUI_PASSWORD=admin123 npm start
```

### macOS / Linux (Persistent)
Add to your shell profile (`~/.zshrc` or `~/.bashrc`):
```bash
export PORT=3000
export WEBUI_AUTH_ENABLED=true
export WEBUI_PASSWORD=admin123
```
Then reload: `source ~/.zshrc`

### Windows PowerShell (Persistent)
```powershell
[Environment]::SetEnvironmentVariable("PORT", "3000", "User")
[Environment]::SetEnvironmentVariable("WEBUI_AUTH_ENABLED", "true", "User")
```

### Windows Command Prompt (Persistent)
```cmd
setx PORT 3000
setx WEBUI_AUTH_ENABLED true
```

---

## WebUI Authentication & Security

You can configure authentication via the **Settings → WebUI Auth** tab:

1. **Enable / Disable WebUI Auth**: Toggle authentication on or off instantly.
2. **Admin Credentials**:
   - Change your administrator username.
   - Attach an optional **Email ID** for password recovery.
   - Update your password (requires your current password for security).
3. **Session Persistence**:
   - Check **Saved Login** on the login screen to stay signed in across browser sessions.
   - Clicking **Log Out** immediately revokes the session on the server.

---

## Password Recovery Modes

GravityRoute provides two independent password recovery methods:

### Method 1: Host Terminal / CLI Reset (Recommended for Admins)
If you ever forget your password or lose access to the WebUI, run the standalone reset command from the server terminal:

```bash
# Run reset script
npm run reset-password <new_password> [username]

# Or using the gravityroute binary
gravityroute reset-password <new_password>

# Example:
npm run reset-password MyNewSecretPass123
```

This updates credentials directly on disk and syncs immediately without requiring a server restart.

### Method 2: Admin Email Recovery via SMTP
1. On the login screen, click **Forgot Password?**.
2. Switch to the **Email Recovery** tab.
3. Enter your administrator username or registered email address.
4. GravityRoute generates a 6-digit cryptographic OTP code valid for 15 minutes and sends it to your email via the configured SMTP server.
5. Enter the code and your new password to restore access.

---

## SMTP Server Configuration

Configure your outgoing mail server in **Settings → SMTP**:
- **Host**: e.g., `smtp.gmail.com`, `smtp.mailgun.org`, `smtp.office365.com`
- **Port**: `587` (STARTTLS) or `465` (SSL)
- **Username & Password**: Mail account credentials (or App Password)
- **Secure (TLS)**: Check for port 465, uncheck for port 587
- **From Address**: e.g., `GravityRoute Alerts <alerts@yourdomain.com>`

Use the **Send Test Email** button in the WebUI to verify connectivity and credentials in real time.

---

## Routing & Load Balancing Configuration

- **Account Selection Strategies**:
  - `hybrid`: Smart balanced distribution with cooldowns (Default).
  - `sticky`: Session cache-optimized routing.
  - `round-robin`: Cycles through accounts evenly.
- **Quota Protection**:
  - `globalQuotaThreshold`: Float from `0` to `0.99` (e.g. `0.2` = rotate account when 20% quota remains).
  - Supports per-account and per-model threshold overrides.
- **Retry Logic**: Configurable `maxRetries`, `retryBaseMs`, and `retryMaxMs` with intelligent `Retry-After` header parsing.
