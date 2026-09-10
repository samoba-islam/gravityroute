# Troubleshooting

## Quick Links

- [Locked out of WebUI / Forgot Admin Password](#locked-out-of-webui--forgot-admin-password)
- [SMTP Test Email Fails / Emails Not Received](#smtp-test-email-fails--emails-not-received)
- [Windows: OAuth Port Error (EACCES)](#windows-oauth-port-error-eacces)
- ["Could not extract token from Antigravity"](#could-not-extract-token-from-antigravity)
- [401 Authentication Errors](#401-authentication-errors)
- [Rate Limiting (429)](#rate-limiting-429)
- [Account Shows as "Invalid"](#account-shows-as-invalid)
- [403 Permission Denied / VALIDATION_REQUIRED](#403-permission-denied--validation_required)

---

## Locked out of WebUI / Forgot Admin Password

If you are locked out of the GravityRoute Console or forgot your administrator password, you have several fast recovery options:

### Option 1: Terminal CLI Reset (Fastest & Recommended)
Run the built-in reset command directly from your server terminal:

```bash
# If running in repository directory:
npm run reset-password <new_password> [username]

# Or using the gravityroute binary:
gravityroute reset-password <new_password>

# Example:
npm run reset-password admin123
```

This writes the new password hash directly to your configuration disk file (`~/.config/gravityroute/config.json`) and takes effect immediately without needing a server restart.

### Option 2: Email OTP Recovery (If SMTP is configured)
1. On the login screen, click **Forgot Password?**.
2. Select the **Email Recovery** tab.
3. Enter your administrator username or email address.
4. Check your inbox for the 6-digit verification code (valid for 15 minutes).
5. Enter the code and choose your new password.

### Option 3: Temporarily Disable Authentication via Environment Variable
Restart the proxy server with authentication disabled:

```bash
WEBUI_AUTH_ENABLED=false npm start
```
Once inside the console, visit **Settings → WebUI Auth** to update your credentials, then re-enable authentication.

---

## SMTP Test Email Fails / Emails Not Received

If the **Send Test Email** button in **Settings → SMTP** returns an error:

1. **Gmail Users**:
   - Google does not permit signing into SMTP with your standard account password if 2FA is enabled.
   - Go to Google Account Settings → **Security** → **2-Step Verification** → **App Passwords**.
   - Generate an App Password (16 characters) and paste it into the **Password** field in the SMTP settings.
2. **Port & SSL/TLS Configuration**:
   - Port `465`: Set **Secure (TLS)** to `ON` (checked).
   - Port `587`: Set **Secure (TLS)** to `OFF` (STARTTLS mode, recommended for most mail providers).
3. **Check Firewall & ISP Restrictions**:
   - Some cloud providers and local ISPs block outgoing port `25` or `587`. Try port `465` or `2525`.

---

## Windows: OAuth Port Error (EACCES)

On Windows, the default OAuth callback port (51121) may be reserved by Hyper-V, WSL2, or Docker. If you see:

```
Error: listen EACCES: permission denied 0.0.0.0:51121
```

The proxy will automatically try fallback ports (51122-51126). If all ports fail, try these solutions:

### Option 1: Use a Custom Port (Recommended)

Set a custom port outside the reserved range:

```powershell
# Windows PowerShell
$env:OAUTH_CALLBACK_PORT = "3456"
gravityroute start

# Windows CMD
set OAUTH_CALLBACK_PORT=3456
gravityroute start
```

### Option 2: Reset Windows NAT

Run as Administrator:

```powershell
net stop winnat
net start winnat
```

---

## "Could not extract token from Antigravity"

If using single-account mode with Antigravity:

1. Make sure the Antigravity app is installed and running
2. Ensure you're logged in to Antigravity

Or add accounts via OAuth instead: `gravityroute accounts add` (or `npm run accounts:add`)

---

## 401 Authentication Errors

The access token might have expired. Try:

```bash
curl -X POST http://localhost:8080/refresh-token
```

Or re-authenticate the account:

```bash
gravityroute accounts
```

---

## Rate Limiting (429)

With multiple accounts, the proxy automatically rotates to the next available account. With a single account, you'll need to wait for the rate limit to reset, or add additional burner accounts to your pool.

---

## Account Shows as "Invalid"

Re-authenticate the account via CLI or WebUI:

```bash
gravityroute accounts
# Choose "Re-authenticate" for the invalid account
```

---

## 403 Permission Denied / VALIDATION_REQUIRED

If you see:

```
403 VALIDATION_REQUIRED - Account requires verification
```

This means Google requires your account to complete verification (phone number, captcha, or terms acceptance).

**The proxy handles this automatically:**

1. The affected account is marked invalid and the proxy rotates to the next available account
2. If a verification URL is provided by Google, it's stored and shown in the WebUI
3. Other accounts continue working normally while the affected account is paused

**To fix the affected account:**

1. Open the WebUI (`http://localhost:8080`)
2. Find the account marked with an error badge
3. Click the **FIX** button — this opens the Google verification page directly
4. Complete the verification
5. Click the **↻ Refresh** button on the account to re-enable it
