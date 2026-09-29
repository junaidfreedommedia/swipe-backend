const moment = require('moment-timezone');

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const periodPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const defaults = (merchant = {}) => ({
    version: 1, revision: 0, enabled: false, provider: 'manual', trigger: 'manual',
    collection: 'send_invoice', billing_day: 5, billing_hour: 9,
    timezone: merchant.iana_timezone || 'America/Chicago', currency: 'usd',
    first_period: moment().format('YYYY-MM'), due_days: 7, review_limit: 1000,
    email: merchant.billing_contact_email || merchant.customer_email || merchant.email || '',
    statement_email: true, receipt_email: true, failure_email: true, reminder_email: true,
    stripe_retries: false,
});
function validateSettings(input, merchant) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Billing settings are required.');
    const settings = { ...defaults(merchant), ...merchant.billing_controls };
    const enums = { provider: ['manual', 'stripe', 'shopify'], trigger: ['manual', 'monthly'], collection: ['send_invoice', 'charge_automatically'] };
    for (const [key, allowed] of Object.entries(enums)) {
        if (!allowed.includes(input[key])) fail(`Invalid ${key}.`);
        settings[key] = input[key];
    }
    for (const key of ['enabled', 'statement_email', 'receipt_email', 'failure_email', 'reminder_email', 'stripe_retries']) {
        if (typeof input[key] !== 'boolean') fail(`${key} must be a boolean.`);
        settings[key] = input[key];
    }
    for (const [key, min, max] of [['billing_day', 1, 28], ['billing_hour', 0, 23], ['due_days', 1, 90]]) {
        if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) fail(`Invalid ${key}.`);
        settings[key] = input[key];
    }
    if (!moment.tz.zone(input.timezone)) fail('Choose a valid timezone.');
    if (input.currency !== 'usd') fail('Finance statements currently support USD billing only.');
    if (merchant.currency && String(merchant.currency).toLowerCase() !== 'usd') fail('This flow requires USD statements; review currency conversion before enabling this merchant.');
    if (!periodPattern.test(input.first_period || '')) fail('Choose a valid first billing period.');
    if (!Number.isFinite(input.review_limit) || input.review_limit < 0 || input.review_limit > 1000000) fail('Invalid review limit.');
    const email = String(input.email || '').trim();
    if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) fail('Enter a valid billing email.');
    Object.assign(settings, { timezone: input.timezone, currency: 'usd', first_period: input.first_period,
        review_limit: input.review_limit, email, version: 1, revision: (merchant.billing_controls?.revision || 0) + 1 });
    return settings;
}
function validatePeriod(period, settings, now = new Date()) {
    if (!periodPattern.test(period || '')) fail('Choose a valid billing month.');
    // Financial reporting retains its existing Chicago boundaries; schedule timezone is independent.
    if (period >= moment(now).tz('America/Chicago').format('YYYY-MM')) fail('Only completed months can be billed.');
    if (period < settings.first_period) fail('This month is before the first billing period.');
    return period;
}
function duePeriod(settings, now = new Date()) {
    if (!settings?.enabled || settings.trigger !== 'monthly') return null;
    const local = moment(now).tz(settings.timezone);
    const due = local.clone().startOf('month').date(settings.billing_day).hour(settings.billing_hour);
    if (local.isBefore(due)) return null;
    const period = local.clone().subtract(1, 'month').format('YYYY-MM');
    // Never invoice a month that has not closed in the financial reporting timezone.
    if (period < settings.first_period || period >= moment(now).tz('America/Chicago').format('YYYY-MM')) return null;
    return period;
}
function snapshotAmount({ fees, credits, commission }) {
    if (![fees, credits, commission].every(Number.isFinite) || commission < 0 || commission > 100) fail('Invalid statement totals; review the report.');
    const net = Number((fees - credits).toFixed(2));
    const commissionAmount = Number((net * commission / 100).toFixed(2));
    const amount = Math.round(Number((net - commissionAmount).toFixed(2)) * 100);
    if (!Number.isSafeInteger(amount)) fail('Invalid statement amount.');
    return { fees, credits, commission, commission_amount: commissionAmount, amount_cents: amount, currency: 'usd' };
}
function assertUncharged(statements) {
    if (statements.some(s => s.shopify_usage_charge_id || s.payment_link_id || s.payment_link || String(s.status).toLowerCase() === 'paid' ||
        (s.shopify_charge_status && s.shopify_charge_status !== 'skipped_zero_amount' && s.shopify_charge_status !== 'capacity_reached'))) {
        fail('This period has previous billing activity. Reconcile it before using the new billing flow.', 409);
    }
}
module.exports = { defaults, validateSettings, validatePeriod, duePeriod, snapshotAmount, assertUncharged, fail };
