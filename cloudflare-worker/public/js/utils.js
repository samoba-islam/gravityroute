/**
 * Utility functions for GravityRoute Console
 */

window.utils = {
    // Shared Request Wrapper
    async request(url, options = {}, webuiPassword = '') {
        options.headers = options.headers || {};
        const store = (typeof Alpine !== 'undefined' && Alpine.store) ? Alpine.store('global') : null;
        const token = store?.authToken || 
                      localStorage.getItem('gravityroute_auth_token') || 
                      sessionStorage.getItem('gravityroute_auth_token') || 
                      localStorage.getItem('antigravity_auth_token') || 
                      sessionStorage.getItem('antigravity_auth_token');
        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }
        if (webuiPassword) {
            options.headers['x-webui-password'] = webuiPassword;
        }

        let response = await fetch(url, options);

        if (response.status === 401) {
            if (store) {
                store.authEnabled = true;
                store.authenticated = false;
                store.authToken = '';
            }
            localStorage.removeItem('gravityroute_auth_token');
            sessionStorage.removeItem('gravityroute_auth_token');
            localStorage.removeItem('antigravity_auth_token');
            sessionStorage.removeItem('antigravity_auth_token');
            return { response, newPassword: null };
        }

        return { response, newPassword: null };
    },

    formatTimeUntil(isoTime) {
        const store = Alpine.store('global');
        const diff = new Date(isoTime) - new Date();
        if (diff <= 0) return store ? store.t('ready') : 'READY';
        const mins = Math.floor(diff / 60000);
        const hrs = Math.floor(mins / 60);

        const hSuffix = store ? store.t('timeH') : 'H';
        const mSuffix = store ? store.t('timeM') : 'M';

        if (hrs > 0) return `${hrs}${hSuffix} ${mins % 60}${mSuffix}`;
        return `${mins}${mSuffix}`;
    },

    getThemeColor(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    },

    /**
     * Debounce function - delays execution until after specified wait time
     * @param {Function} func - Function to debounce
     * @param {number} wait - Wait time in milliseconds
     * @returns {Function} Debounced function
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
};
