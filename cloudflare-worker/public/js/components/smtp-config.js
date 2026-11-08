/**
 * SMTP Configuration Component
 * Registers itself to window.Components for Alpine.js
 */
window.Components = window.Components || {};

window.Components.smtpConfig = () => ({
    loading: false,
    saving: false,
    testing: false,
    enabled: false,
    host: '',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    hasPassword: false,
    showPass: false,
    fromEmail: '',
    fromName: 'Antigravity Proxy',
    testRecipient: '',
    testStatus: null,

    init() {
        if (this.$store.global.settingsTab === 'smtp') {
            this.fetchConfig();
        }

        this.$watch('$store.global.settingsTab', (tab) => {
            if (tab === 'smtp') {
                this.fetchConfig();
            }
        });
    },

    async fetchConfig() {
        this.loading = true;
        this.testStatus = null;
        try {
            const token = this.$store.global.authToken;
            const headers = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const res = await fetch('/api/smtp/config', { headers });
            if (res.ok) {
                const data = await res.json();
                if (data.config) {
                    this.enabled = Boolean(data.config.enabled);
                    this.host = data.config.host || '';
                    this.port = data.config.port || 587;
                    this.secure = Boolean(data.config.secure);
                    this.user = data.config.user || '';
                    this.hasPassword = Boolean(data.config.hasPassword);
                    this.fromEmail = data.config.fromEmail || '';
                    this.fromName = data.config.fromName || 'Antigravity Proxy';
                }
            }

            // Attempt to prefill test recipient with admin email if available
            if (!this.testRecipient) {
                const statusRes = await fetch('/api/auth/status', { headers });
                if (statusRes.ok) {
                    const statusData = await statusRes.json();
                    if (statusData.email) {
                        this.testRecipient = statusData.email;
                    }
                }
            }
        } catch (error) {
            console.error('[SMTP] Failed to fetch configuration:', error);
        } finally {
            this.loading = false;
        }
    },

    applyPreset(presetName) {
        const presets = {
            gmail: {
                host: 'smtp.gmail.com',
                port: 587,
                secure: false,
                name: 'Gmail'
            },
            outlook: {
                host: 'smtp.office365.com',
                port: 587,
                secure: false,
                name: 'Outlook / Office 365'
            },
            sendgrid: {
                host: 'smtp.sendgrid.net',
                port: 587,
                secure: false,
                user: 'apikey',
                name: 'SendGrid'
            },
            ses: {
                host: 'email-smtp.us-east-1.amazonaws.com',
                port: 587,
                secure: false,
                name: 'Amazon SES (US East)'
            },
            mailgun: {
                host: 'smtp.mailgun.org',
                port: 587,
                secure: false,
                name: 'Mailgun'
            }
        };

        const preset = presets[presetName];
        if (preset) {
            this.host = preset.host;
            this.port = preset.port;
            this.secure = preset.secure;
            if (preset.user && !this.user) {
                this.user = preset.user;
            }
            const appliedMsg = (this.$store.global.t('smtpPresetApplied') || 'Applied preset for') + ' ' + preset.name;
            this.$store.global.showToast(appliedMsg, 'info');
        }
    },

    setSecurityMode(mode) {
        if (mode === 'ssl') {
            this.secure = true;
            if (this.port === 587 || this.port === 25) {
                this.port = 465;
            }
        } else if (mode === 'tls') {
            this.secure = false;
            if (this.port === 465) {
                this.port = 587;
            }
        }
    },

    async saveConfig() {
        if (this.fromEmail) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(this.fromEmail.trim())) {
                this.$store.global.showToast(this.$store.global.t('invalidEmail') || 'Please enter a valid email address', 'error');
                return;
            }
        }

        const parsedPort = parseInt(this.port, 10);
        if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
            this.$store.global.showToast('Port must be between 1 and 65535', 'error');
            return;
        }

        this.saving = true;
        try {
            const token = this.$store.global.authToken;
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const payload = {
                enabled: this.enabled,
                host: this.host ? this.host.trim() : '',
                port: parsedPort,
                secure: this.secure,
                user: this.user ? this.user.trim() : '',
                fromEmail: this.fromEmail ? this.fromEmail.trim() : '',
                fromName: this.fromName ? this.fromName.trim() : 'Antigravity Proxy'
            };

            // Only send pass if user typed a new password or cleared it
            if (this.pass !== '') {
                payload.pass = this.pass;
            }

            const res = await fetch('/api/smtp/config', {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (res.ok && data.status === 'ok') {
                this.pass = ''; // Clear plaintext input
                this.hasPassword = Boolean(data.config?.hasPassword);
                this.$store.global.showToast(this.$store.global.t('smtpSavedSuccess') || 'SMTP configuration saved successfully', 'success');
            } else {
                this.$store.global.showToast(data.error || 'Failed to save SMTP configuration', 'error');
            }
        } catch (error) {
            console.error('[SMTP] Error saving configuration:', error);
            this.$store.global.showToast('Network error while saving SMTP settings', 'error');
        } finally {
            this.saving = false;
        }
    },

    async sendTest(action = 'send') {
        if (!this.host) {
            this.$store.global.showToast('SMTP host is required before testing', 'warning');
            return;
        }

        if (action === 'send' && !this.testRecipient) {
            this.$store.global.showToast(this.$store.global.t('invalidEmail') || 'Please provide a recipient email address', 'warning');
            return;
        }

        this.testing = true;
        this.testStatus = null;

        try {
            const token = this.$store.global.authToken;
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const payload = {
                action,
                host: this.host.trim(),
                port: parseInt(this.port, 10),
                secure: this.secure,
                user: this.user ? this.user.trim() : '',
                fromEmail: this.fromEmail ? this.fromEmail.trim() : '',
                fromName: this.fromName ? this.fromName.trim() : 'Antigravity Proxy',
                recipient: this.testRecipient ? this.testRecipient.trim() : ''
            };

            if (this.pass) {
                payload.pass = this.pass;
            }

            const res = await fetch('/api/smtp/test', {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const data = await res.json();
            if (res.ok && data.status === 'ok') {
                const msg = action === 'verify'
                    ? (this.$store.global.t('smtpVerifySuccess') || 'SMTP server handshake verified successfully.')
                    : (this.$store.global.t('smtpTestSuccess') || 'Test email sent successfully! Check your inbox.');
                this.testStatus = {
                    type: 'success',
                    message: msg,
                    detail: data.messageId ? `Message ID: ${data.messageId}` : null
                };
                this.$store.global.showToast(msg, 'success');
            } else {
                const errorMsg = data.error || 'SMTP verification failed';
                this.testStatus = {
                    type: 'error',
                    message: (this.$store.global.t('smtpTestFailed') || 'SMTP verification failed') + ': ' + errorMsg,
                    code: data.code
                };
                this.$store.global.showToast(errorMsg, 'error');
            }
        } catch (error) {
            console.error('[SMTP] Test failed:', error);
            this.testStatus = {
                type: 'error',
                message: 'Connection failed: ' + (error.message || 'Network error')
            };
            this.$store.global.showToast('Network error during test', 'error');
        } finally {
            this.testing = false;
        }
    }
});
