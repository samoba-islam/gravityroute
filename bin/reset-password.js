#!/usr/bin/env node

/**
 * GravityRoute WebUI Admin Password Reset CLI Utility
 * Usage:
 *   node bin/reset-password.js <new-password> [username]
 *   npm run reset-password -- <new-password>
 */

import crypto from 'crypto';
import { config, saveConfig } from '../src/config.js';

const args = process.argv.slice(2).filter(arg => !arg.startsWith('--force'));
const force = process.argv.includes('--force');

// Check if CLI recovery is disabled (unless --force is supplied)
if (config.webuiRecoveryMode && config.webuiRecoveryMode.cliEnabled === false && !force) {
    console.error('\n⚠️  CLI Password Reset is currently disabled in WebUI Auth settings.');
    console.error('   To force reset from the host terminal, run:');
    console.error('   node bin/reset-password.js <new_password> --force\n');
    process.exit(1);
}

let newPassword = args[0];
let username = args[1] || config.webuiUsername || 'admin';

// If no password provided, generate a secure random 10-character password
let generated = false;
if (!newPassword) {
    newPassword = crypto.randomBytes(6).toString('base64url').slice(0, 10);
    generated = true;
}

if (newPassword.length < 4) {
    console.error('\n❌ Password must be at least 4 characters long.\n');
    process.exit(1);
}

const updates = {
    webuiPassword: newPassword
};

if (username) {
    updates.webuiUsername = username;
}

const success = saveConfig(updates);

if (success) {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║           ⚡ GravityRoute Admin Password Reset              ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Username:     ${username.padEnd(46)}║`);
    console.log(`║  New Password: ${newPassword.padEnd(46)}║`);
    if (generated) {
        console.log('║  (Generated temporary password)                              ║');
    }
    console.log('║                                                              ║');
    console.log('║  Status:       ✓ Password successfully updated on disk       ║');
    console.log('║  Login URL:    http://localhost:8080                         ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
    process.exit(0);
} else {
    console.error('\n❌ Failed to save updated credentials to configuration file.\n');
    process.exit(1);
}
