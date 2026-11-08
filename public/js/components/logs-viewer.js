/**
 * Logs Viewer Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.logsViewer = () => ({
    logs: [],
    isAutoScroll: true,
    eventSource: null,
    searchQuery: '',
    _reconnectTimer: null,
    _recentLogKeys: new Set(),
    filters: {
        INFO: true,
        WARN: true,
        ERROR: true,
        SUCCESS: true,
        DEBUG: false
    },

    get filteredLogs() {
        const query = this.searchQuery.trim();
        if (!query) {
            return this.logs.filter(log => this.filters[log.level]);
        }

        // Try regex first, fallback to plain text search
        let matcher;
        try {
            const regex = new RegExp(query, 'i');
            matcher = (msg) => regex.test(msg);
        } catch (e) {
            // Invalid regex, fallback to case-insensitive string search
            const lowerQuery = query.toLowerCase();
            matcher = (msg) => msg.toLowerCase().includes(lowerQuery);
        }

        return this.logs.filter(log => {
            // Level Filter
            if (!this.filters[log.level]) return false;

            // Search Filter
            return matcher(log.message);
        });
    },

    init() {
        this.startLogStream();

        // Sync DEBUG filter with debugLogging sub-toggle
        const settings = Alpine.store('settings');
        if (settings) {
            this.filters.DEBUG = !!settings.debugLogging;
            this.$watch('$store.settings.debugLogging', (val) => {
                this.filters.DEBUG = !!val;
            });
        }

        this.$watch('isAutoScroll', (val) => {
            if (val && Alpine.store('global')?.activeTab === 'logs') this.scrollToBottom();
        });

        // Watch filters to maintain auto-scroll if enabled
        this.$watch('searchQuery', () => {
            if (this.isAutoScroll && Alpine.store('global')?.activeTab === 'logs') {
                this.$nextTick(() => this.scrollToBottom());
            }
        });
        this.$watch('filters', () => {
            if (this.isAutoScroll && Alpine.store('global')?.activeTab === 'logs') {
                this.$nextTick(() => this.scrollToBottom());
            }
        });

        window.addEventListener('beforeunload', () => {
            this.destroy();
        });
    },

    destroy() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.eventSource) {
            try { this.eventSource.close(); } catch (e) {}
            this.eventSource = null;
        }
    },

    startLogStream() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this.eventSource) {
            try { this.eventSource.close(); } catch (e) {}
            this.eventSource = null;
        }

        const password = Alpine.store('global').webuiPassword;
        // Only request history if we don't have any logs cached yet
        const needHistory = this.logs.length === 0;
        let url = `/api/logs/stream?history=${needHistory}`;
        if (password) {
            url += `&password=${encodeURIComponent(password)}`;
        }

        const es = new EventSource(url);
        this.eventSource = es;

        es.onmessage = (event) => {
            if (this.eventSource !== es) return;
            try {
                if (!event.data || !event.data.trim()) return;
                const log = JSON.parse(event.data);

                // Deduplicate incoming history logs
                const key = `${log.timestamp}-${log.level}-${log.message}`;
                if (this._recentLogKeys.has(key)) return;
                this._recentLogKeys.add(key);
                if (this._recentLogKeys.size > 2000) {
                    // Prune oldest keys
                    const keysArr = Array.from(this._recentLogKeys);
                    this._recentLogKeys = new Set(keysArr.slice(-1000));
                }

                this.logs.push(log);

                // Limit log buffer to prevent browser memory exhaustion
                const limit = Alpine.store('settings')?.logLimit || window.AppConstants?.LIMITS?.DEFAULT_LOG_LIMIT || 1000;
                if (this.logs.length > limit) {
                    this.logs = this.logs.slice(-limit);
                }

                if (this.isAutoScroll && Alpine.store('global')?.activeTab === 'logs') {
                    this.$nextTick(() => this.scrollToBottom());
                }
            } catch (e) {
                if (window.UILogger) window.UILogger.debug('Log parse error:', e.message);
            }
        };

        es.onerror = () => {
            if (this.eventSource !== es) return;
            // Native EventSource auto-reconnects on transient network drops.
            // Only manually reconnect if connection is completely CLOSED.
            if (es.readyState === EventSource.CLOSED) {
                if (window.UILogger) window.UILogger.debug('Log stream closed, retrying in 5s...');
                if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
                this._reconnectTimer = setTimeout(() => {
                    this.startLogStream();
                }, 5000);
            }
        };
    },

    scrollToBottom() {
        const container = document.getElementById('logs-container');
        if (container) container.scrollTop = container.scrollHeight;
    },

    clearLogs() {
        this.logs = [];
        this._recentLogKeys.clear();
    },

    exportLogs() {
        if (this.logs.length === 0) return;

        const shouldRedact = Alpine.store('settings')?.redactMode && window.Redact;
        const lines = this.logs.map(log => {
            const ts = new Date(log.timestamp).toISOString();
            const message = shouldRedact ? window.Redact.logMessage(log.message) : log.message;
            return `[${ts}] [${log.level}] ${message}`;
        });

        const text = lines.join('\n');
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `proxy-logs-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
});
