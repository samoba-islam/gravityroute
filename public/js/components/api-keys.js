/**
 * API Keys Management Component
 * Handles API key generation, listing, token limits, expiration, revocation, and deletion.
 * Registers to window.Components for Alpine.js to consume.
 */
window.Components = window.Components || {};

window.Components.apiKeys = () => ({
    // Tab state (sub-tabs within the API section)
    activeApiTab: 'keys',

    // Data state
    keys: [],
    loading: false,
    searchQuery: '',
    filterStatus: 'all',

    // Set of key IDs that the user has toggled to reveal in the table
    revealedKeys: new Set(),

    // Detected client IP for quick one-click rule adding
    detectedIp: '',

    // Available models loaded from server/store
    availableModels: [],

    // Form state for creating a key
    form: {
        name: '',
        presetDays: '30', // '7' | '30' | '60' | '90' | 'never' | 'custom'
        customExpiry: '',
        tokenLimit: 0, // 0 = unlimited
        ipRestrictionEnabled: false,
        ipRestrictionMode: 'allow', // 'allow' | 'deny'
        ipListText: '',
        modelRestrictionEnabled: false,
        allowedModels: [],
        modelSearch: '',
        customModelInput: '',
        submitting: false
    },

    // Form state for modifying an existing key
    editForm: {
        id: '',
        key: '',
        name: '',
        presetDays: 'keep', // 'keep' | '7' | '30' | '60' | '90' | 'never' | 'custom'
        customExpiry: '',
        currentExpiry: null,
        tokenLimit: 0,
        tokensUsed: 0,
        resetTokens: false,
        ipRestrictionEnabled: false,
        ipRestrictionMode: 'allow', // 'allow' | 'deny'
        ipListText: '',
        modelRestrictionEnabled: false,
        allowedModels: [],
        modelSearch: '',
        customModelInput: '',
        submitting: false
    },

    // Store for newly created key to show in the success modal
    createdKeyData: null,

    // Deletion confirmation state
    keyToDelete: null,
    deletingKey: false,

    // Token usage analytics state
    usageLoading: false,
    refreshingPricing: false,
    usageData: null,
    selectedKeyForUsage: null,
    usageFilter: {
        keyId: 'all',
        model: 'all',
        timeRange: '24h',
        interval: 'hour'
    },

    init() {
        this.fetchKeys();
        this.fetchMyIp();

        // Ensure data store models are loaded for matching #models page
        if (!Alpine.store('data')?.models || Alpine.store('data').models.length === 0) {
            Alpine.store('data')?.fetchData?.();
        }

        // Refresh keys whenever the API tab becomes active
        this.$watch('$store.global.activeTab', (tab) => {
            if (tab === 'api') {
                this.fetchKeys();
                this.fetchMyIp();
                if (!Alpine.store('data')?.models || Alpine.store('data').models.length === 0) {
                    Alpine.store('data')?.fetchData?.();
                }
            }
        });
    },

    /**
     * Fetch client IP address for quick fill
     */
    async fetchMyIp() {
        const store = Alpine.store('global');
        try {
            const { response } = await window.utils.request(
                '/api/my-ip',
                { method: 'GET' },
                store.webuiPassword
            );
            if (response.ok) {
                const data = await response.json();
                if (data.ip) {
                    this.detectedIp = data.ip;
                }
            }
        } catch (err) {
            console.warn('[APIKeys] Failed to fetch client IP:', err);
        }
    },

    /**
     * Append current client IP to the IP list textarea
     */
    async addCurrentIp(target = 'create') {
        if (!this.detectedIp) {
            await this.fetchMyIp();
        }
        const ipToAdd = this.detectedIp || '127.0.0.1';
        const targetObj = target === 'edit' ? this.editForm : this.form;
        const currentLines = (targetObj.ipListText || '')
            .split(/[\r\n]+/)
            .map(s => s.trim())
            .filter(Boolean);

        if (!currentLines.includes(ipToAdd)) {
            currentLines.push(ipToAdd);
            targetObj.ipListText = currentLines.join('\n');
            Alpine.store('global').showToast(`Added current IP (${ipToAdd})`, 'success');
        } else {
            Alpine.store('global').showToast(`Current IP (${ipToAdd}) already in list`, 'info');
        }
    },

    /**
     * Fetch list of API keys from server
     */
    async fetchKeys() {
        this.loading = true;
        const store = Alpine.store('global');
        try {
            const { response, newPassword } = await window.utils.request(
                '/api/keys',
                { method: 'GET' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            this.keys = data.keys || [];
            if (Array.isArray(data.availableModels) && data.availableModels.length > 0) {
                this.availableModels = data.availableModels;
            }
        } catch (error) {
            console.error('[APIKeys] Error fetching keys:', error);
            store.showToast('Failed to load API keys: ' + error.message, 'error');
        } finally {
            this.loading = false;
        }
    },

    /**
     * Complete list of all available system models.
     * Matches EXACTLY the models available in http://localhost:8080/#models and Settings -> Models.
     */
    get allAvailableModels() {
        const dataStore = Alpine.store('data');
        let models = [];

        // 1. Primary source: Live models from data store (same as #models and Settings -> Models)
        if (Array.isArray(dataStore?.models) && dataStore.models.length > 0) {
            models = [...dataStore.models];
        } else if (Array.isArray(this.availableModels) && this.availableModels.length > 0) {
            // 2. Secondary source: Models list returned by GET /api/keys
            models = [...this.availableModels];
        }

        // 3. Respect model visibility configured in Settings -> Models tab
        const modelConfig = dataStore?.modelConfig || {};
        const showHidden = Alpine.store('settings')?.showHiddenModels ?? false;
        if (!showHidden && Object.keys(modelConfig).length > 0) {
            models = models.filter(m => modelConfig[m]?.hidden !== true);
        }

        const modelSet = new Set(models);

        // Also ensure any currently saved/selected models on the active key remain visible
        const activeAllowed = this.editForm?.id
            ? (this.editForm?.allowedModels || [])
            : (this.form?.allowedModels || []);
        for (const m of activeAllowed) {
            if (m && typeof m === 'string' && !m.includes('*')) {
                const hasPrefixed = models.some(avail => avail.includes('-') && avail.slice(avail.indexOf('-') + 1) === m);
                if (!hasPrefixed) {
                    modelSet.add(m);
                }
            }
        }

        return Array.from(modelSet).sort();
    },

    /**
     * Filter models for selection dropdown based on current search query
     */
    filteredAvailableModels(target = 'create') {
        const formObj = target === 'edit' ? this.editForm : this.form;
        const q = (formObj.modelSearch || '').toLowerCase().trim();
        const all = this.allAvailableModels;
        if (!q) return all;
        return all.filter(m => m.toLowerCase().includes(q));
    },

    isModelSelected(modelId, target = 'create') {
        const formObj = target === 'edit' ? this.editForm : this.form;
        if (!Array.isArray(formObj.allowedModels)) return false;
        if (formObj.allowedModels.includes(modelId)) return true;
        if (modelId.includes('-')) {
            const raw = modelId.slice(modelId.indexOf('-') + 1);
            if (formObj.allowedModels.includes(raw)) return true;
        }
        return false;
    },

    toggleModel(modelId, target = 'create') {
        const formObj = target === 'edit' ? this.editForm : this.form;
        if (!Array.isArray(formObj.allowedModels)) formObj.allowedModels = [];
        const raw = modelId.includes('-') ? modelId.slice(modelId.indexOf('-') + 1) : null;
        const idx = formObj.allowedModels.findIndex(m => m === modelId || (raw && m === raw));
        if (idx !== -1) {
            formObj.allowedModels.splice(idx, 1);
        } else {
            formObj.allowedModels.push(modelId);
        }
        formObj.allowedModels = [...formObj.allowedModels];
    },

    selectAllModels(target = 'create') {
        const formObj = target === 'edit' ? this.editForm : this.form;
        formObj.allowedModels = [...this.allAvailableModels];
    },

    deselectAllModels(target = 'create') {
        const formObj = target === 'edit' ? this.editForm : this.form;
        formObj.allowedModels = [];
    },

    selectCategoryModels(category, target = 'create') {
        const formObj = target === 'edit' ? this.editForm : this.form;
        if (!Array.isArray(formObj.allowedModels)) formObj.allowedModels = [];
        const currentSet = new Set(formObj.allowedModels);
        const matching = this.allAvailableModels.filter(m => {
            const low = m.toLowerCase();
            if (category === 'claude') return low.includes('claude');
            if (category === 'gemini') return low.includes('gemini');
            if (category === 'custom') return !low.includes('claude') && !low.includes('gemini');
            return false;
        });
        for (const m of matching) currentSet.add(m);
        formObj.allowedModels = Array.from(currentSet);
    },

    selectFamily(family, target = 'create') {
        return this.selectCategoryModels(family, target);
    },

    addCustomModel(target = 'create') {
        const formObj = target === 'edit' ? this.editForm : this.form;
        const val = (formObj.customModelInput || '').trim();
        if (!val) return;
        if (!Array.isArray(formObj.allowedModels)) formObj.allowedModels = [];
        if (!formObj.allowedModels.includes(val)) {
            formObj.allowedModels.push(val);
            formObj.allowedModels = [...formObj.allowedModels];
            Alpine.store('global').showToast(`Added model '${val}'`, 'success');
        }
        formObj.customModelInput = '';
    },

    removeModel(modelId, target = 'create') {
        const formObj = target === 'edit' ? this.editForm : this.form;
        if (!Array.isArray(formObj.allowedModels)) return;
        const raw = modelId.includes('-') ? modelId.slice(modelId.indexOf('-') + 1) : null;
        formObj.allowedModels = formObj.allowedModels.filter(m => m !== modelId && (!raw || m !== raw));
    },

    getModelCategoryLabel(model) {
        const low = model.toLowerCase();
        if (low.includes('claude')) return 'Claude';
        if (low.includes('gemini')) return 'Gemini';
        if (low.includes('gpt') || low.includes('openai')) return 'OpenAI';
        return 'Custom';
    },

    getModelBadgeClass(model) {
        const low = model.toLowerCase();
        if (low.includes('claude')) return 'bg-amber-500/10 text-amber-300 border border-amber-500/30';
        if (low.includes('gemini')) return 'bg-sky-500/10 text-sky-300 border border-sky-500/30';
        if (low.includes('gpt') || low.includes('openai')) return 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30';
        return 'bg-neon-purple/10 text-purple-300 border border-neon-purple/30';
    },

    /**
     * Compute statistics for overview cards
     */
    get stats() {
        const total = this.keys.length;
        const active = this.keys.filter(k => k.effectiveStatus === 'active').length;
        const totalTokens = this.keys.reduce((acc, k) => acc + (k.tokensUsed || 0), 0);
        return { total, active, totalTokens };
    },

    /**
     * Filtered keys based on search and status
     */
    get filteredKeys() {
        let result = this.keys;

        // Status filter
        if (this.filterStatus !== 'all') {
            result = result.filter(k => k.effectiveStatus === this.filterStatus);
        }

        // Search query
        if (this.searchQuery.trim()) {
            const q = this.searchQuery.toLowerCase().trim();
            result = result.filter(k =>
                (k.name && k.name.toLowerCase().includes(q)) ||
                (k.key && k.key.toLowerCase().includes(q)) ||
                (k.id && k.id.toLowerCase().includes(q))
            );
        }

        return result;
    },

    /**
     * Open create modal and reset form
     */
    openCreateModal() {
        this.form.name = '';
        this.form.presetDays = '30';
        this.form.customExpiry = '';
        this.form.tokenLimit = 0;
        this.form.ipRestrictionEnabled = false;
        this.form.ipRestrictionMode = 'allow';
        this.form.ipListText = '';
        this.form.modelRestrictionEnabled = false;
        this.form.allowedModels = [];
        this.form.modelSearch = '';
        this.form.customModelInput = '';
        this.form.submitting = false;

        this.fetchMyIp();

        const modal = document.getElementById('create_api_key_modal');
        if (modal) modal.showModal();
    },

    /**
     * Submit and generate new API key
     */
    async createKey() {
        if (!this.form.name.trim()) {
            Alpine.store('global').showToast('Please provide an API key name', 'error');
            return;
        }

        this.form.submitting = true;
        const store = Alpine.store('global');

        try {
            let expiresAt = null;
            let presetDays = null;

            if (this.form.presetDays === 'custom') {
                if (this.form.customExpiry) {
                    expiresAt = new Date(this.form.customExpiry).getTime();
                    if (isNaN(expiresAt) || expiresAt <= Date.now()) {
                        throw new Error('Custom expiration date must be in the future');
                    }
                }
            } else if (this.form.presetDays === 'never') {
                presetDays = 'never';
            } else {
                presetDays = parseInt(this.form.presetDays, 10);
            }

            const ipList = (this.form.ipListText || '')
                .split(/[\r\n,]+/)
                .map(s => s.trim())
                .filter(Boolean);

            const payload = {
                name: this.form.name.trim(),
                presetDays,
                expiresAt,
                tokenLimit: parseInt(this.form.tokenLimit, 10) || 0,
                ipRestrictionEnabled: Boolean(this.form.ipRestrictionEnabled),
                ipRestrictionMode: this.form.ipRestrictionMode || 'allow',
                ipList,
                modelRestrictionEnabled: Boolean(this.form.modelRestrictionEnabled),
                allowedModels: this.form.allowedModels || []
            };

            const { response, newPassword } = await window.utils.request(
                '/api/keys',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            this.createdKeyData = data.key;

            // Close creation modal
            const createModal = document.getElementById('create_api_key_modal');
            if (createModal) createModal.close();

            // Open key created success modal
            const successModal = document.getElementById('key_created_success_modal');
            if (successModal) successModal.showModal();

            store.showToast(`API Key "${data.key.name}" generated successfully`, 'success');
            await this.fetchKeys();
        } catch (error) {
            console.error('[APIKeys] Create error:', error);
            store.showToast(error.message, 'error');
        } finally {
            this.form.submitting = false;
        }
    },

    /**
     * Toggle active/revoked status
     */
    async toggleRevoke(key) {
        const store = Alpine.store('global');
        const willRevoke = key.status === 'active';
        const actionWord = willRevoke ? 'revoke' : 'activate';

        try {
            const { response, newPassword } = await window.utils.request(
                `/api/keys/${encodeURIComponent(key.id)}/toggle`,
                { method: 'POST' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            store.showToast(`API Key ${actionWord}d: ${key.name}`, 'success');
            await this.fetchKeys();
        } catch (error) {
            console.error('[APIKeys] Toggle error:', error);
            store.showToast(`Failed to ${actionWord} API key: ` + error.message, 'error');
        }
    },

    /**
     * Open confirmation modal to delete a key
     */
    confirmDelete(key) {
        this.keyToDelete = key;
        const modal = document.getElementById('delete_api_key_modal');
        if (modal) modal.showModal();
    },

    /**
     * Backward compatibility wrapper
     */
    deleteKey(key) {
        this.confirmDelete(key);
    },

    /**
     * Execute deletion after user confirms in modal
     */
    async executeDeleteKey() {
        if (!this.keyToDelete) return;
        this.deletingKey = true;
        const store = Alpine.store('global');
        const targetKey = this.keyToDelete;

        try {
            const { response, newPassword } = await window.utils.request(
                `/api/keys/${encodeURIComponent(targetKey.id)}`,
                { method: 'DELETE' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${response.status}`);
            }

            store.showToast(`API Key "${targetKey.name}" deleted successfully`, 'success');

            const modal = document.getElementById('delete_api_key_modal');
            if (modal) modal.close();
            this.keyToDelete = null;

            await this.fetchKeys();
        } catch (error) {
            console.error('[APIKeys] Delete error:', error);
            store.showToast('Failed to delete API key: ' + error.message, 'error');
        } finally {
            this.deletingKey = false;
        }
    },

    /**
     * Open edit/modify modal with existing key details populated
     */
    openEditModal(k) {
        this.editForm.id = k.id;
        this.editForm.key = k.key;
        this.editForm.name = k.name || '';
        this.editForm.presetDays = 'keep';
        this.editForm.currentExpiry = k.expiresAt;
        if (k.expiresAt) {
            const d = new Date(k.expiresAt);
            const pad = (n) => String(n).padStart(2, '0');
            this.editForm.customExpiry = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } else {
            this.editForm.customExpiry = '';
        }
        this.editForm.tokenLimit = k.tokenLimit || 0;
        this.editForm.tokensUsed = k.tokensUsed || 0;
        this.editForm.resetTokens = false;
        this.editForm.ipRestrictionEnabled = k.ipRestrictionEnabled === true;
        this.editForm.ipRestrictionMode = k.ipRestrictionMode === 'deny' ? 'deny' : 'allow';
        this.editForm.ipListText = Array.isArray(k.ipList) ? k.ipList.join('\n') : '';
        this.editForm.modelRestrictionEnabled = k.modelRestrictionEnabled === true;
        this.editForm.allowedModels = Array.isArray(k.allowedModels) ? [...k.allowedModels] : [];
        this.editForm.modelSearch = '';
        this.editForm.customModelInput = '';
        this.editForm.submitting = false;

        this.fetchMyIp();

        const modal = document.getElementById('edit_api_key_modal');
        if (modal) modal.showModal();
    },

    /**
     * Save modified API key
     */
    async updateKey() {
        if (!this.editForm.name.trim()) {
            Alpine.store('global').showToast('Please provide an API key name', 'error');
            return;
        }

        this.editForm.submitting = true;
        const store = Alpine.store('global');

        try {
            let expiresAt = undefined;
            let presetDays = undefined;

            if (this.editForm.presetDays === 'keep') {
                presetDays = 'keep';
            } else if (this.editForm.presetDays === 'custom') {
                if (this.editForm.customExpiry) {
                    expiresAt = new Date(this.editForm.customExpiry).getTime();
                    if (isNaN(expiresAt) || expiresAt <= Date.now()) {
                        store.showToast('Please choose a valid future expiration date', 'error');
                        this.editForm.submitting = false;
                        return;
                    }
                } else {
                    expiresAt = null;
                }
            } else {
                presetDays = this.editForm.presetDays;
            }

            const ipList = (this.editForm.ipListText || '')
                .split(/[\r\n,]+/)
                .map(s => s.trim())
                .filter(Boolean);

            const { response, newPassword } = await window.utils.request(
                `/api/keys/${this.editForm.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: this.editForm.name.trim(),
                        presetDays,
                        expiresAt,
                        tokenLimit: this.editForm.tokenLimit,
                        resetTokens: this.editForm.resetTokens,
                        ipRestrictionEnabled: Boolean(this.editForm.ipRestrictionEnabled),
                        ipRestrictionMode: this.editForm.ipRestrictionMode || 'allow',
                        ipList,
                        modelRestrictionEnabled: Boolean(this.editForm.modelRestrictionEnabled),
                        allowedModels: this.editForm.allowedModels || []
                    })
                },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${response.status}`);
            }

            const data = await response.json();

            // Update in local keys array
            const idx = this.keys.findIndex(k => k.id === this.editForm.id);
            if (idx !== -1 && data.key) {
                this.keys[idx] = data.key;
                this.keys = [...this.keys];
            }

            store.showToast(data.message || 'API key updated successfully', 'success');

            const modal = document.getElementById('edit_api_key_modal');
            if (modal) modal.close();
        } catch (error) {
            console.error('[APIKeys] Update error:', error);
            store.showToast('Failed to update API key: ' + error.message, 'error');
        } finally {
            this.editForm.submitting = false;
        }
    },

    /**
     * Toggle reveal state of a key string
     */
    toggleReveal(id) {
        if (this.revealedKeys.has(id)) {
            this.revealedKeys.delete(id);
        } else {
            this.revealedKeys.add(id);
        }
        // Trigger Alpine reactivity
        this.revealedKeys = new Set(this.revealedKeys);
    },

    isRevealed(id) {
        return this.revealedKeys.has(id);
    },

    /**
     * Mask API key for secure display
     */
    getMaskedKey(keyString, id) {
        if (!keyString) return '';
        if (this.isRevealed(id)) return keyString;
        const prefix = keyString.slice(0, 7); // "ag-sk-"
        const suffix = keyString.slice(-4);
        return `${prefix}••••••••••••••••${suffix}`;
    },

    /**
     * Copy text to clipboard
     */
    async copyKey(text, label = 'API Key') {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            Alpine.store('global').showToast(`${label} copied to clipboard!`, 'success');
        } catch (err) {
            // Fallback for older browsers
            const input = document.createElement('textarea');
            input.value = text;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            Alpine.store('global').showToast(`${label} copied to clipboard!`, 'success');
        }
    },

    /**
     * Format number of tokens with k/M suffix
     */
    formatTokens(num) {
        if (!num || isNaN(num) || num === 0) return '0';
        if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        return num.toLocaleString();
    },

    /**
     * Format date for human readability
     */
    formatDate(timestamp) {
        if (!timestamp) return 'Never';
        const d = new Date(timestamp);
        return d.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    },

    /**
     * Format expiration badge and human text
     */
    formatExpiry(expiresAt) {
        if (!expiresAt) {
            return { text: 'Never', isExpired: false, isUrgent: false };
        }
        const now = Date.now();
        const diffMs = expiresAt - now;

        if (diffMs <= 0) {
            return { text: 'Expired', isExpired: true, isUrgent: true };
        }

        const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
        const hours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

        if (days > 0) {
            return {
                text: `In ${days} day${days > 1 ? 's' : ''}`,
                isExpired: false,
                isUrgent: days <= 3
            };
        }
        return {
            text: `In ${hours} hour${hours > 1 ? 's' : ''}`,
            isExpired: false,
            isUrgent: true
        };
    },

    /**
     * Open detailed token usage popup dashboard
     * @param {Object|null} key - Optional key record to focus on
     */
    openUsageModal(key = null) {
        this.selectedKeyForUsage = key;
        this.usageFilter.keyId = key ? key.id : 'all';
        this.usageFilter.model = 'all';
        this.usageFilter.timeRange = '24h';
        this.usageFilter.interval = 'hour';
        this.usageData = null;

        const modal = document.getElementById('token_usage_modal');
        if (modal) modal.showModal();

        this.fetchUsage();
    },

    /**
     * Fetch aggregated usage analytics based on current filters
     */
    async fetchUsage() {
        this.usageLoading = true;
        const store = Alpine.store('global');
        try {
            const query = new URLSearchParams({
                keyId: this.usageFilter.keyId || 'all',
                model: this.usageFilter.model || 'all',
                timeRange: this.usageFilter.timeRange || '24h',
                interval: this.usageFilter.interval || 'hour'
            });

            const { response, newPassword } = await window.utils.request(
                `/api/keys/usage?${query.toString()}`,
                { method: 'GET' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            this.usageData = data.analytics || null;
        } catch (error) {
            console.error('[APIKeys] Error fetching usage analytics:', error);
            store.showToast('Failed to load usage data: ' + error.message, 'error');
        } finally {
            this.usageLoading = false;
        }
    },

    /**
     * Change time range filter (1h, 24h, 7d, 30d, all)
     */
    setUsageTimeRange(range) {
        this.usageFilter.timeRange = range;
        if ((range === '7d' || range === '30d' || range === 'all') && this.usageFilter.interval === 'hour') {
            this.usageFilter.interval = 'day';
        } else if ((range === '1h' || range === '24h') && this.usageFilter.interval === 'day') {
            this.usageFilter.interval = 'hour';
        }
        this.fetchUsage();
    },

    /**
     * Change interval (hour or day)
     */
    setUsageInterval(interval) {
        this.usageFilter.interval = interval;
        this.fetchUsage();
    },

    /**
     * Change model filter
     */
    setUsageModel(model) {
        this.usageFilter.model = model;
        this.fetchUsage();
    },

    /**
     * Change key filter
     */
    setUsageKey(keyId) {
        this.usageFilter.keyId = keyId;
        this.selectedKeyForUsage = keyId === 'all' ? null : (this.keys.find(k => k.id === keyId) || null);
        this.fetchUsage();
    },

    /**
     * Format number with comma separation
     */
    formatFullNumber(num) {
        if (!num || isNaN(num)) return '0';
        return Number(num).toLocaleString();
    },

    /**
     * Calculate percentage safely
     */
    calcPercent(val, total) {
        if (!val || !total || total <= 0) return 0;
        return Math.min(100, Math.round((val / total) * 100));
    },

    /**
     * Format currency amount (e.g. $0.0042, $0.15, $12.45)
     */
    formatCost(amount) {
        if (amount === undefined || amount === null || isNaN(amount) || amount === 0) return '$0.00';
        const num = Number(amount);
        if (num < 0.0001) return '< $0.0001';
        if (num < 0.01) return '$' + num.toFixed(4);
        if (num < 1) return '$' + num.toFixed(3);
        return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    /**
     * Re-fetch live pricing from public LiteLLM repository
     */
    async refreshPricing() {
        this.refreshingPricing = true;
        const store = Alpine.store('global');
        try {
            const { response, newPassword } = await window.utils.request(
                '/api/pricing/refresh',
                { method: 'POST' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            const count = data.result?.count || 0;
            store.showToast(`Model pricing synchronized (${count.toLocaleString()} live rates updated)`, 'success');
            await this.fetchUsage();
        } catch (error) {
            console.error('[APIKeys] Refresh pricing error:', error);
            store.showToast('Failed to refresh pricing: ' + error.message, 'error');
        } finally {
            this.refreshingPricing = false;
        }
    }
});

