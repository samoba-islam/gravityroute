/**
 * Add Account / Provider Modal Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.addAccountModal = () => ({
    // Active group tab: 'antigravity' | 'openai' | 'anthropic'
    activeTab: 'antigravity',

    // Antigravity OAuth state
    manualMode: false,
    authUrl: '',
    authState: '',
    callbackInput: '',
    submitting: false,

    // Custom Provider form state
    providerName: '',
    baseUrl: '',
    apiKey: '',
    showApiKey: false,

    // Model selection state
    modelMode: 'fetch', // 'fetch' or 'single'
    singleModelInput: '',
    customModels: [],
    fetchedModels: [],
    selectedModels: [],
    modelSearchQuery: '',
    fetchingModels: false,
    savingProvider: false,

    // Quota & pricing state
    quotaType: 'dollar', // 'dollar' | 'token' | 'unlimited'
    initialBalance: 10,
    initialTokens: 10000000,
    inputPricePerM: 0.14,
    outputPricePerM: 0.28,
    cachePricePerM: 0.014,

    /**
     * Switch active tab and adjust contextual defaults
     */
    setTab(tab) {
        this.activeTab = tab;
        if (tab === 'openai') {
            if (!this.baseUrl) this.baseUrl = 'https://api.deepseek.com/v1';
            if (!this.providerName) this.providerName = 'deepseek';
        } else if (tab === 'anthropic') {
            if (!this.baseUrl || this.baseUrl.includes('deepseek')) this.baseUrl = 'https://api.anthropic.com/v1';
            if (!this.providerName || this.providerName === 'deepseek') this.providerName = 'anthropic';
        }
    },

    /**
     * Reset all state to initial values
     */
    resetState() {
        this.activeTab = 'antigravity';
        this.manualMode = false;
        this.authUrl = '';
        this.authState = '';
        this.callbackInput = '';
        this.submitting = false;

        this.providerName = '';
        this.baseUrl = '';
        this.apiKey = '';
        this.showApiKey = false;

        this.modelMode = 'fetch';
        this.singleModelInput = '';
        this.customModels = [];
        this.fetchedModels = [];
        this.selectedModels = [];
        this.modelSearchQuery = '';
        this.fetchingModels = false;
        this.savingProvider = false;

        this.quotaType = 'dollar';
        this.initialBalance = 10;
        this.initialTokens = 10000000;
        this.inputPricePerM = 0.14;
        this.outputPricePerM = 0.28;
        this.cachePricePerM = 0.014;

        // Close any open details elements
        const details = document.querySelectorAll('#add_account_modal details[open]');
        details.forEach(d => d.removeAttribute('open'));
    },

    // ==========================================
    // Antigravity OAuth Methods
    // ==========================================

    async copyLink() {
        if (!this.authUrl) return;
        await navigator.clipboard.writeText(this.authUrl);
        Alpine.store('global').showToast(Alpine.store('global').t('linkCopied'), 'success');
    },

    async initManualAuth(event) {
        if (event.target.open && !this.authUrl) {
            try {
                const password = Alpine.store('global').webuiPassword;
                const { response, newPassword } = await window.utils.request('/api/auth/url', {}, password);
                if (newPassword) Alpine.store('global').webuiPassword = newPassword;
                const data = await response.json();
                if (data.status === 'ok') {
                    this.authUrl = data.url;
                    this.authState = data.state;
                }
            } catch (e) {
                Alpine.store('global').showToast(e.message, 'error');
            }
        }
    },

    async completeManualAuth() {
        if (!this.callbackInput || !this.authState) return;
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request('/api/auth/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callbackInput: this.callbackInput,
                    state: this.authState
                })
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('accountAddedSuccess'), 'success');
                Alpine.store('data').fetchData();
                document.getElementById('add_account_modal').close();
                this.resetState();
            } else {
                store.showToast(data.error || store.t('authFailed'), 'error');
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    },

    // ==========================================
    // Custom Provider Model Selection Methods
    // ==========================================

    get filteredFetchedModels() {
        if (!this.modelSearchQuery || !this.modelSearchQuery.trim()) {
            return this.fetchedModels;
        }
        const query = this.modelSearchQuery.toLowerCase().trim();
        return this.fetchedModels.filter(m => m.toLowerCase().includes(query));
    },

    isModelSelected(model) {
        return this.selectedModels.includes(model);
    },

    toggleModel(model) {
        if (this.isModelSelected(model)) {
            this.selectedModels = this.selectedModels.filter(m => m !== model);
        } else {
            this.selectedModels.push(model);
        }
    },

    selectAllModels() {
        const toAdd = this.filteredFetchedModels;
        const currentSet = new Set(this.selectedModels);
        for (const m of toAdd) {
            currentSet.add(m);
        }
        this.selectedModels = Array.from(currentSet);
    },

    deselectAllModels() {
        const toRemove = new Set(this.filteredFetchedModels);
        this.selectedModels = this.selectedModels.filter(m => !toRemove.has(m));
    },

    addSingleModel() {
        const trimmed = (this.singleModelInput || '').trim();
        if (!trimmed) return;
        if (!this.customModels.includes(trimmed)) {
            this.customModels.push(trimmed);
        }
        this.singleModelInput = '';
    },

    removeSingleModel(model) {
        this.customModels = this.customModels.filter(m => m !== model);
    },

    async fetchModelsFromApi() {
        const store = Alpine.store('global');
        if (!this.baseUrl || !this.baseUrl.trim()) {
            store.showToast(store.t('baseUrlPlaceholder') || 'Please enter a Base URL first', 'error');
            return;
        }

        this.fetchingModels = true;
        try {
            const password = store.webuiPassword;
            const { response, newPassword } = await window.utils.request('/api/providers/fetch-models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: this.activeTab,
                    baseUrl: this.baseUrl.trim(),
                    apiKey: this.apiKey ? this.apiKey.trim() : ''
                })
            }, password);

            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();

            if (data.status === 'ok' && Array.isArray(data.models)) {
                this.fetchedModels = data.models;
                // Pre-select all fetched models by default
                this.selectedModels = [...data.models];
                store.showToast(store.t('fetchModelsSuccess', { count: data.models.length }) || `Fetched ${data.models.length} models`, 'success');
            } else {
                store.showToast(data.error || store.t('fetchModelsFailed'), 'error');
            }
        } catch (e) {
            store.showToast((store.t('fetchModelsFailed') || 'Failed to fetch models') + ': ' + e.message, 'error');
        } finally {
            this.fetchingModels = false;
        }
    },

    // ==========================================
    // Save Custom Provider
    // ==========================================

    async saveCustomProvider() {
        const store = Alpine.store('global');

        const cleanName = (this.providerName || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        if (!cleanName) {
            store.showToast(store.t('providerNamePlaceholder') || 'Please enter a valid Provider Name', 'error');
            return;
        }

        if (!this.baseUrl || !this.baseUrl.trim()) {
            store.showToast(store.t('baseUrlPlaceholder') || 'Please enter a Base URL', 'error');
            return;
        }

        let models = [];
        if (this.modelMode === 'fetch') {
            models = this.selectedModels;
        } else {
            // Also include singleModelInput if user typed without clicking plus
            if (this.singleModelInput && this.singleModelInput.trim()) {
                this.addSingleModel();
            }
            models = this.customModels;
        }

        if (!models || models.length === 0) {
            store.showToast('Please add or select at least one model for this provider', 'error');
            return;
        }

        this.savingProvider = true;
        try {
            const password = store.webuiPassword;
            const payload = {
                name: cleanName,
                type: this.activeTab,
                baseUrl: this.baseUrl.trim(),
                apiKey: (this.apiKey || '').trim(),
                models: models,
                quotaType: this.quotaType,
                initialBalance: Number(this.initialBalance) || 0,
                initialTokens: Number(this.initialTokens) || 0,
                pricing: {
                    inputPricePerM: Number(this.inputPricePerM) || 0,
                    outputPricePerM: Number(this.outputPricePerM) || 0,
                    cachePricePerM: Number(this.cachePricePerM) || 0
                }
            };

            const { response, newPassword } = await window.utils.request('/api/providers/custom', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }, password);

            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();

            if (data.status === 'ok') {
                store.showToast(store.t('accountAddedSuccess') || 'Provider added successfully', 'success');
                await Alpine.store('data').fetchData();
                document.getElementById('add_account_modal').close();
                this.resetState();
            } else {
                store.showToast(data.error || 'Failed to add provider', 'error');
            }
        } catch (e) {
            store.showToast('Failed to add provider: ' + e.message, 'error');
        } finally {
            this.savingProvider = false;
        }
    }
});
