#!/usr/bin/env bash
# ==============================================================================
# GravityRoute - Intelligent AI Gateway & Multi-Account Proxy Router
# One-Click Linux Installation & Auto-Restart System Service Script
# Author: Shawon Hossain Samoba <shawon.hossain.samoba.bd@gmail.com>
# Repository: https://github.com/samoba-islam/gravityroute
# ==============================================================================

set -euo pipefail

# ANSI Colors
BOLD="\033[1m"
GREEN="\033[0;32m"
CYAN="\033[0;36m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
PURPLE="\033[0;35m"
RESET="\033[0m"

log_info() {
    echo -e "${CYAN}${BOLD}[INFO]${RESET} $1"
}

log_success() {
    echo -e "${GREEN}${BOLD}[SUCCESS]${RESET} $1"
}

log_warn() {
    echo -e "${YELLOW}${BOLD}[WARN]${RESET} $1"
}

log_error() {
    echo -e "${RED}${BOLD}[ERROR]${RESET} $1" >&2
}

print_banner() {
    echo -e "${PURPLE}${BOLD}"
    cat << "EOF"
   ____                 _ _         ____             _       
  / ___|_ __ __ ___   _(_) |_ _   _|  _ \ ___  _   _| |_ ___ 
 | |  _| '__/ _` \ \ / / | __| | | | |_) / _ \| | | | __/ _ \
 | |_| | | | (_| |\ V /| | |_| |_| |  _ < (_) | |_| | ||  __/
  \____|_|  \__,_| \_/ |_|\__|\__, |_| \_\___/ \__,_|\__\___|
                              |___/                          
EOF
    echo -e "${CYAN}  Intelligent AI Gateway & Multi-Account Model Router (v1.0.0)${RESET}"
    echo -e "${CYAN}  https://github.com/samoba-islam/gravityroute${RESET}\n"
}

# ------------------------------------------------------------------------------
# 1. Root & User Privileges Detection
# ------------------------------------------------------------------------------
check_privileges() {
    if [ "${EUID}" -ne 0 ]; then
        log_error "This installation script requires root privileges to install packages and configure systemd."
        log_info "Please run with sudo: ${BOLD}sudo bash $0${RESET} or ${BOLD}curl -fsSL https://raw.githubusercontent.com/samoba-islam/gravityroute/main/install.sh | sudo bash${RESET}"
        exit 1
    fi

    # Identify real (non-root) user who invoked sudo
    if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
        REAL_USER="${SUDO_USER}"
    else
        REAL_USER="root"
    fi

    REAL_HOME=$(getent passwd "${REAL_USER}" | cut -d: -f6 || echo "${HOME}")
    if [ -z "${REAL_HOME}" ] || [ ! -d "${REAL_HOME}" ]; then
        REAL_HOME="${HOME}"
    fi

    log_info "Target installation user: ${BOLD}${REAL_USER}${RESET} (Home: ${REAL_HOME})"
}

# ------------------------------------------------------------------------------
# 2. OS & Package Manager Detection
# ------------------------------------------------------------------------------
detect_os() {
    OS_FAMILY=""
    PKG_MANAGER=""

    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_ID="${ID:-unknown}"
        OS_LIKE="${ID_LIKE:-}"
    elif [ -f /etc/redhat-release ]; then
        OS_ID="rhel"
        OS_LIKE=""
    elif [ -f /etc/debian_version ]; then
        OS_ID="debian"
        OS_LIKE=""
    elif [ -f /etc/alpine-release ]; then
        OS_ID="alpine"
        OS_LIKE=""
    else
        OS_ID="unknown"
        OS_LIKE=""
    fi

    case "${OS_ID}" in
        ubuntu|debian|linuxmint|pop|raspbian)
            OS_FAMILY="debian"
            PKG_MANAGER="apt-get"
            ;;
        centos|rhel|fedora|rocky|almalinux|amazon)
            OS_FAMILY="rhel"
            if command -v dnf >/dev/null 2>&1; then
                PKG_MANAGER="dnf"
            else
                PKG_MANAGER="yum"
            fi
            ;;
        arch|manjaro|endeavouros)
            OS_FAMILY="arch"
            PKG_MANAGER="pacman"
            ;;
        alpine)
            OS_FAMILY="alpine"
            PKG_MANAGER="apk"
            ;;
        opensuse*|suse|sles)
            OS_FAMILY="suse"
            PKG_MANAGER="zypper"
            ;;
        *)
            if echo "${OS_LIKE}" | grep -q "debian"; then
                OS_FAMILY="debian"
                PKG_MANAGER="apt-get"
            elif echo "${OS_LIKE}" | grep -q "rhel\|fedora\|centos"; then
                OS_FAMILY="rhel"
                PKG_MANAGER="dnf"
            else
                log_warn "Unrecognized Linux distribution (${OS_ID}). Proceeding with generic fallback..."
                OS_FAMILY="generic"
            fi
            ;;
    esac

    log_info "Detected Operating System: ${BOLD}${OS_ID}${RESET} (Family: ${OS_FAMILY}, Package Manager: ${PKG_MANAGER:-none})"
}

