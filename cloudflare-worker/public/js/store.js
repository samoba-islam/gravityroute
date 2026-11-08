/**
 * Global Store for Antigravity Console
 * Handles Translations, Toasts, and Shared Config
 */

const initGlobalStore = () => {
    if (window.Alpine && !Alpine.store('global')) {
        Alpine.store('global', {
        init() {
            // Hash-based routing
            const validTabs = ['dashboard', 'models', 'accounts', 'providers', 'api', 'logs', 'settings'];
            const validSettingsTabs = ['ui', 'claude', 'models', 'server', 'auth', 'smtp'];
            const getHash = () => window.location.hash.substring(1);

            const parseHash = (hash) => {
                const [rawTab, subtab] = hash.split('/');
                const tab = rawTab === 'accounts' ? 'providers' : rawTab;
                return { tab, subtab };
            };

            // 1. Initial load from hash
            const { tab: initialTab, subtab: initialSubtab } = parseHash(getHash());
            if (validTabs.includes(initialTab)) {
                this.activeTab = initialTab;
                if (initialTab === 'settings' && validSettingsTabs.includes(initialSubtab)) {
                    this.settingsTab = initialSubtab;
                }
            }

            // 2. Sync State -> URL
            Alpine.effect(() => {
                if (!validTabs.includes(this.activeTab)) return;
                let target = this.activeTab === 'accounts' ? 'providers' : this.activeTab;
                if (this.activeTab === 'settings' && this.settingsTab !== 'ui') {
                    target = `settings/${this.settingsTab}`;
                }
                if (getHash() !== target) {
                    window.location.hash = target;
                }
            });

            // 3. Sync URL -> State (Back/Forward buttons)
            window.addEventListener('hashchange', () => {
                const { tab, subtab } = parseHash(getHash());
                if (validTabs.includes(tab)) {
                    if (this.activeTab !== tab) {
                        this.activeTab = tab;
                    }
                    if (tab === 'settings') {
                        this.settingsTab = validSettingsTabs.includes(subtab) ? subtab : 'ui';
                    }
                }
            });

            // 4. Check auth status & version
            this.checkAuthStatus();
        },

        async checkAuthStatus() {
            this.checkingAuth = true;
            try {
                const token = this.authToken;
                const headers = {};
                if (token) headers['Authorization'] = `Bearer ${token}`;

                const response = await fetch('/api/auth/status', { headers });
                if (response.ok) {
                    const data = await response.json();
                    this.authEnabled = Boolean(data.authEnabled);
                    this.authenticated = Boolean(data.authenticated);
                    this.authUser = data.username;

                    if (!this.authEnabled || this.authenticated) {
                        this.fetchVersion();
                        Alpine.store('data')?.fetchData();
                    }
                }
            } catch (error) {
                console.debug('Could not check auth status:', error);
            } finally {
                this.checkingAuth = false;
            }
        },

        async fetchVersion() {
            try {
                const token = this.authToken;
                const headers = {};
                if (token) headers['Authorization'] = `Bearer ${token}`;

                const response = await fetch('/api/config', { headers });
                if (response.ok) {
                    const data = await response.json();
                    if (data.version) {
                        this.version = data.version;
                    }
                    // Update maxAccounts in data store
                    if (data.config && typeof data.config.maxAccounts === 'number') {
                        Alpine.store('data').maxAccounts = data.config.maxAccounts;
                    }
                }
            } catch (error) {
                console.debug('Could not fetch version:', error);
            }
        },

        // App State
        version: '1.0.0',
        activeTab: 'dashboard',
        settingsTab: 'ui',
        webuiPassword: localStorage.getItem('gravityroute_webui_password') || localStorage.getItem('antigravity_webui_password') || '',

        // WebUI Authentication State
        authEnabled: false,
        authenticated: false,
        checkingAuth: true,
        authUser: null,
        savedLogin: (localStorage.getItem('gravityroute_saved_login') || localStorage.getItem('antigravity_saved_login')) !== 'false',
        authToken: localStorage.getItem('gravityroute_auth_token') || 
                   sessionStorage.getItem('gravityroute_auth_token') || 
                   localStorage.getItem('antigravity_auth_token') || 
                   sessionStorage.getItem('antigravity_auth_token') || '',

        async login(username, password, rememberMe = true) {
            try {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, rememberMe })
                });

                const data = await response.json();
                if (!response.ok || data.status !== 'ok') {
                    throw new Error(data.error || this.t('invalidCredentials'));
                }

                this.authToken = data.token;
                this.authUser = data.username;
                this.authenticated = true;
                this.savedLogin = rememberMe;

                if (rememberMe) {
                    localStorage.setItem('gravityroute_auth_token', data.token);
                    localStorage.setItem('gravityroute_saved_login', 'true');
                    sessionStorage.removeItem('gravityroute_auth_token');
                    sessionStorage.removeItem('antigravity_auth_token');
                } else {
                    sessionStorage.setItem('gravityroute_auth_token', data.token);
                    localStorage.setItem('gravityroute_saved_login', 'false');
                    localStorage.removeItem('gravityroute_auth_token');
                    localStorage.removeItem('antigravity_auth_token');
                }

                this.showToast(this.t('loginSuccess'), 'success');
                this.fetchVersion();
                Alpine.store('data')?.fetchData();
                window.dispatchEvent(new CustomEvent('reload-views'));
                return { success: true };
            } catch (err) {
                return { success: false, error: err.message };
            }
        },

        async logout() {
            try {
                const token = this.authToken;
                const headers = {};
                if (token) headers['Authorization'] = `Bearer ${token}`;

                await fetch('/api/auth/logout', { method: 'POST', headers });
            } catch (e) {
                console.debug('Logout request failed:', e);
            } finally {
                this.authToken = '';
                this.authenticated = false;
                this.authUser = null;
                localStorage.removeItem('gravityroute_auth_token');
                sessionStorage.removeItem('gravityroute_auth_token');
                localStorage.removeItem('antigravity_auth_token');
                sessionStorage.removeItem('antigravity_auth_token');
                this.showToast(this.t('logoutSuccess'), 'info');
            }
        },

        // Password Recovery State & Actions
        forgotPasswordModal: false,
        recoveryTab: 'email', // 'email' | 'cli'
        recoveryStep: 1, // 1: request code, 2: verify & reset
        recoveryIdentifier: '',
        recoveryCode: '',
        recoveryNewPassword: '',
        recoveryConfirmPassword: '',
        recoveryShowNewPass: false,
        recoveryShowConfirmPass: false,
        recoveryLoading: false,
        recoveryError: '',
        recoverySuccess: '',
        recoveryStatus: {
            cliEnabled: true,
            emailEnabled: true,
            hasEmail: false,
            hasSmtp: false,
            emailMasked: null
        },
        cliCustomPass: '',

        async openForgotPassword() {
            this.forgotPasswordModal = true;
            this.recoveryStep = 1;
            this.recoveryError = '';
            this.recoverySuccess = '';
            this.recoveryCode = '';
            this.recoveryNewPassword = '';
            this.recoveryConfirmPassword = '';
            this.cliCustomPass = '';
            await this.fetchRecoveryStatus();
            if (!this.recoveryStatus.emailEnabled && this.recoveryStatus.cliEnabled) {
                this.recoveryTab = 'cli';
            } else {
                this.recoveryTab = 'email';
            }
        },

        async fetchRecoveryStatus() {
            try {
                const res = await fetch('/api/auth/recovery-status');
                if (res.ok) {
                    const data = await res.json();
                    this.recoveryStatus = data;
                }
            } catch (e) {
                console.debug('Failed to load recovery status:', e);
            }
        },

        async sendRecoveryCode() {
            if (!this.recoveryIdentifier.trim()) {
                this.recoveryError = this.t('enterIdentifierPrompt') || 'Please enter your username or registered email';
                return;
            }
            this.recoveryLoading = true;
            this.recoveryError = '';
            this.recoverySuccess = '';
            try {
                const res = await fetch('/api/auth/forgot-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ identifier: this.recoveryIdentifier.trim() })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || 'Failed to send recovery code');
                }
                this.recoveryStep = 2;
                const emailMsg = data.email ? this.t('codeSentNotice', { email: data.email }) : (data.message || 'Verification code sent to your email');
                this.recoverySuccess = emailMsg;
                this.showToast(data.message || 'Verification code sent', 'success');
            } catch (err) {
                this.recoveryError = err.message;
            } finally {
                this.recoveryLoading = false;
            }
        },

        async submitPasswordReset() {
            if (!this.recoveryCode.trim() || this.recoveryCode.trim().length !== 6) {
                this.recoveryError = this.t('enterSixDigitCode') || 'Please enter the 6-digit verification code';
                return;
            }
            if (!this.recoveryNewPassword) {
                this.recoveryError = this.t('enterNewPassword') || 'Please enter a new password';
                return;
            }
            if (this.recoveryNewPassword.length < 4) {
                this.recoveryError = this.t('passwordTooShort') || 'Password must be at least 4 characters';
                return;
            }
            if (this.recoveryNewPassword !== this.recoveryConfirmPassword) {
                this.recoveryError = this.t('passwordsNotMatch') || 'Passwords do not match';
                return;
            }

            this.recoveryLoading = true;
            this.recoveryError = '';
            try {
                const res = await fetch('/api/auth/reset-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        identifier: this.recoveryIdentifier.trim(),
                        code: this.recoveryCode.trim(),
                        newPassword: this.recoveryNewPassword
                    })
                });
                const data = await res.json();
                if (!res.ok) {
                    throw new Error(data.error || 'Failed to reset password');
                }

                this.showToast(this.t('passwordResetSuccess') || 'Password successfully reset! You can now log in.', 'success');
                this.forgotPasswordModal = false;
                this.recoveryStep = 1;
                this.recoveryCode = '';
                this.recoveryNewPassword = '';
                this.recoveryConfirmPassword = '';
            } catch (err) {
                this.recoveryError = err.message;
            } finally {
                this.recoveryLoading = false;
            }
        },

        copyToClipboard(text) {
            navigator.clipboard.writeText(text);
            this.showToast(this.t('copied') || 'Copied to clipboard', 'success');
        },

        // i18n
        lang: localStorage.getItem('app_lang') || 'en',
        translations: window.translations || {},

        // Toast Messages
        toast: null,

        // OAuth Progress
        oauthProgress: {
            active: false,
            current: 0,
            max: 60,
            cancel: null
        },

        t(key, params = {}) {
            let str = (this.translations[this.lang] && this.translations[this.lang][key]) ||
                      (window.translations && window.translations[this.lang] && window.translations[this.lang][key]) ||
                      (window.translations && window.translations['en'] && window.translations['en'][key]) || '';
            if (str && typeof str === 'string') {
                Object.keys(params).forEach(p => {
                    str = str.replace(`{${p}}`, params[p]);
                });
                return str;
            }
            return '';
        },

        setLang(l) {
            this.lang = l;
            localStorage.setItem('app_lang', l);
        },

        showToast(message, type = 'info') {
            const id = Date.now();
            this.toast = { message, type, id };
            setTimeout(() => {
                if (this.toast && this.toast.id === id) this.toast = null;
            }, 3000);
        }
    });
    }
};

if (window.Alpine) {
    initGlobalStore();
} else {
    document.addEventListener('alpine:init', initGlobalStore);
}
