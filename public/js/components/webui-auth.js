/**
 * WebUI Auth Configuration Component
 * Registers itself to window.Components for Alpine.js
 */
window.Components = window.Components || {};

window.Components.webuiAuthConfig = () => ({
    loading: false,
    saving: false,
    authEnabled: false,
    username: 'admin',
    email: '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
    showCurrentPassword: false,
    showNewPassword: false,
    showConfirmPassword: false,
    activeUser: null,
    hasExistingPassword: false,
    recoveryCliEnabled: true,
    recoveryEmailEnabled: true,
    hasSmtp: false,

    init() {
        if (this.$store.global.settingsTab === 'auth') {
            this.fetchAuthData();
        }

        this.$watch('$store.global.settingsTab', (tab) => {
            if (tab === 'auth') {
                this.fetchAuthData();
            }
        });
    },

    async fetchAuthData() {
        this.loading = true;
        try {
            // Check auth status
            const statusRes = await fetch('/api/auth/status');
            if (statusRes.ok) {
                const data = await statusRes.json();
                this.authEnabled = Boolean(data.authEnabled);
                this.$store.global.authEnabled = this.authEnabled;
                this.activeUser = data.username;
                if (data.username) {
                    this.username = data.username;
                }
                if (data.email !== undefined) {
                    this.email = data.email || '';
                }
            }

            // Also check public config for username, email, and whether password exists
            const configRes = await fetch('/api/config');
            if (configRes.ok) {
                const data = await configRes.json();
                if (data.config) {
                    if (data.config.webuiUsername) {
                        this.username = data.config.webuiUsername;
                    }
                    if (data.config.webuiEmail !== undefined) {
                        this.email = data.config.webuiEmail || '';
                    }
                    if (data.config.webuiAuthEnabled !== undefined) {
                        this.authEnabled = Boolean(data.config.webuiAuthEnabled);
                    }
                    this.hasExistingPassword = Boolean(data.config.webuiPassword);
                    if (data.config.webuiRecoveryMode) {
                        this.recoveryCliEnabled = data.config.webuiRecoveryMode.cliEnabled !== false;
                        this.recoveryEmailEnabled = data.config.webuiRecoveryMode.emailEnabled !== false;
                    }
                    this.hasSmtp = Boolean(data.config.smtp?.enabled && data.config.smtp?.host);
                }
            }

            // Also check recovery-status
            const recRes = await fetch('/api/auth/recovery-status');
            if (recRes.ok) {
                const recData = await recRes.json();
                this.recoveryCliEnabled = recData.cliEnabled !== false;
                this.recoveryEmailEnabled = recData.emailEnabled !== false;
                this.hasSmtp = recData.hasSmtp;
            }
        } catch (e) {
            console.error('Failed to fetch auth data:', e);
        } finally {
            this.loading = false;
        }
    },

    async toggleAuth(targetState) {
        if (targetState === true && !this.hasExistingPassword && !this.newPassword) {
            this.$store.global.showToast(this.$store.global.t('authPasswordRequiredPrompt'), 'warning');
            return;
        }

        this.saving = true;
        try {
            const body = {
                enabled: targetState,
                username: this.username,
                email: this.email ? this.email.trim() : ''
            };
            if (this.newPassword) {
                body.newPassword = this.newPassword;
                body.currentPassword = this.currentPassword;
            }

            const token = this.$store.global.authToken;
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const res = await fetch('/api/auth/config', {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Failed to update authentication status');
            }

            this.authEnabled = targetState;
            this.$store.global.authEnabled = targetState;
            if (data.token) {
                this.$store.global.authToken = data.token;
                localStorage.setItem('antigravity_auth_token', data.token);
            }
            if (targetState) {
                this.$store.global.authenticated = true;
                this.hasExistingPassword = true;
                this.currentPassword = '';
                this.newPassword = '';
                this.confirmPassword = '';
            }

            const msg = targetState 
                ? this.$store.global.t('authEnabledSuccess') 
                : this.$store.global.t('authDisabledSuccess');
            this.$store.global.showToast(msg, 'success');
        } catch (err) {
            this.$store.global.showToast(err.message, 'error');
        } finally {
            this.saving = false;
        }
    },

    async saveCredentials() {
        if (!this.username.trim()) {
            this.$store.global.showToast(this.$store.global.t('usernameRequired'), 'error');
            return;
        }

        if (this.email && this.email.trim()) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(this.email.trim())) {
                this.$store.global.showToast(this.$store.global.t('invalidEmail') || 'Please enter a valid email address', 'error');
                return;
            }
        }

        if (this.newPassword || this.confirmPassword) {
            if (this.newPassword !== this.confirmPassword) {
                this.$store.global.showToast(this.$store.global.t('passwordsNotMatch'), 'error');
                return;
            }
            if (this.newPassword.length < 4) {
                this.$store.global.showToast(this.$store.global.t('passwordTooShort'), 'error');
                return;
            }
        }

        this.saving = true;
        try {
            const body = {
                username: this.username.trim(),
                email: this.email ? this.email.trim() : '',
                recoveryMode: {
                    cliEnabled: this.recoveryCliEnabled,
                    emailEnabled: this.recoveryEmailEnabled
                }
            };
            if (this.newPassword) {
                body.newPassword = this.newPassword;
                body.currentPassword = this.currentPassword;
            }

            const token = this.$store.global.authToken;
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const res = await fetch('/api/auth/config', {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Failed to save credentials');
            }

            if (data.token) {
                this.$store.global.authToken = data.token;
                localStorage.setItem('antigravity_auth_token', data.token);
            }

            this.hasExistingPassword = true;
            this.currentPassword = '';
            this.newPassword = '';
            this.confirmPassword = '';
            this.activeUser = this.username;
            this.$store.global.authUser = this.username;

            this.$store.global.showToast(this.$store.global.t('credentialsSavedSuccess'), 'success');
        } catch (err) {
            this.$store.global.showToast(err.message, 'error');
        } finally {
            this.saving = false;
        }
    },

    async toggleRecoveryMode(mode, targetState) {
        if (mode === 'cli') this.recoveryCliEnabled = targetState;
        if (mode === 'email') this.recoveryEmailEnabled = targetState;

        try {
            const token = this.$store.global.authToken;
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const res = await fetch('/api/auth/config', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    recoveryMode: {
                        cliEnabled: this.recoveryCliEnabled,
                        emailEnabled: this.recoveryEmailEnabled
                    }
                })
            });
            if (res.ok) {
                this.$store.global.showToast(this.$store.global.t('recoverySavedSuccess') || 'Password recovery preferences updated', 'success');
            }
        } catch (e) {
            console.error('Failed to update recovery mode:', e);
        }
    },

    async logout() {
        await this.$store.global.logout();
    }
});