# ------------------------------------------------------------------------------
# 3. Install System Prerequisites (curl, git, build essentials)
# ------------------------------------------------------------------------------
install_system_dependencies() {
    log_info "Checking essential build dependencies (curl, git, build-essential)..."

    case "${OS_FAMILY}" in
        debian)
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -y -qq || true
            apt-get install -y -qq curl git build-essential ca-certificates gnupg tar gzip || {
                log_warn "Failed to install some build dependencies via apt; continuing..."
            }
            ;;
        rhel)
            ${PKG_MANAGER} install -y curl git make gcc gcc-c++ ca-certificates tar gzip || true
            ;;
        arch)
            pacman -Sy --noconfirm curl git base-devel tar gzip || true
            ;;
        alpine)
            apk update
            apk add --no-cache curl git build-base bash tar gzip ca-certificates
            ;;
        suse)
            zypper refresh -y || true
            zypper install -y curl git make gcc gcc-c++ tar gzip || true
            ;;
        *)
            log_warn "Please ensure curl, git, and a C++ compiler are installed on this system."
            ;;
    esac
}

# ------------------------------------------------------------------------------
# 4. Node.js (>= 18.0.0) Detection & Installation
# ------------------------------------------------------------------------------
install_nodejs() {
    NEED_NODE=true

    if command -v node >/dev/null 2>&1; then
        CURRENT_NODE_VER=$(node -v | sed 's/^v//')
        NODE_MAJOR=$(echo "${CURRENT_NODE_VER}" | cut -d. -f1)
        if [ "${NODE_MAJOR}" -ge 18 ]; then
            log_success "Compatible Node.js found: v${CURRENT_NODE_VER} (>= 18.0.0)"
            NEED_NODE=false
        else
            log_warn "Installed Node.js v${CURRENT_NODE_VER} is below required v18.0.0. Installing Node.js 20 LTS..."
        fi
    fi

    if [ "${NEED_NODE}" = true ]; then
        log_info "Installing official Node.js 20.x LTS runtime..."

        case "${OS_FAMILY}" in
            debian)
                export DEBIAN_FRONTEND=noninteractive
                curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
                apt-get install -y -qq nodejs
                ;;
            rhel)
                curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
                ${PKG_MANAGER} install -y nodejs
                ;;
            arch)
                pacman -Sy --noconfirm nodejs npm
                ;;
            alpine)
                apk add --no-cache nodejs npm
                ;;
            *)
                # Generic binary installation from nodejs.org
                log_info "Downloading pre-compiled Node.js 20 binary from nodejs.org..."
                ARCH=$(uname -m)
                case "${ARCH}" in
                    x86_64) NODE_ARCH="x64" ;;
                    aarch64|arm64) NODE_ARCH="arm64" ;;
                    armv7l) NODE_ARCH="armv7l" ;;
                    *) NODE_ARCH="x64" ;;
                esac
                NODE_VERSION="v20.18.0"
                TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
                curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}" -o "/tmp/${TARBALL}"
                tar -xJf "/tmp/${TARBALL}" -C /usr/local --strip-components=1
                rm -f "/tmp/${TARBALL}"
                ;;
        esac

        if ! command -v node >/dev/null 2>&1; then
            log_error "Failed to install Node.js automatically. Please install Node.js >= 18 manually and re-run."
            exit 1
        fi

        INSTALLED_NODE_VER=$(node -v)
        log_success "Successfully installed Node.js ${INSTALLED_NODE_VER}"
    fi

    # Verify npm is present
    if ! command -v npm >/dev/null 2>&1; then
        log_error "npm command not found. Please install npm and re-run."
        exit 1
    fi
}

