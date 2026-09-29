const dotenv = require('dotenv');
const Fs = require('fs');
const Path = require('path');
dotenv.config();
let EmailProvider = require('./email');
function loadTemplate(filename) {
    const fullPath = Path.resolve(__dirname, '..', 'lib', filename);
    if (!Fs.existsSync(fullPath)) {
        throw new Error(`Template file not found: ${fullPath}`);
    }
    return Fs.readFileSync(fullPath, 'utf8');
}
async function sendNotification(options) {
    const from = "support@swipe.ai";
    let template;

    switch (options.template) {
        case ('DAILY_REVENUE_REPORT'):
            template = Fs.readFileSync('./lib/daily_report.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[TOTAL_ORDER]', options.totalOrder);
            template = template.replace('[PROTECTED_ORDER]', options.protectedOrder);
            template = template.replace('[TOTAL_REVENUE]', options.totalRevenue);
            
            template = template.replace('[TOTAL_ACTIVE_STORES]', options.totalActiveStores);
            template = template.replace('[PROTECTION_RATE]', options.protectionRate);
            template = template.replace('[CLAIMS_AMOUNT]', options.claimsAmount);
            template = template.replace('[REPORT_DATE]', options.reportDate || '');
            template = template.replace('[REPORT_WINDOW_NOTE]', options.reportWindowNote || '');
            template = template.replace('[DASHBOARD_URL]', options.dashboard_url);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case 'MONTHLY_STATEMENT':
            template = Fs.readFileSync('./lib/monthly_report.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[S3_FILE_URL]', options.s3_url);
            template = template.replace('[MONTH]', options.month)
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('ORDER_CREATE'):
            template = Fs.readFileSync('./lib/order_create.html', { encoding: 'utf-8' });
            template = template.replace(/{{ORDER_ID}}/g, options.order_id);
            template = template.replace('[MERCHANT_NAME]', options.merchant_name || options.store_name);
            template = template.replace('[ORDER_DATE]', options.order_date || '');
            template = template.replace('[ORDER_LINK]', options.order_link || '');
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('ORDER_CREATE_CUSTOMER'):
            template = Fs.readFileSync('./lib/protection-mail.html', { encoding: 'utf-8' });
            const storeUrl =
                options.store_name?.toLowerCase().includes("lola")
                    ? "https://lolaandtheboys.com/"
                    : "";

            template = template.replace('[STORE_URL]', storeUrl);
            template = template.replace('[STORE_LOGO_URL]', options.store_logo || options.logo);

            template = template.replace('[STORE_LOGO_URL]', options.store_logo || options.logo);
            template = template.replace('[FILE_CLAIM_URL]', options.query_string || '');
            template = template.replace('[MERCHANT_NAME]', options.store_name || options.merchant_name);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('RESET_PASSWORD'):
            template = Fs.readFileSync('./lib/reset_password.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options?.merchant_name);
            template = template.replace('[RESET_PASSWORD_LINK]', options.reset_password_url);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case 'CLAIM_CREATE':
      template = Fs.readFileSync('./lib/claim_create_admin.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[CLAIM_LINK]', options.claim_link);
            template = template.replace(/{{CLAIM_ID}}/g, options.order_number);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        // case ('CLAIM_CREATE_ADMIN'):
        //     template = Fs.readFileSync('./lib/claim_create_admin.html', { encoding: 'utf-8' });
        //     template = template.replace('[MERCHANT_NAME]', options.merchant_name);
        //     template = template.replace('[CLAIM_LINK]', options.claim_link);
        //     template = template.replace(/{{CLAIM_ID}}/g, options.order_number);
        //     template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
        //     break;
        case ('CLAIM_CREATE_CUSTOMER'):
            template = Fs.readFileSync('./lib/claim_create_customer.html', { encoding: 'utf-8' });
            template = template.replace('[CUSTOMER_NAME]', options.customer_name);
            template = template.replace(/{{ORDER_ID}}/g, options.order_id);
            template = template.replace(/{{CLAIM_ID}}/g, options.claim_id);
            template = template.replace('[CLAIM_STATUS]', options.claim_status);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('CLAIM_STATUS_CUSTOMER'):
            template = Fs.readFileSync('./lib/claim_status_customer.html', { encoding: 'utf-8' });
            template = template.replace('[CUSTOMER_NAME]', options.customer_name);
            template = template.replace(/{{ORDER_ID}}/g, options.order_id);
            template = template.replace(/{{CLAIM_ID}}/g, options.order_number);
            template = template.replace('[CLAIM_STATUS]', options.claim_status);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('CLAIM_STATUS_MERCHANT'):
            template = Fs.readFileSync('./lib/claim_status_merchant.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace(/{{CLAIM_ID}}/g, options.claim_id);
            template = template.replace('[CLAIM_LINK]', options.claim_link);
            template = template.replace('[CLAIM_STATUS]', options.claim_status);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('CLAIM_UPDATE'):
            template = Fs.readFileSync('./lib/claim_update.html', { encoding: 'utf-8' });
            template = template.replace('[CUSTOMER_NAME]', options.customer_name);
            template = template.replace(/{{CLAIM_ID}}/g, options.claim_id);
              template = template.replace(/{{ORDER_ID}}/g, options.order_id || '');
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('CLAIM_CREATE_ADMIN'):
            template = Fs.readFileSync('./lib/claim_approved.html', { encoding: 'utf-8' });
            template = template.replace('[CLAIM_LINK]', options.claim_link);
            template = template.replace(/{{ORDER_ID}}/g, options.order_id);
            template = template.replace(/{{CLAIM_ID}}/g, options.claim_id);
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('CLAIM_APPROVED_CUSTOMER'):
            template = Fs.readFileSync('./lib/claim_approved_customer.html', { encoding: 'utf-8' });
            template = template.replace('[CUSTOMER_NAME]', options.customer_name);
            template = template.replace(/{{ORDER_ID}}/g, options.order_id);
            template = template.replace(/{{CLAIM_ID}}/g, options.order_number);
            template = template.replace('[CLAIM_STATUS]', options.status);
            template = template.replace('[DAYS]', options.days);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('CLAIM_DENIED'):
            template = Fs.readFileSync('./lib/claim_denied.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace(/{{CLAIM_ID}}/g, options.claim_id);
            template = template.replace(/{{ORDER_ID}}/g, options.order_id);
            template = template.replace('[CLAIM_LINK]', options.claim_link);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('CLAIM_DENIED_CUSTOMER'):
            template = Fs.readFileSync('./lib/claim_denied_customer.html', { encoding: 'utf-8' });
            template = template.replace('[CUSTOMER_NAME]', options.customer_name);
            template = template.replace(/{{ORDER_ID}}/g, options.order_id);
            template = template.replace(/{{CLAIM_ID}}/g, options.order_number);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('CLAIM_REFUND_CUSTOMER'):
            template = Fs.readFileSync('./lib/claim_refund_customer.html', { encoding: 'utf-8' });
            template = template.replace('[CUSTOMER_NAME]', options.customer_name);
            template = template.replace(/{{ORDER_ID}}/g, options.order_id);
            template = template.replace('[ITEM_ROWS]', options.item_rows || '');
            template = template.replace('[TOTAL_AMOUNT]', options.total_amount || '$0.00');
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('CLAIM_REORDER_CUSTOMER'):
            template = Fs.readFileSync('./lib/claim_reorder_customer.html', { encoding: 'utf-8' });
            template = template.replace('[CUSTOMER_NAME]', options.customer_name);
            template = template.replace(/{{ORDER_ID}}/g, options.order_id);
            template = template.replace('[REORDER_ID]', options.reorder_id || '');
            template = template.replace('[ITEM_ROWS]', options.item_rows || '');
            template = template.replace('[TOTAL_AMOUNT]', options.total_amount || '$0.00');
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('RETURN_PAYMENT_CUSTOMER'):
        case ('RETURN_REORDER_CUSTOMER'):
        case ('RETURN_REFUND_CUSTOMER'):
        case ('RETURN_APPROVED_CUSTOMER'):
        case ('RETURN_DECLINED_CUSTOMER'):
        case ('RETURN_FILED_CUSTOMER'):
            template = loadTemplate('return_customer.html');
            template = template.replace('[HEADLINE]', options.headline || 'Return Update');
            template = template.replace('[STORE_NAME]', options.store_name || 'Store');
            template = template.replace('[CUSTOMER_NAME]', options.customer_name || 'Customer');
            template = template.replace('[MESSAGE]', options.message || 'There is an update to your return.');
            template = template.replace('[DETAILS_HTML]', options.details_html || '');
            template = template.replace('[ACTION_HTML]', options.action_html || '');
            template = template.replace('[FOOTER_MESSAGE]', options.footer_message || 'Thanks for trusting Swipe. If you need anything else, our team is here to help.');
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('BILLING_REQUEST'):
            template = Fs.readFileSync('./lib/billing_request.html', { encoding: 'utf-8' });
            template = template.split('[BILLING_APPROVAL_LINK]').join(options.billing_approval_link);
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('PAYMENT_LINK'):
            template = Fs.readFileSync('./lib/payment_link.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.split('[PAYMENT_LINK]').join(options.payment_link);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('APP_INSTALLED'):
            template = Fs.readFileSync('./lib/app_installed.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('MERCHANT_WELCOME'):
            template = Fs.readFileSync('./lib/welcome-email.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name || '');
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('ACCOUNT_MANAGER'):
            template = Fs.readFileSync('./lib/account_manager.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[MANAGER_NAME]', options.manager_name);
            template = template.replace('[MANAGER_EMAIL]', options.manager_email);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('BOOKING_CONFIRMATION'):
            template = Fs.readFileSync('./lib/booking_confirmation.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[DATE]', options.date);
            template = template.replace('[TIME]', options.time);
            template = template.split('[MEETING_LINK]').join(options.meeting_link);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('FEEDBACK_SURVEY'):
            template = Fs.readFileSync('./lib/feedback-survey.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('FOLLOW_UP_EMAIL'):
            template = Fs.readFileSync('./lib/follow-up-email.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[MANAGER_NAME]', options.manager_name);
            template = template.replace('[MANAGER_EMAIL]', options.manager_email);
            template = template.replace('[MANAGER_NUMBER]', options.manager_number);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('WELCOME_AUTOMATION_EMAIL'):
            template = Fs.readFileSync('./lib/welcome-automation-email.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[SCHEDULE_CALL_URL]', options.schedule_call_url);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('TRACKING_UPDATE'):
            template = Fs.readFileSync('./lib/magic_link.html', { encoding: 'utf-8' });
            template = template.replace('[ORDER_NUMBER]', options.order_number);
            template = template.replace('[EMAIL]', options.email);
            template = template.replace('[TRACKING_URL]', options.tracking_url);
            template = template.replace('[Name]', options.customer_name);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('SET-PASSWORD'):
            template = Fs.readFileSync('./lib/set_password.html', { encoding: 'utf-8' });
            template = template.replace('[PASSWORD_URL]', options.password_url);
            template = template.replace('[Name]', options.customer_name);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('ORDER_EXPORT'):
            template = Fs.readFileSync('./lib/order_export.html', { encoding: 'utf-8' });
            template = template.replace('[tracking_url]', options.tracking_url);
            template = template.replace('[NAME]', options.customer_name);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('WEBHOOK_ERROR'):
            template = Fs.readFileSync('./lib/webhook_error.html', { encoding: 'utf-8' });
            template = template.replace('[MERCHANT_NAME]', options.merchant_name);
            template = template.replace('[WEBHOOK_NAME]', options.webhook_name || 'Unknown');
            template = template.replace('[SHOP_DOMAIN]', options.shop_domain || 'Unknown Shop');
            template = template.replace('[ERROR_MESSAGE]', options.error_message || 'No error details available');
            template = template.replace(/\[ERROR_REASON\]/g, options.error_reason || 'Unknown reason');
            template = template.replace('[TIMESTAMP]', options.timestamp || new Date().toLocaleString());
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('MFA_OTP'):
            template = Fs.readFileSync('./lib/mfa_otp.html', { encoding: 'utf-8' });
            template = template.replace('[NAME]', options.user_name || 'User');
            template = template.replace('[OTP]', options.otp);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('ENABLE_MFA_OTP'):
            template = Fs.readFileSync('./lib/enable_mfa_otp.html', { encoding: 'utf-8' });
            template = template.replace('[NAME]', options.user_name || 'User');
            template = template.replace('[OTP]', options.otp);
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('CUSTOM_HTML'):
            template = options.html;
            break;
        case ('CUSTOMER_EMAIL_COMMUNICATION'):
            template = Fs.readFileSync('./lib/customer_communication.html', { encoding: 'utf-8' });
            template = template.replace('[EMAIL]', options.email || 'unknown');
            template = template.replace('[MESSAGE]', options.message || 'Unknown message');
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;
        case ('VERIFY_NEW_EMAIL'):
            template = Fs.readFileSync('./lib/verify_new_email.html', { encoding: 'utf-8' });
            template = template.replace('[NAME]', options.user_name || 'unknown');
            template = template.replace('[VERIFY_LINK]', options.verify_link || 'Unknown link');
            template = template.replace('[CURRENT_YEAR]', new Date().getFullYear());
            break;


        default:
            throw new Error(`Unknown template key: ${options.template}`);
    }
    const leftover = template.match(/\[\w+\]|\{\{\w+\}\}/g);
    if (leftover) {
        throw new Error(
            `${options.template}: Unreplaced placeholders → ${[...new Set(leftover)].join(', ')}`
        );
    }
    await EmailProvider.send(
        options.to,
        options.subject,
        template,
        options.attachments,
        options.cc,
        from   // 👈 ye add karo
    );
    return { html: template };
}
module.exports = {
    __setEmailProvider: provider => { EmailProvider = provider; },
    sendNotification,
};
