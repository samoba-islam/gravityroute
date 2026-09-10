# Linux One-Click Setup & Systemd Auto-Restart Service

GravityRoute provides an automated, one-click Linux setup script (`install.sh`) that installs all prerequisites (including **Node.js 20 LTS** and build essentials if missing), sets up the application, and configures a **systemd service** so GravityRoute runs as a background daemon and automatically restarts on system reboot.

---

## ⚡ 1. One-Click Automated Setup

Run this single command on your Linux server or VPS (Ubuntu, Debian, CentOS, RHEL, Fedora, Rocky, AlmaLinux, Arch, Alpine, or SUSE):

```bash
curl -fsSL https://raw.githubusercontent.com/samoba-islam/gravityroute/main/install.sh | sudo bash
```

### Alternatively, Clone & Run Locally:

```bash
git clone https://github.com/samoba-islam/gravityroute.git
cd gravityroute
chmod +x install.sh
sudo ./install.sh
```

---

## 🔍 What the One-Click Script Does

1. **System & OS Detection**: Automatically identifies your Linux distribution and active package manager (`apt`, `dnf`, `yum`, `pacman`, `apk`, or `zypper`).
2. **Missing Dependencies**: Installs `curl`, `git`, and C/C++ compilation tools (`build-essential` / `gcc-c++`, `make`) required for native dependencies.
3. **Node.js (>= 18) Auto-Installation**: Checks if Node.js is installed and compatible. If missing or older than v18, it automatically installs official **Node.js 20 LTS**.
4. **Repository Setup**: Deploys GravityRoute to `/opt/gravityroute` (or uses the existing checkout if executed inside a cloned repo), installs dependencies, and compiles production CSS.
5. **Global CLI Symlinks**: Registers `/usr/local/bin/gravityroute` and `/usr/local/bin/acc` so you can use commands anywhere without specifying paths.
6. **Systemd Daemon with Auto-Restart**: Generates `/etc/systemd/system/gravityroute.service`, enables it on boot, and starts the proxy immediately.
7. **Claude CLI Integration**: Sets `CLAUDE_CONFIG_PATH` pointing to your user's home directory so Claude Code CLI settings can be read and updated directly from the Web Console.

---

## 🕹️ Service Management Cheat Sheet

Once installed, manage GravityRoute like any standard Linux system service:

| Action | Command |
| :--- | :--- |
| **Check service status** | `sudo systemctl status gravityroute` |
| **View real-time logs** | `sudo journalctl -u gravityroute -f` |
| **Restart proxy service** | `sudo systemctl restart gravityroute` |
| **Stop proxy service** | `sudo systemctl stop gravityroute` |
| **Start proxy service** | `sudo systemctl start gravityroute` |
| **Disable auto-start on boot** | `sudo systemctl disable gravityroute` |
| **Enable auto-start on boot** | `sudo systemctl enable gravityroute` |

---

## 🛠️ CLI Utilities & Admin Tools

You can also run administrative tasks using the global `gravityroute` CLI:

```bash
# Add a new upstream Google account
gravityroute accounts add

# Add account in headless / remote terminal mode (no browser required)
gravityroute accounts add --no-browser

# Instantly reset Web Console admin password
gravityroute reset-password <new_password>

# Check service PID and active status
gravityroute status
```

---

## ⚙️ Manual Systemd Configuration

If you prefer to configure systemd manually without using the installer script, create `/etc/systemd/system/gravityroute.service`:

```ini
[Unit]
Description=GravityRoute AI Proxy Gateway & Multi-Account Model Router
Documentation=https://github.com/samoba-islam/gravityroute
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=youruser
Group=youruser
WorkingDirectory=/opt/gravityroute
ExecStart=/usr/bin/node /opt/gravityroute/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=CLAUDE_CONFIG_PATH=/home/youruser/.claude
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gravityroute
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

*Replace `youruser` with your Linux username.*

Then reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable gravityroute.service
sudo systemctl start gravityroute.service
```

---

## 🌐 Optional: Nginx Reverse Proxy with SSL (HTTPS)

To access the Web Console securely over HTTPS with a custom domain on port 80/443:

```nginx
server {
    listen 80;
    server_name proxy.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # WebSocket and SSE streaming headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering for real-time SSE token streaming
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
    }
}
```

Enable SSL via Certbot:
```bash
sudo certbot --nginx -d proxy.yourdomain.com
```

---

## 🗑️ Uninstallation

To cleanly remove GravityRoute and its systemd service:

```bash
sudo bash /opt/gravityroute/install.sh --uninstall
```

This stops and removes `gravityroute.service`, deletes global symlinks, and prompts to delete `/opt/gravityroute`.
