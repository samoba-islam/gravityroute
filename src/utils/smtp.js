import nodemailer from 'nodemailer';
import { logger } from './logger.js';
import { config } from '../config.js';

/**
 * Build a nodemailer transport instance from SMTP configuration
 * @param {Object} smtpConfig
 * @returns {import('nodemailer').Transporter}
 */
export function createTransporter(smtpConfig = {}) {
    const host = smtpConfig.host || config.smtp?.host || '';
    const port = parseInt(smtpConfig.port || config.smtp?.port || 587, 10);
    const secure = smtpConfig.secure !== undefined 
        ? Boolean(smtpConfig.secure) 
        : Boolean(config.smtp?.secure);
    
    // Resolve credentials (prefer provided, fallback to stored)
    const user = smtpConfig.user !== undefined ? smtpConfig.user : (config.smtp?.user || '');
    let pass = smtpConfig.pass;
    if (!pass && pass !== '' && config.smtp?.pass) {
        pass = config.smtp.pass;
    }

    const transportOptions = {
        host: host.trim(),
        port,
        secure,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
    };

    if (user || pass) {
        transportOptions.auth = {
            user: user ? user.trim() : '',
            pass: pass || ''
        };
    }

    return nodemailer.createTransport(transportOptions);
}

/**
 * Verify connection and credentials with the SMTP server
 * @param {Object} smtpConfig
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export async function verifySmtpConnection(smtpConfig = {}) {
    try {
        const transporter = createTransporter(smtpConfig);
        await transporter.verify();
        return { success: true, message: 'SMTP server connection and authentication successful' };
    } catch (error) {
        logger.error('[SMTP] Verification error:', error);
        return {
            success: false,
            error: error.message || 'Failed to connect to SMTP server',
            code: error.code
        };
    }
}

/**
 * Send a formatted test email to the specified recipient
 * @param {Object} smtpConfig
 * @param {string} recipient
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendTestEmail(smtpConfig = {}, recipient) {
    if (!recipient || typeof recipient !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.trim())) {
        return { success: false, error: 'A valid recipient email address is required' };
    }

    const host = smtpConfig.host || config.smtp?.host || 'localhost';
    const port = smtpConfig.port || config.smtp?.port || 587;
    const secure = smtpConfig.secure !== undefined ? Boolean(smtpConfig.secure) : Boolean(config.smtp?.secure);
    const fromEmail = smtpConfig.fromEmail || config.smtp?.fromEmail || smtpConfig.user || config.smtp?.user || 'noreply@antigravity.proxy';
    const fromName = smtpConfig.fromName || config.smtp?.fromName || 'Antigravity Proxy';
    const targetRecipient = recipient.trim();
    const timestamp = new Date().toUTCString();

    try {
        const transporter = createTransporter(smtpConfig);

        const mailOptions = {
            from: `"${fromName}" <${fromEmail}>`,
            to: targetRecipient,
            subject: `[Antigravity Proxy] SMTP Test Email - ${new Date().toLocaleTimeString()}`,
            text: `Antigravity Proxy SMTP Test Email\n\nThis is a test email sent from Antigravity Proxy to confirm that your SMTP configuration is active and working properly.\n\nDetails:\n- SMTP Server: ${host}:${port}\n- Security: ${secure ? 'SSL (Port 465)' : 'STARTTLS / TLS'}\n- Sender: ${fromName} <${fromEmail}>\n- Sent At: ${timestamp}\n`,
            html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0b0f19; color: #e2e8f0; border-radius: 12px; overflow: hidden; border: 1px solid #1e293b; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
                <div style="background: linear-gradient(135deg, #7c3aed, #4f46e5); padding: 24px 32px;">
                    <h1 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 700; letter-spacing: -0.025em;">
                        ⚡ Antigravity Proxy
                    </h1>
                    <p style="margin: 4px 0 0 0; color: #c4b5fd; font-size: 13px;">
                        SMTP Server Configuration Verification
                    </p>
                </div>
                <div style="padding: 32px;">
                    <div style="background-color: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 14px 18px; margin-bottom: 24px;">
                        <p style="margin: 0; color: #34d399; font-weight: 600; font-size: 14px;">
                            ✓ SMTP Service Connected Successfully
                        </p>
                        <p style="margin: 4px 0 0 0; color: #94a3b8; font-size: 12px;">
                            Your outbound mail server settings have been tested and verified.
                        </p>
                    </div>
                    
                    <h2 style="font-size: 14px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px;">
                        Connection Parameters
                    </h2>
                    <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 24px;">
                        <tr style="border-bottom: 1px solid #1e293b;">
                            <td style="padding: 10px 0; color: #64748b;">SMTP Host:</td>
                            <td style="padding: 10px 0; color: #f1f5f9; font-family: monospace; font-weight: 600; text-align: right;">${host}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #1e293b;">
                            <td style="padding: 10px 0; color: #64748b;">Port & Security:</td>
                            <td style="padding: 10px 0; color: #f1f5f9; font-family: monospace; text-align: right;">${port} (${secure ? 'SSL' : 'STARTTLS'})</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #1e293b;">
                            <td style="padding: 10px 0; color: #64748b;">Sender:</td>
                            <td style="padding: 10px 0; color: #f1f5f9; text-align: right;">${fromName} &lt;${fromEmail}&gt;</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #1e293b;">
                            <td style="padding: 10px 0; color: #64748b;">Recipient:</td>
                            <td style="padding: 10px 0; color: #38bdf8; text-align: right;">${targetRecipient}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px 0; color: #64748b;">Timestamp:</td>
                            <td style="padding: 10px 0; color: #94a3b8; font-size: 12px; text-align: right;">${timestamp}</td>
                        </tr>
                    </table>

                    <div style="border-top: 1px solid #1e293b; padding-top: 18px; text-align: center;">
                        <p style="margin: 0; color: #475569; font-size: 11px;">
                            This is an automated notification from your Antigravity Proxy server.
                        </p>
                    </div>
                </div>
            </div>
            `
        };

        const info = await transporter.sendMail(mailOptions);
        logger.info(`[SMTP] Test email sent to ${targetRecipient}, messageId: ${info.messageId}`);
        return {
            success: true,
            messageId: info.messageId,
            response: info.response,
            message: `Test email successfully sent to ${targetRecipient}`
        };
    } catch (error) {
        logger.error('[SMTP] Send test email failed:', error);
        return {
            success: false,
            error: error.message || 'Failed to send test email',
            code: error.code
        };
    }
}
