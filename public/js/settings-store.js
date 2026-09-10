/**
 * Settings Store
 */
const initSettingsStore = () => {
    if (window.Alpine && !Alpine.store('settings')) {
        Alpine.store('settings', {
            refreshInterval: 60,
            logLimit: 2000,
            showExhausted: true,
            showHiddenModels: false,
            showAllAccounts: false,
            showConfigWarning: true,
            compact: false,
            redactMode: false,
            placeholderMode: false,
            placeholderIncludeReal: true,
            debugLogging: true,
            logExport: true,
            healthInspector: true,
            healthInspectorOpen: false,
            port: 8080, // Display only

            init() {
                this.loadSettings();
            },

            // Call this method when toggling settings in the UI
            toggle(key) {
                if (this.hasOwnProperty(key) && typeof this[key] === 'boolean') {
                    this[key] = !this[key];
                    this.saveSettings();
                }
            },

            loadSettings() {
                try {
                    const saved = localStorage.getItem('antigravity_settings');
                    if (saved) {
                        const parsed = JSON.parse(saved);
                        Object.assign(this, parsed);
                    }
                } catch (e) {
                    console.error('Failed to load settings:', e);
                }
            },

            saveSettings() {
                try {
                    const toSave = {
                        refreshInterval: this.refreshInterval,
                        logLimit: this.logLimit,
                        showExhausted: this.showExhausted,
                        showHiddenModels: this.showHiddenModels,
                        showAllAccounts: this.showAllAccounts,
                        showConfigWarning: this.showConfigWarning,
                        compact: this.compact,
                        redactMode: this.redactMode,
                        placeholderMode: this.placeholderMode,
                        placeholderIncludeReal: this.placeholderIncludeReal,
                        debugLogging: this.debugLogging,
                        logExport: this.logExport,
                        healthInspector: this.healthInspector,
                    };
                    localStorage.setItem('antigravity_settings', JSON.stringify(toSave));
                } catch (e) {
                    console.error('Failed to save settings:', e);
                }

                // Trigger updates
                document.dispatchEvent(new CustomEvent('refresh-interval-changed'));
                if (Alpine.store('data')) {
                    Alpine.store('data').computeQuotaRows();
                }
            }
        });
    }
};

if (window.Alpine) {
    initSettingsStore();
} else {
    document.addEventListener('alpine:init', initSettingsStore);
}
