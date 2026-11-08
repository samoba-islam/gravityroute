/**
 * System Updater Component
 * Handles checking for updates, viewing changelog/commits,
 * and executing one-click automated updates with server reconnect polling.
 */
window.Components = window.Components || {};

window.Components.systemUpdater = () => ({
    updateInfo: {
        isGitRepo: true,
        hasUpdate: false,
        currentVersion: '1.0.0',
        currentCommit: '',
        latestCommit: '',
        latestMessage: '',
        latestDate: null,
        commitsBehind: 0,
        branch: 'main',
        repoUrl: 'https://github.com/samoba-islam/gravityroute'
    },
    checking: false,
    updating: false,
    showModal: false,
    updateStatus: 'idle', // 'idle' | 'running' | 'restarting' | 'success' | 'error'
    steps: [],
    error: null,
    lastChecked: null,
    reconnectCountdown: 15,
    _pollTimer: null,

    async init() {
        // Run initial check
        await this.checkForUpdates(false);
    },

    async checkForUpdates(force = true) {
        if (this.checking) return;
        this.checking = true;
        this.error = null;

        try {
            const password = Alpine.store('global')?.webuiPassword;
            const url = `/api/system/update/check${force ? '?force=true' : ''}`;
            const { response, newPassword } = await window.utils.request(url, {}, password);

            if (newPassword && Alpine.store('global')) {
                Alpine.store('global').webuiPassword = newPassword;
            }

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            if (data.status === 'ok') {
                this.updateInfo = data;
                this.lastChecked = new Date().toLocaleTimeString();

                // Reflect in global store for navigation indicator
                if (Alpine.store('global')) {
                    Alpine.store('global').hasSystemUpdate = Boolean(data.hasUpdate);
                    Alpine.store('global').updateCommitsBehind = data.commitsBehind || 0;
                }
            } else {
                throw new Error(data.error || 'Failed to check for updates');
            }
        } catch (err) {
            console.error('[SystemUpdater] Check error:', err);
            this.error = err.message;
        } finally {
            this.checking = false;
        }
    },

    async applyUpdate() {
        if (this.updating) return;

        this.updating = true;
        this.showModal = true;
        this.updateStatus = 'running';
        this.steps = [
            { id: 1, text: 'Initiating automated update pipeline...', done: true }
        ];
        this.error = null;

        try {
            const password = Alpine.store('global')?.webuiPassword;
            const { response, newPassword } = await window.utils.request(
                '/api/system/update/apply',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                },
                password
            );

            if (newPassword && Alpine.store('global')) {
                Alpine.store('global').webuiPassword = newPassword;
            }

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            if (data.steps && Array.isArray(data.steps)) {
                this.steps = data.steps.map((s, idx) => ({
                    id: idx + 1,
                    text: s.message || s,
                    done: true
                }));
            }

            this.updateStatus = 'restarting';
            this.steps.push({
                id: this.steps.length + 1,
                text: 'Server is restarting with new code. Reconnecting...',
                done: false,
                active: true
            });

            // Start polling for server revival
            this.startReconnectPolling();
        } catch (err) {
            console.error('[SystemUpdater] Update failed:', err);
            this.updateStatus = 'error';
            this.error = err.message;
            this.updating = false;
        }
    },

    startReconnectPolling() {
        let attempts = 0;
        const maxAttempts = 30; // 60 seconds total

        if (this._pollTimer) clearInterval(this._pollTimer);

        this._pollTimer = setInterval(async () => {
            attempts++;
            try {
                // Check if server is back online
                const res = await fetch('/api/config', {
                    headers: { 'Cache-Control': 'no-cache' },
                    signal: AbortSignal.timeout(2000)
                });

                if (res.ok) {
                    clearInterval(this._pollTimer);
                    this.updateStatus = 'success';
                    this.steps.forEach(s => { s.done = true; s.active = false; });
                    this.steps.push({
                        id: this.steps.length + 1,
                        text: 'Server online! Reloading console...',
                        done: true
                    });

                    setTimeout(() => {
                        window.location.reload();
                    }, 1200);
                }
            } catch {
                // Server still rebooting, continue polling
            }

            if (attempts >= maxAttempts) {
                clearInterval(this._pollTimer);
                this.updateStatus = 'error';
                this.error = 'Reconnection timed out. Please manually refresh the page.';
                this.updating = false;
            }
        }, 2000);
    },

    formatDate(isoStr) {
        if (!isoStr) return '';
        try {
            return new Date(isoStr).toLocaleString();
        } catch {
            return isoStr;
        }
    }
});