# ------------------------------------------------------------------------------
# 5. GravityRoute Repository Setup
# ------------------------------------------------------------------------------
setup_repository() {
    REPO_URL="https://github.com/samoba-islam/gravityroute.git"
    DEFAULT_INSTALL_DIR="/opt/gravityroute"

    # Check if we are running inside an existing GravityRoute git checkout
    if [ -f "./package.json" ] && grep -q '"name": "gravityroute"' ./package.json 2>/dev/null; then
        INSTALL_DIR="$(pwd)"
        log_info "Detected existing GravityRoute workspace at: ${BOLD}${INSTALL_DIR}${RESET}"
    elif [ -d "${DEFAULT_INSTALL_DIR}/.git" ]; then
        INSTALL_DIR="${DEFAULT_INSTALL_DIR}"
        log_info "Found existing installation at ${INSTALL_DIR}. Updating repository..."
        cd "${INSTALL_DIR}"
        git pull origin main || git pull
    else
        INSTALL_DIR="${DEFAULT_INSTALL_DIR}"
        log_info "Cloning GravityRoute into ${BOLD}${INSTALL_DIR}${RESET}..."
        mkdir -p "${INSTALL_DIR}"
        git clone "${REPO_URL}" "${INSTALL_DIR}"
    fi

    # Set proper directory ownership
    chown -R "${REAL_USER}:${REAL_USER}" "${INSTALL_DIR}"

    cd "${INSTALL_DIR}"

    # Install npm dependencies and build production CSS
    log_info "Installing dependencies and compiling assets (npm install)..."
    if [ "${REAL_USER}" != "root" ]; then
        sudo -u "${REAL_USER}" npm install
    else
        npm install
    fi

    # Ensure CLI executable permissions
    chmod +x "${INSTALL_DIR}/bin/cli.js" || true
    chmod +x "${INSTALL_DIR}/bin/reset-password.js" || true

    # Create global CLI symlink in /usr/local/bin
    mkdir -p /usr/local/bin
    ln -sf "${INSTALL_DIR}/bin/cli.js" /usr/local/bin/gravityroute
    ln -sf "${INSTALL_DIR}/bin/cli.js" /usr/local/bin/gravityRoute
    ln -sf "${INSTALL_DIR}/bin/cli.js" /usr/local/bin/acc
    log_success "Linked global CLI commands: ${BOLD}gravityroute${RESET}, ${BOLD}acc${RESET}"
}

# ------------------------------------------------------------------------------
# 6. Configure systemd Service for Automatic Startup on Reboot
# ------------------------------------------------------------------------------
setup_systemd_service() {
    if ! command -v systemctl >/dev/null 2>&1; then
        log_warn "systemd not detected on this system. Skipping systemd service creation."
        log_info "You can run GravityRoute directly using: ${BOLD}gravityroute start${RESET}"
        return
    fi

    SERVICE_FILE="/etc/systemd/system/gravityroute.service"
    NODE_BIN="$(command -v node)"
    PORT="${PORT:-8080}"

    log_info "Configuring systemd service at ${SERVICE_FILE} (Binding 0.0.0.0:${PORT})..."

    cat > "${SERVICE_FILE}" << EOF
[Unit]
Description=GravityRoute AI Proxy Gateway & Multi-Account Model Router
Documentation=https://github.com/samoba-islam/gravityroute
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${REAL_USER}
Group=$(id -gn "${REAL_USER}")
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=${PORT}
Environment=CLAUDE_CONFIG_PATH=${REAL_HOME}/.claude
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gravityroute
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

    chmod 644 "${SERVICE_FILE}"
    systemctl daemon-reload
    systemctl enable gravityroute.service
    systemctl restart gravityroute.service

    # Automated Firewall configuration for public port access
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qw "active"; then
        log_info "Detected active UFW firewall. Opening port ${PORT}/tcp for public access..."
        ufw allow "${PORT}/tcp" || true
    elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        log_info "Detected active firewalld. Opening port ${PORT}/tcp for public access..."
        firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
    fi

    log_success "Enabled and started ${BOLD}gravityroute.service${RESET} on ${BOLD}0.0.0.0:${PORT}${RESET} (Auto-restart on reboot enabled)"
}

