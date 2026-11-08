import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPackageVersion } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

const execAsync = util.promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const GITHUB_REPO = 'samoba-islam/gravityroute';

export class SystemUpdater {
    constructor(projectRoot = PROJECT_ROOT) {
        this.projectRoot = projectRoot;
        this.isUpdating = false;
        this.lastCheckedAt = 0;
        this.cachedCheckResult = null;
    }

    /**
     * Check if current directory is a git repository
     */
    async isGitRepository() {
        try {
            const { stdout } = await execAsync('git rev-parse --is-inside-work-tree', {
                cwd: this.projectRoot,
                timeout: 3000
            });
            return stdout.trim() === 'true';
        } catch {
            return false;
        }
    }

    /**
     * Check GitHub and local git status for newer commits
     * @param {boolean} force - Force refresh bypass 5m cache
     */
    async checkForUpdates(force = false) {
        const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
        if (!force && this.cachedCheckResult && (Date.now() - this.lastCheckedAt < CACHE_TTL_MS)) {
            return this.cachedCheckResult;
        }

        const currentVersion = getPackageVersion();
        const isGitRepo = await this.isGitRepository();

        if (!isGitRepo) {
            const result = {
                status: 'ok',
                isGitRepo: false,
                hasUpdate: false,
                currentVersion,
                message: 'Application is not running from a Git repository (manual install or archive)'
            };
            this.cachedCheckResult = result;
            this.lastCheckedAt = Date.now();
            return result;
        }

        try {
            // Get local current commit and branch
            const { stdout: localHash } = await execAsync('git rev-parse HEAD', {
                cwd: this.projectRoot,
                timeout: 3000
            });
            const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', {
                cwd: this.projectRoot,
                timeout: 3000
            });

            const currentBranch = branch.trim() || 'main';
            const currentCommitFull = localHash.trim();
            const currentCommit = currentCommitFull.slice(0, 7);

            let latestCommitFull = null;
            let latestCommit = null;
            let latestMessage = '';
            let latestDate = null;
            let hasUpdate = false;
            let commitsBehind = 0;

            // 1. Try GitHub API
            try {
                const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/${currentBranch}`, {
                    headers: {
                        'User-Agent': 'GravityRoute-Console-Updater',
                        'Accept': 'application/vnd.github.v3+json'
                    },
                    signal: AbortSignal.timeout(6000)
                });

                if (response.ok) {
                    const data = await response.json();
                    latestCommitFull = data.sha;
                    latestCommit = data.sha.slice(0, 7);
                    latestMessage = data.commit?.message?.split('\n')[0] || '';
                    latestDate = data.commit?.author?.date || null;
                    hasUpdate = currentCommitFull !== latestCommitFull;
                }
            } catch (apiErr) {
                logger.warn('[Updater] GitHub API check failed, falling back to git ls-remote:', apiErr.message);
            }

            // 2. Fallback to git ls-remote if GitHub API was unreachable or rate-limited
            if (!latestCommitFull) {
                try {
                    const { stdout: remoteOutput } = await execAsync(`git ls-remote origin ${currentBranch}`, {
                        cwd: this.projectRoot,
                        timeout: 8000
                    });
                    const remoteHash = (remoteOutput.split('\t')[0] || '').trim();
                    if (remoteHash) {
                        latestCommitFull = remoteHash;
                        latestCommit = remoteHash.slice(0, 7);
                        hasUpdate = currentCommitFull !== latestCommitFull;
                    }
                } catch (gitErr) {
                    logger.warn('[Updater] git ls-remote failed:', gitErr.message);
                }
            }

            // 3. Count commits behind if update is available
            if (hasUpdate && latestCommitFull) {
                try {
                    await execAsync(`git fetch origin ${currentBranch} --quiet`, {
                        cwd: this.projectRoot,
                        timeout: 10000
                    });
                    const { stdout: count } = await execAsync(`git rev-list --count HEAD..origin/${currentBranch}`, {
                        cwd: this.projectRoot,
                        timeout: 3000
                    });
                    commitsBehind = parseInt(count.trim(), 10) || 1;
                } catch {
                    commitsBehind = 1;
                }
            }

            const result = {
                status: 'ok',
                isGitRepo: true,
                hasUpdate: Boolean(hasUpdate),
                currentVersion,
                currentCommit,
                latestCommit: latestCommit || currentCommit,
                latestMessage,
                latestDate,
                commitsBehind,
                branch: currentBranch,
                repoUrl: `https://github.com/${GITHUB_REPO}`
            };

            this.cachedCheckResult = result;
            this.lastCheckedAt = Date.now();
            return result;
        } catch (error) {
            logger.error('[Updater] Failed to check for updates:', error.message);
            return {
                status: 'error',
                isGitRepo,
                hasUpdate: false,
                currentVersion,
                error: error.message
            };
        }
    }

    /**
     * Perform safe automated update pipeline
     */
    async applyUpdate() {
        if (this.isUpdating) {
            throw new Error('An update is already in progress');
        }
        this.isUpdating = true;
        const steps = [];

        try {
            const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', {
                cwd: this.projectRoot,
                timeout: 3000
            });
            const currentBranch = branch.trim() || 'main';

            // Step 1: Stash any local working directory changes
            steps.push({ step: 'stash', message: 'Safeguarding local config and stashing edits...' });
            try {
                await execAsync('git stash', { cwd: this.projectRoot, timeout: 10000 });
            } catch (e) { /* ignore empty stash */ }

            // Step 2: Git pull
            steps.push({ step: 'pull', message: `Pulling latest changes from origin/${currentBranch}...` });
            const { stdout: pullOut } = await execAsync(`git pull --rebase origin ${currentBranch}`, {
                cwd: this.projectRoot,
                timeout: 45000
            });
            logger.info('[Updater] Git pull output:', pullOut.trim());

            // Step 3: Install production dependencies
            steps.push({ step: 'npm-install', message: 'Updating production dependencies (npm install)...' });
            try {
                await execAsync('npm install --omit=dev --no-audit --no-fund', {
                    cwd: this.projectRoot,
                    timeout: 90000
                });
            } catch (npmErr) {
                logger.warn('[Updater] npm install notice:', npmErr.message);
            }

            // Step 4: Rebuild Tailwind CSS
            steps.push({ step: 'build-css', message: 'Rebuilding frontend CSS styles...' });
            try {
                await execAsync('npm run build:css', {
                    cwd: this.projectRoot,
                    timeout: 30000
                });
            } catch (buildErr) {
                logger.warn('[Updater] build:css notice:', buildErr.message);
            }

            // Reset cache
            this.cachedCheckResult = null;
            this.lastCheckedAt = 0;

            steps.push({ step: 'complete', message: 'Update successfully applied. Restarting service in 2 seconds...' });
            return {
                status: 'ok',
                success: true,
                steps
            };
        } catch (error) {
            logger.error('[Updater] Failed to apply update:', error);
            throw new Error(`Update failed: ${error.message}`);
        } finally {
            this.isUpdating = false;
        }
    }

    /**
     * Trigger process restart for systemd / PM2 / container
     */
    restartService(delayMs = 2000) {
        setTimeout(() => {
            logger.info('[Updater] Exiting process for automatic supervisor restart...');
            process.exit(0);
        }, delayMs);
    }
}

const updater = new SystemUpdater();
export default updater;

