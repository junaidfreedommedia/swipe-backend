const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    const calls = [], emails = [];
    let approved = true, result = { appUsageRecord: { id: 'usage-1' }, userErrors: [] };
    const session = { shop: 'test.myshopify.com' };
    const shopify = { api: {
        billing: { check: async () => approved, request: async () => 'https://test.myshopify.com/approve' },
        clients: { Graphql: class {
            async request(query, options) {
                calls.push({ query, options });
                if (query.includes('mutation')) return { data: { appUsageRecordCreate: result } };
                return { data: { currentAppInstallation: { activeSubscriptions: [{ name: 'Swipe', lineItems: [{ id: 'line-1',
                    plan: { pricingDetails: { terms: 'fees', balanceUsed: { amount: '999' }, cappedAmount: { amount: '1000' } } } }] }] } } };
            }
        } },
    } };
    const context = { module: { exports: {} }, console: { log() {}, error() {} },
        Config: { get: key => key === 'BILLING_CONFIG' ? { Swipe: { usageTerms: 'fees' } } : true },
        require: name => name === './../shopify' ? shopify : { GraphqlQueryError: class extends Error {} },
        Services: { ShopifySession: { get: async () => session }, Merchant: { get: async () => ({ name: 'Test', customer_email: 'merchant@example.com' }) } },
        Notifications: { sendNotification: async info => emails.push(info) },
        MSG: { BILLING_NOT_APPROVED: 'Shopify billing is not approved' },
        empty: value => !value, throwError: error => { throw error instanceof Error ? error : new Error(String(error)); },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../services/Billing'), 'utf8'), context);
    return { billing: context.module.exports, calls, emails, setApproved: value => { approved = value; }, setResult: value => { result = value; } };
}

test('Shopify adapter forwards the frozen line and idempotency key and allows replay despite changed cap balance', async () => {
    const f = fixture();
    const subscription = await f.billing.prepareMerchantShopifyCharge('test.myshopify.com');
    assert.equal(subscription.id, 'line-1');
    const params = { shop: 'test.myshopify.com', amount: 720, description: 'August statement', subscriptionLineItemId: subscription.id, idempotencyKey: 'swipe-bill:merchant:2026-08' };
    assert.equal((await f.billing.chargeMerchantShopifyBill(params)).usageChargeId, 'usage-1');
    assert.equal((await f.billing.chargeMerchantShopifyBill(params)).usageChargeId, 'usage-1');
    const mutations = f.calls.filter(c => c.query.includes('mutation'));
    assert.equal(mutations.length, 2);
    assert.match(mutations[0].query, /idempotencyKey: \$idempotencyKey/);
    assert.equal(mutations[0].options.variables.idempotencyKey, params.idempotencyKey);
    assert.equal(mutations[0].options.variables.subscriptionLineItemId, 'line-1');
    assert.equal(mutations[0].options.variables.amount, 720);
});

test('Shopify adapter rejects unapproved subscriptions, provider errors and empty responses', async () => {
    const f = fixture(); f.setApproved(false);
    await assert.rejects(f.billing.prepareMerchantShopifyCharge('test.myshopify.com'), /not approved/);
    assert.equal(f.calls.length, 0);
    const params = { shop: 'test.myshopify.com', amount: 10, subscriptionLineItemId: 'line-1', idempotencyKey: 'bill-1' };
    f.setResult({ userErrors: [{ message: 'Usage limit exceeded' }], appUsageRecord: null });
    await assert.rejects(f.billing.chargeMerchantShopifyBill(params), /Usage limit exceeded/);
    f.setResult({ userErrors: [], appUsageRecord: null });
    await assert.rejects(f.billing.chargeMerchantShopifyBill(params), /did not confirm/);
});

test('new approval-link flow does not email while legacy send-billing still does', async () => {
    const f = fixture(); f.setApproved(false);
    assert.match((await f.billing.sendBillingRequest('test.myshopify.com', { sendEmail: false })).url, /approve/);
    assert.equal(f.emails.length, 0);
    await f.billing.sendBillingRequest('test.myshopify.com'); assert.equal(f.emails.length, 1);
    f.setApproved(true);
    assert.equal((await f.billing.sendBillingRequest('test.myshopify.com', { sendEmail: false })).alreadyApproved, true);
});