# ------------------------------------------------------------------------------
# 7. Verification & Status Output
# ------------------------------------------------------------------------------
verify_installation() {
    PORT="${PORT:-8080}"
    log_info "Verifying server response on http://127.0.0.1:${PORT}/health..."

    # Wait up to 10 seconds for service to initialize
    HEALTH_OK=false
    for i in {1..10}; do
        if curl -s -f "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
            HEALTH_OK=true
            break
        fi
        sleep 1
    done

    # Fetch public IP for display
    PUBLIC_IP=$(curl -s --max-time 2 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

    echo -e "\n${GREEN}${BOLD}════════════════════════════════════════════════════════════════════════════════${RESET}"
    echo -e "${GREEN}${BOLD}             🎉 GravityRoute Successfully Installed and Running!              ${RESET}"
    echo -e "${GREEN}${BOLD}════════════════════════════════════════════════════════════════════════════════${RESET}\n"

    if [ "${HEALTH_OK}" = true ]; then
        echo -e "  ${BOLD}Status:${RESET}          ${GREEN}● Active (Running & Auto-Restarts on Reboot)${RESET}"
    else
        echo -e "  ${BOLD}Status:${RESET}          ${YELLOW}● Initializing (Check journalctl -u gravityroute)${RESET}"
    fi

    echo -e "  ${BOLD}Web Console:${RESET}     ${CYAN}http://${PUBLIC_IP}:${PORT}${RESET} (or ${CYAN}http://localhost:${PORT}${RESET})"
    echo -e "  ${BOLD}Install Path:${RESET}    ${INSTALL_DIR}"
    echo -e "  ${BOLD}Run as User:${RESET}     ${REAL_USER}"
    echo -e "  ${BOLD}Port:${RESET}            ${PORT}\n"

    echo -e "${BOLD}Service Management Commands:${RESET}"
    echo -e "  Check status:    ${CYAN}sudo systemctl status gravityroute${RESET}"
    echo -e "  View live logs:  ${CYAN}sudo journalctl -u gravityroute -f${RESET}"
    echo -e "  Restart service: ${CYAN}sudo systemctl restart gravityroute${RESET}"
    echo -e "  Stop service:    ${CYAN}sudo systemctl stop gravityroute${RESET}\n"

    echo -e "${BOLD}CLI & Admin Utilities:${RESET}"
    echo -e "  Add account:     ${CYAN}gravityroute accounts add${RESET}"
    echo -e "  Reset password:  ${CYAN}gravityroute reset-password <new_password>${RESET}"
    echo -e "  Open Web Console:${CYAN}gravityroute ui${RESET}\n"

    echo -e "${BOLD}Next Steps:${RESET}"
    echo -e "  1. Open ${CYAN}http://${PUBLIC_IP}:${PORT}${RESET} in your browser."
    echo -e "  2. Link your Google account(s) or add custom AI providers in the dashboard."
    echo -e "  3. Configure Claude Code CLI or Cursor to use ${CYAN}http://localhost:${PORT}${RESET}.\n"
}

# ------------------------------------------------------------------------------
# 8. Uninstaller Mode
# ------------------------------------------------------------------------------
uninstall_gravityroute() {
    log_warn "Starting GravityRoute uninstallation..."

    if command -v systemctl >/dev/null 2>&1; then
        systemctl stop gravityroute.service 2>/dev/null || true
        systemctl disable gravityroute.service 2>/dev/null || true
        rm -f /etc/systemd/system/gravityroute.service
        systemctl daemon-reload
        log_success "Removed gravityroute systemd service"
    fi

    rm -f /usr/local/bin/gravityroute /usr/local/bin/gravityRoute /usr/local/bin/acc
    log_success "Removed global CLI symlinks"

    if [ -d "/opt/gravityroute" ]; then
        read -rp "Delete installation directory (/opt/gravityroute)? [y/N]: " CONFIRM
        if [[ "${CONFIRM}" =~ ^[Yy]$ ]]; then
            rm -rf /opt/gravityroute
            log_success "Deleted /opt/gravityroute"
        else
            log_info "Kept /opt/gravityroute"
        fi
    fi

    log_success "GravityRoute has been uninstalled."
    exit 0
}

# ------------------------------------------------------------------------------
# Main Entry Point
# ------------------------------------------------------------------------------
main() {
    print_banner

    while [ $# -gt 0 ]; do
        case "$1" in
            --port|-p)
                if [ -n "${2:-}" ]; then
                    PORT="$2"
                    shift 2
                else
                    log_error "Missing port number after $1"
                    exit 1
                fi
                ;;
            --uninstall)
                check_privileges
                uninstall_gravityroute
                ;;
            --help|-h)
                echo "Usage: sudo bash install.sh [OPTIONS]"
                echo "Options:"
                echo "  -p, --port <port>  Specify custom public port (default: 8080 or PORT env var)"
                echo "  -h, --help         Show this help message"
                echo "  --uninstall        Remove systemd service and symlinks"
                exit 0
                ;;
            *)
                shift
                ;;
        esac
    done

    check_privileges
    detect_os
    install_system_dependencies
    install_nodejs
    setup_repository
    setup_systemd_service
    verify_installation
}

main "$@"
