import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const configDir = path.join(os.homedir(), '.config', 'antigravity-proxy');
const accountsFile = path.join(configDir, 'accounts.json');

if (!fs.existsSync(accountsFile)) {
    console.log('No local accounts.json found at:', accountsFile);
    process.exit(0);
}

const data = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
const accounts = Array.isArray(data) ? data : (data.accounts || []);

if (accounts.length === 0) {
    console.log('No accounts found in accounts.json');
    process.exit(0);
}

const sqlLines = [];
for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    const id = a.id || `acc_${i + 1}_${Date.now()}`;
    const email = (a.email || `account_${i + 1}`).replace(/'/g, "''");
    const refreshToken = (a.refreshToken || a.refresh_token || '').replace(/'/g, "''");
    const projectId = (a.projectId || a.project_id || 'rising-fact-p41fc').replace(/'/g, "''");
    const tier = (a.tier || a.subscriptionTier || a.subscription_tier || 'unknown').replace(/'/g, "''");
    const enabled = a.enabled === false ? 0 : 1;
    const source = (a.source || (a.custom ? 'custom' : 'oauth')).replace(/'/g, "''");
    const customConfig = (a.source === 'custom' || a.custom) ? JSON.stringify(a).replace(/'/g, "''") : null;
    const customVal = customConfig ? `'${customConfig}'` : 'NULL';

    sqlLines.push(`INSERT INTO accounts (id, email, refresh_token, project_id, subscription_tier, enabled, source, custom_config, cooldown_until, last_used) VALUES ('${id}', '${email}', '${refreshToken}', '${projectId}', '${tier}', ${enabled}, '${source}', ${customVal}, 0, 0) ON CONFLICT(email) DO UPDATE SET refresh_token = excluded.refresh_token, subscription_tier = excluded.subscription_tier, source = excluded.source, custom_config = excluded.custom_config;`);
}

const sqlPath = path.join(process.cwd(), 'seed-accounts.sql');
fs.writeFileSync(sqlPath, sqlLines.join('\n'));
console.log(`Generated ${sqlLines.length} statements in seed-accounts.sql`);
