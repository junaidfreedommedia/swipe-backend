const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('../utils/merchantBillingPolicy');
const { createService } = require('../services/MerchantBilling');
const ID = '0000000000000000000000ab';
const PERIOD = '2026-08';
const copy = x => x == null ? x : structuredClone(x);
const get = (obj, path) => path.split('.').reduce((v, k) => v?.[k], obj);
const set = (obj, path, value) => { const keys = path.split('.'); const last = keys.pop(); const parent = keys.reduce((v, k) => v[k] ||= {}, obj); parent[last] = copy(value); };
function matches(obj, where) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === '$or') return expected.some(w => matches(obj, w));
    const actual = get(obj, key);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, value]) => {
        if (op === '$exists') return (actual !== undefined) === value;
        if (op === '$lt') return actual < value;
        if (op === '$ne') return actual !== value;
        if (op === '$in') return value.includes(actual);
        if (op === '$nin') return !value.includes(actual);
        throw new Error(`Unsupported operator ${op}`);
      });
    }
    return expected === null ? actual == null : String(actual) === String(expected);
  });
}
function query(value) {
  return { lean: async () => copy(value), sort() { if (Array.isArray(value)) value.sort((a, b) => b.period.localeCompare(a.period)); return this; }, limit() { return this; }, then(resolve, reject) { return Promise.resolve(copy(value)).then(resolve, reject); } };
}
function model(rows) {
  function update(row, patch) {
    if (!row) return null;
    for (const [key, value] of Object.entries(patch.$set || {})) set(row, key, value);
    for (const key of Object.keys(patch.$unset || {})) delete row[key];
    for (const [key, value] of Object.entries(patch.$push || {})) row[key] = [...(row[key] || []), ...copy(value.$each)].slice(value.$slice || 0);
    return row;
  }
  return {
    findById: id => query(rows.find(r => r._id === id)),
    find: where => query(rows.filter(r => matches(r, where))),
    findOneAndUpdate: (where, patch) => query(update(rows.find(r => matches(r, where)), patch)),
    findByIdAndUpdate: (id, patch) => query(update(rows.find(r => r._id === id), patch)),
    updateOne: async (where, patch) => update(rows.find(r => matches(r, where)), patch),
    updateMany: async (where, patch) => rows.filter(r => matches(r, where)).forEach(r => update(r, patch)),
    create: async value => {
      if (rows.some(r => r._id === value._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      const row = { ...copy(value), notified: {} }; rows.push(row);
      return { ...copy(row), toObject: () => copy(row) };
    },
  };
}
function fixture(overrides = {}) {
  const settings = { ...policy.defaults(), enabled: true, first_period: PERIOD, revision: 1, ...overrides };
  const merchant = { _id: ID, name: 'Test Merchant', currency: 'USD', is_active: true, is_billing: true,
    shop_id: 'test.myshopify.com',
    billing_type: settings.provider, billing_controls: settings, billing_customer_id: 'cus_test',
    billing_payment_method: 'pm_test', billing_consent_at: new Date('2026-07-01') };
  const runs = [], statements = [], emails = [], invoices = new Map();
  const calls = { captures: 0, reports: 0, creates: 0, items: 0, charges: 0, releases: 0 };
  let clock = new Date('2026-09-21T12:00:00Z');
  let failEmail = false;
  let snapshot = { ...policy.snapshotAmount({ fees: 1000, credits: 200, commission: 10 }), merchant: ID, claims: [] };
  const stripe = {
    customers: { create: async () => ({ id: 'cus_test' }), update: async () => ({ id: 'cus_test' }) },
    invoices: {
      create: async (params, options) => { assert.equal(params.auto_advance, false); assert.equal(params.pending_invoice_items_behavior, 'exclude'); assert.equal(options.idempotencyKey, `invoice:${ID}:${PERIOD}`); calls.creates++;
        const invoice = { ...copy(params), id: 'in_test', status: 'draft', total: 0, amount_due: 0, lines: [], customer: 'cus_test', status_transitions: {}, attempted: false };
        invoices.set(invoice.id, invoice); return copy(invoice); },
      retrieve: async id => copy(invoices.get(id)),
      listLineItems: async id => ({ data: copy(invoices.get(id).lines) }),
      finalizeInvoice: async id => { const inv = invoices.get(id); inv.status = 'open'; inv.hosted_invoice_url = 'https://invoice.stripe.com/test'; return copy(inv); },
      update: async (id, patch) => { calls.releases++; Object.assign(invoices.get(id), copy(patch)); return copy(invoices.get(id)); },
      pay: async id => { calls.charges++; const inv = invoices.get(id); inv.status = 'paid'; inv.attempted = true; inv.paid = true; inv.status_transitions.paid_at = clock.getTime() / 1000; return copy(inv); },
    },
    invoiceItems: { create: async params => { calls.items++; const inv = invoices.get(params.invoice); inv.lines.push(copy(params)); inv.total += params.amount; inv.amount_due = inv.total; return { id: 'ii_test' }; } },
    setupIntents: { retrieve: async () => ({ status: 'succeeded', customer: 'cus_test', payment_method: 'pm_new', metadata: { swipe_merchant: ID } }) },
    paymentMethods: { retrieve: async () => ({ id: 'pm_new', type: 'card', customer: 'cus_test', card: { brand: 'visa', last4: '4242' } }) },
  };
  const shopifyCalls = [], usageRecords = new Map();
  const billing = {
    checkBillingStatus: async () => true,
    sendBillingRequest: async (_shop, options) => { assert.equal(options.sendEmail, false); return { url: 'https://test.myshopify.com/approve' }; },
    prepareMerchantShopifyCharge: async () => ({ id: 'gid://shopify/AppSubscriptionLineItem/1' }),
    chargeMerchantShopifyBill: async params => {
      shopifyCalls.push(copy(params));
      if (!usageRecords.has(params.idempotencyKey)) usageRecords.set(params.idempotencyKey, { usageChargeId: 'gid://shopify/AppUsageRecord/1' });
      return usageRecords.get(params.idempotencyKey);
    },
  };
  const service = createService({ models: { Merchant: model([merchant]), MerchantBillingRun: model(runs), Statement: model(statements) }, stripe,
    services: { Billing: billing, ShopifySession: { get: async () => ({ shop: merchant.shop_id }) }, Statement: { CreatePdf: async options => { if (options.captureOnly) { calls.captures++; return { billingSnapshots: [copy(snapshot)] }; } calls.reports++; return { merchantsProcessed: 1 }; } } },
    sendEmail: async (...args) => { if (failEmail) { failEmail = false; throw new Error('mail unavailable'); } emails.push(args); }, now: () => new Date(clock),
  });
  const bill = async () => { const p = await service.preview(ID, PERIOD); return service.bill(ID, PERIOD, p, 'admin'); };
  return { service, merchant, runs, statements, emails, invoices, stripe, calls, bill, billing, shopifyCalls, usageRecords,
    setClock: v => { clock = new Date(v); }, setAmount: v => { snapshot.amount_cents = v; }, failNextEmail: () => { failEmail = true; } };
}

test('preview is read-only and uses the PDF calculation', async () => {
  const f = fixture(); const p = await f.service.preview(ID, PERIOD);
  assert.equal(p.snapshot.amount_cents, 72000); assert.equal(f.runs.length, 0);
  assert.equal(f.calls.creates, 0); assert.equal(f.calls.reports, 0); assert.equal(f.emails.length, 0);
});
test('save settings never creates invoices or charges and rejects stale revisions', async () => {
  const f = fixture({ email: 'billing@example.com' });
  await f.service.save(ID, { ...f.merchant.billing_controls, provider: 'stripe' }, 'admin');
  assert.equal(f.calls.creates, 0); assert.equal(f.calls.charges, 0); assert.equal(f.merchant.billing_type, 'stripe');
  await assert.rejects(f.service.save(ID, { ...f.merchant.billing_controls, revision: 1 }, 'admin'), /Reload/);
});
test('manual bill requires matching received amount and cannot be recorded twice', async () => {
  const f = fixture(); const r = await f.bill(); assert.equal(r.status, 'awaiting_manual'); assert.equal(f.calls.charges, 0);
  await assert.rejects(f.service.recordPayment(ID, PERIOD, { reference: 'bank-1', amount_cents: 10 }, 'admin'), /match/);
  await f.service.recordPayment(ID, PERIOD, { reference: 'bank-1', amount_cents: 72000 }, 'admin');
  assert.equal(f.runs[0].status, 'paid');
  await assert.rejects(f.service.recordPayment(ID, PERIOD, { reference: 'bank-1', amount_cents: 72000 }, 'admin'), /outstanding/);
  assert.equal(f.emails.length, 2);
});
test('Stripe email invoice releases one invoice without charging a card', async () => {
  const f = fixture({ provider: 'stripe', collection: 'send_invoice' });
  const r = await f.bill(); await f.bill();
  assert.equal(r.status, 'awaiting_payment'); assert.equal(f.calls.creates, 1); assert.equal(f.calls.items, 1); assert.equal(f.calls.charges, 0); assert.equal(f.emails.length, 1);
});
test('auto-charge requires actual card authorization, not just a checkbox', async () => {
  const f = fixture({ provider: 'stripe', collection: 'charge_automatically' });
  delete f.merchant.billing_consent_at;
  await assert.rejects(f.bill(), /authorize/); assert.equal(f.calls.charges, 0); assert.equal(f.calls.creates, 0);
});
test('auto-charge happens once and replayed billing cannot debit a paid invoice', async () => {
  const f = fixture({ provider: 'stripe', collection: 'charge_automatically' });
  assert.equal((await f.bill()).status, 'paid'); await f.bill();
  assert.equal(f.calls.charges, 1); assert.equal(f.calls.creates, 1); assert.equal(f.emails.length, 2);
  assert.equal(f.emails[0][1], 'Your Swipe statement is ready');
  assert.equal(f.emails[1][1], 'Swipe payment received');
});
test('Stripe-managed retries use auto_advance without a second competing pay call', async () => {
  const f = fixture({ provider: 'stripe', collection: 'charge_automatically', stripe_retries: true });
  await f.bill(); assert.equal(f.calls.charges, 0); assert.equal(f.invoices.get('in_test').auto_advance, true);
});

test('an explicit test reset uses fresh Stripe keys and retains them on retries', async () => {
  const f = fixture({ provider: 'stripe', collection: 'charge_automatically' });
  const paid = await f.bill();
  const resetId = 'reset-june-test';
  f.runs.splice(0, 1, { _id: paid._id, merchant: ID, period: PERIOD, provider: 'stripe',
    settings: paid.settings, snapshot: paid.snapshot, status: 'prepared', notified: {},
    stripe_test_reset_id: resetId });
  const seen = [];
  for (const [object, method, operation] of [
    [f.stripe.invoices, 'create', 'invoice'], [f.stripe.invoiceItems, 'create', 'line'],
    [f.stripe.invoices, 'finalizeInvoice', 'finalize'], [f.stripe.invoices, 'pay', 'pay'],
  ]) {
    const original = object[method];
    object[method] = async (...args) => {
      const options = args.at(-1);
      assert.equal(options.idempotencyKey, `${operation}:${paid._id}:test-reset:${resetId}`);
      seen.push(operation);
      if (operation === 'line' && seen.filter(x => x === 'line').length === 1) throw new Error('temporary line failure');
      // The existing invoice fixture asserts the original key for ordinary runs.
      if (operation === 'invoice') args[args.length - 1] = { idempotencyKey: `invoice:${paid._id}` };
      return original(...args);
    };
  }
  await assert.rejects(f.bill(), /temporary line failure/);
  assert.equal((await f.bill()).status, 'paid');
  await f.bill();
  assert.deepEqual(seen, ['invoice', 'line', 'line', 'finalize', 'pay']);
  assert.equal(f.calls.creates, 2);
  assert.equal(f.calls.charges, 2);
});
test('changing an amount after preview invalidates confirmation', async () => {
  const f = fixture(); const preview = await f.service.preview(ID, PERIOD); f.setAmount(73000);
  await assert.rejects(f.service.bill(ID, PERIOD, preview, 'admin'), /Preview/); assert.equal(f.runs.length, 0);
});
test('frozen bill keeps its approved amount when report inputs change', async () => {
  const f = fixture(); await f.bill(); f.setAmount(999999);
  const p = await f.service.preview(ID, PERIOD); assert.equal(p.snapshot.amount_cents, 72000);
});
test('previous Shopify charges and ambiguous failures block a second provider charge', async () => {
  for (const field of [{ shopify_usage_charge_id: 'gid://123' }, { shopify_charge_status: 'failed' }, { payment_link: 'https://old' }]) {
    const f = fixture({ provider: 'stripe' }); f.statements.push({ _id: 'old', merchant: ID, statement_month: PERIOD, ...field });
    await assert.rejects(f.bill(), /previous billing/); assert.equal(f.calls.creates, 0);
  }
});
test('paused billing cannot be bypassed by calling the endpoint directly', async () => {
  const f = fixture({ enabled: false }); await assert.rejects(f.bill(), /paused/); assert.equal(f.calls.creates, 0);
});
test('monthly review limit prevents collection until an admin confirms the preview', async () => {
  const f = fixture({ provider: 'stripe', trigger: 'monthly', review_limit: 500 });
  await f.service.bill(ID, PERIOD, {}, 'scheduler', true);
  assert.equal(f.runs[0].status, 'needs_review'); assert.equal(f.calls.creates, 0);
  await f.bill(); assert.equal(f.calls.creates, 1);
});
test('zero and negative statements never contact Stripe', async () => {
  for (const amount of [0, -200]) { const f = fixture({ provider: 'stripe' }); f.setAmount(amount); assert.equal((await f.bill()).status, 'skipped'); assert.equal(f.calls.creates, 0); }
});
test('duplicate concurrent submissions are serialized', async () => {
  const f = fixture({ provider: 'stripe' }); const p = await f.service.preview(ID, PERIOD);
  const results = await Promise.allSettled([f.service.bill(ID, PERIOD, p, 'admin'), f.service.bill(ID, PERIOD, p, 'admin')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.creates, 1); assert.equal(f.runs.length, 1);
});
test('out-of-order failed webhook retrieves authoritative paid status', async () => {
  const f = fixture({ provider: 'stripe', collection: 'charge_automatically' }); await f.bill();
  await f.service.webhook({ type: 'invoice.payment_failed', data: { object: { id: 'in_test', status: 'open', metadata: { purpose: 'merchant_billing', swipe_billing_run: `${ID}:${PERIOD}` } } } });
  assert.equal(f.runs[0].status, 'paid'); assert.equal(f.emails.length, 2);
});
test('unrelated customer-payment webhooks are ignored', async () => {
  const f = fixture(); await f.service.webhook({ type: 'checkout.session.completed', data: { object: { metadata: { purpose: 'exchange' } } } }); assert.equal(f.calls.creates, 0);
});
test('card webhook rejects a different customer and accepts a verified SetupIntent', async () => {
  const f = fixture({ provider: 'stripe' });
  const obj = { id: 'cs_setup', customer: 'wrong', setup_intent: 'seti_1', metadata: { purpose: 'merchant_billing_setup', swipe_merchant: ID } };
  await assert.rejects(f.service.webhook({ type: 'checkout.session.completed', created: 1800000000, data: { object: obj } }), /mismatch/);
  obj.customer = 'cus_test'; await f.service.webhook({ type: 'checkout.session.completed', created: 1800000000, data: { object: obj } });
  assert.equal(f.merchant.billing_payment_method, 'pm_new');
});
test('pausing stops Stripe advancement on open invoices', async () => {
  const f = fixture({ provider: 'stripe', collection: 'charge_automatically', stripe_retries: true, email: 'bill@example.com' }); await f.bill();
  await f.service.save(ID, { ...f.merchant.billing_controls, enabled: false }, 'admin');
  assert.equal(f.invoices.get('in_test').auto_advance, false); assert.equal(f.runs[0].collection_paused, true);
});
test('unknown invoice creation older than the idempotency retention is blocked', async () => {
  const f = fixture({ provider: 'stripe' });
  f.stripe.invoices.create = async () => { throw new Error('network timeout'); };
  await assert.rejects(f.bill(), /network timeout/);
  f.setClock('2026-09-23T12:00:00Z');
  await assert.rejects(f.bill(), /reconciliation/); assert.equal(f.calls.charges, 0);
});
test('an unexpected Stripe invoice amount is not finalized or paid', async () => {
  const f = fixture({ provider: 'stripe', collection: 'charge_automatically' });
  const original = f.stripe.invoiceItems.create;
  f.stripe.invoiceItems.create = async params => { await original(params); f.invoices.get('in_test').amount_due += 1; };
  await assert.rejects(f.bill(), /differs/); assert.equal(f.calls.charges, 0); assert.equal(f.invoices.get('in_test').status, 'draft');
});
test('invoice email failures do not create another invoice on retry', async () => {
  const f = fixture({ provider: 'stripe' }); f.failNextEmail(); await assert.rejects(f.bill(), /mail unavailable/);
  await f.bill();
  assert.equal(f.calls.creates, 1); assert.equal(f.emails.length, 1);
});
test('schedule follows merchant timezone, catches up within the month, and honors cutover', () => {
  const s = { ...policy.defaults(), enabled: true, trigger: 'monthly', first_period: '2026-08', timezone: 'Asia/Karachi' };
  assert.equal(policy.duePeriod(s, new Date('2026-09-05T03:59:00Z')), null);
  assert.equal(policy.duePeriod(s, new Date('2026-09-05T04:00:00Z')), '2026-08');
  assert.equal(policy.duePeriod(s, new Date('2026-09-25T04:00:00Z')), '2026-08');
  assert.equal(policy.duePeriod({ ...s, first_period: '2026-09' }, new Date('2026-09-25')), null);
});
test('validation rejects future/open months, non-USD and invalid controls', () => {
  const s = { ...policy.defaults(), first_period: '2026-08', email: 'billing@example.com' };
  assert.throws(() => policy.validatePeriod('2026-09', s, new Date('2026-09-21')), /completed/);
  assert.throws(() => policy.validateSettings({ ...s, enabled: 'true' }, {}), /boolean/);
  assert.throws(() => policy.validateSettings({ ...s, billing_day: 31 }, {}), /billing_day/);
  assert.throws(() => policy.validateSettings(s, { currency: 'EUR' }), /USD/);
  assert.throws(() => policy.snapshotAmount({ fees: NaN, credits: 0, commission: 10 }), /Invalid/);
});
test('every new billing route requires authentication and Super Admin permission', () => {
  const check = () => {}; const superAdmin = () => {}; const middleware = [];
  const fakeRouter = { use: (...args) => middleware.push(...args), get() {}, post() {}, put() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../controllers/admin/merchantBilling'), 'utf8'), {
    require: () => ({ Router: () => fakeRouter }), Auth: { check, requireSuperAdmin: superAdmin }, module: { exports: {} },
  });
  assert.deepEqual(middleware, [check, superAdmin]);
});

test('uppercase ObjectId paths cannot create a second bill for the same merchant', async () => {
  const f = fixture({ provider: 'stripe' }); await f.bill();
  const preview = await f.service.preview(ID.toUpperCase(), PERIOD);
  await f.service.bill(ID.toUpperCase(), PERIOD, preview, 'admin');
  assert.equal(f.runs.length, 1); assert.equal(f.calls.creates, 1);
});
test('a timeout during finalization resumes the same invoice without duplicating its line', async () => {
  const f = fixture({ provider: 'stripe' }); const finalize = f.stripe.invoices.finalizeInvoice;
  let first = true;
  f.stripe.invoices.finalizeInvoice = async (...args) => { const result = await finalize(...args); if (first) { first = false; throw new Error('timeout'); } return result; };
  await assert.rejects(f.bill(), /timeout/); await f.bill();
  assert.equal(f.calls.creates, 1); assert.equal(f.calls.items, 1);
});
test('signed raw webhooks are accepted; altered payloads rejected; service failures retry', async () => {
  const stripe = require('stripe')('sk_test_offline_only');
  const handler = require('../utils/merchantBillingWebhook');
  const secret = 'whsec_offline_test';
  const payload = JSON.stringify({ id: 'evt_test', type: 'invoice.paid', data: { object: {} } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  let calls = 0, fail = false;
  const endpoint = handler({ stripe, secret, service: { webhook: async () => { calls++; if (fail) throw new Error('offline database'); } }, logger: { error() {} } });
  async function send(body) {
    let status = 200, result;
    const res = { status(code) { status = code; return this; }, send(value) { result = value; return this; } };
    await endpoint({ body: Buffer.from(body), headers: { 'stripe-signature': signature } }, res);
    return { status, result };
  }
  assert.equal((await send(payload)).status, 200); assert.equal(calls, 1);
  assert.equal((await send(payload + ' ')).status, 400); assert.equal(calls, 1);
  fail = true; assert.equal((await send(payload)).status, 503);
});

test('monthly scheduler bills an eligible period once and ignores manual-trigger merchants', async () => {
  const manual = fixture({ provider: 'stripe' }); await manual.service.runScheduled(); assert.equal(manual.runs.length, 0);
  const monthly = fixture({ provider: 'stripe', trigger: 'monthly' });
  await monthly.service.runScheduled(); await monthly.service.runScheduled();
  assert.equal(monthly.runs.length, 1); assert.equal(monthly.calls.creates, 1);
});
test('resume does not auto-finalize an incomplete draft with an unverified amount', async () => {
  const f = fixture({ provider: 'stripe', collection: 'charge_automatically' });
  f.stripe.invoiceItems.create = async () => { throw new Error('temporary line failure'); };
  await assert.rejects(f.bill(), /line failure/);
  await assert.rejects(f.service.resume(ID, PERIOD, 'admin'), /complete the draft/);
  assert.equal(f.invoices.get('in_test').auto_advance, false); assert.equal(f.calls.charges, 0);
});

test('Shopify settings and approval link never create a charge or send email', async () => {
  const f = fixture({ email: 'bill@example.com' });
  await assert.rejects(f.service.shopifyApproval(ID, 'admin'), /Save Shopify/);
  await f.service.save(ID, { ...f.merchant.billing_controls, provider: 'shopify' }, 'admin');
  assert.equal(f.merchant.billing_type, 'shopify');
  assert.equal((await f.service.shopifyStatus(ID)).approved, true);
  assert.match((await f.service.shopifyApproval(ID, 'admin')).url, /approve/);
  assert.equal(f.shopifyCalls.length, 0); assert.equal(f.calls.creates, 0); assert.equal(f.emails.length, 0);
  delete f.merchant.shop_id;
  await assert.rejects(f.service.save(ID, f.merchant.billing_controls, 'admin'), /Connect/);
});

test('Shopify submits the final net amount once and never claims payment was received', async () => {
  const f = fixture({ provider: 'shopify' });
  const run = await f.bill(); await f.bill(); await f.service.refresh(ID, PERIOD);
  assert.equal(run.status, 'submitted_to_shopify'); assert.equal(run.paid_at, undefined);
  assert.equal(f.shopifyCalls.length, 1); assert.equal(f.shopifyCalls[0].amount, 720);
  assert.equal(f.shopifyCalls[0].idempotencyKey, `swipe-bill:${ID}:${PERIOD}`);
  assert.equal(f.calls.creates, 0); assert.equal(f.calls.charges, 0);
  assert.equal(f.emails.length, 1); assert.match(f.emails[0][2], /submitted to Shopify/);
});

test('Shopify approval is required and a declined request stays retryable', async () => {
  const f = fixture({ provider: 'shopify' });
  f.billing.prepareMerchantShopifyCharge = async () => { throw new Error('Shopify billing is not approved'); };
  await assert.rejects(f.bill(), /not approved/);
  assert.equal(f.shopifyCalls.length, 0); assert.equal(f.runs[0].status, 'prepared');
  f.billing.prepareMerchantShopifyCharge = async () => ({ id: 'line-1' });
  const submit = f.billing.chargeMerchantShopifyBill;
  f.billing.chargeMerchantShopifyBill = async () => { throw new Error('Usage limit exceeded'); };
  await assert.rejects(f.bill(), /Usage limit/);
  assert.equal(f.runs[0].status, 'prepared'); assert.match(f.runs[0].last_error, /Usage limit/);
  f.billing.chargeMerchantShopifyBill = submit;
  assert.equal((await f.bill()).status, 'submitted_to_shopify');
});

test('Shopify timeout retries preserve the amount, line item and idempotency key', async () => {
  const f = fixture({ provider: 'shopify' }); const submit = f.billing.chargeMerchantShopifyBill;
  let first = true;
  f.billing.chargeMerchantShopifyBill = async params => {
    const result = await submit(params);
    if (first) { first = false; throw new Error('network timeout after acceptance'); }
    return result;
  };
  await assert.rejects(f.bill(), /timeout/);
  f.setAmount(99999);
  f.billing.prepareMerchantShopifyCharge = async () => { throw new Error('Must retain original subscription'); };
  assert.equal((await f.bill()).status, 'submitted_to_shopify');
  assert.deepEqual(f.shopifyCalls[0], f.shopifyCalls[1]); assert.equal(f.usageRecords.size, 1);
});

test('Shopify monthly scheduling, review limits, pause and non-positive amounts are respected', async () => {
  const f = fixture({ provider: 'shopify', trigger: 'monthly', review_limit: 500 });
  await f.service.runScheduled(); assert.equal(f.runs[0].status, 'needs_review'); assert.equal(f.shopifyCalls.length, 0);
  await f.bill(); await f.service.runScheduled(); assert.equal(f.shopifyCalls.length, 1);
  const paused = fixture({ provider: 'shopify', enabled: false });
  await assert.rejects(paused.bill(), /paused/); assert.equal(paused.shopifyCalls.length, 0);
  for (const amount of [0, -100]) {
    const empty = fixture({ provider: 'shopify' }); empty.setAmount(amount);
    assert.equal((await empty.bill()).status, 'skipped'); assert.equal(empty.shopifyCalls.length, 0);
  }
});

test('Shopify email failure retries never submit another charge or send a payment receipt', async () => {
  const f = fixture({ provider: 'shopify' }); f.failNextEmail();
  await assert.rejects(f.bill(), /mail unavailable/); await f.bill();
  assert.equal(f.shopifyCalls.length, 1); assert.equal(f.emails.length, 1);
  assert.equal(f.runs[0].notified.receipt, undefined); assert.equal(f.runs[0].last_error, '');
});

test('Shopify refresh repairs statement history from the accepted charge without resubmitting it', async () => {
  const f = fixture({ provider: 'shopify' }); await f.bill();
  f.statements.push({ merchant: ID, statement_month: PERIOD, billing_status: 'prepared' });
  await f.service.refresh(ID, PERIOD);
  assert.equal(f.statements[0].billing_status, 'submitted_to_shopify');
  assert.equal(f.statements[0].shopify_usage_charge_id, f.runs[0].shopify_usage_charge_id);
  assert.equal(f.statements[0].billing_amount_cents, 72000); assert.equal(f.shopifyCalls.length, 1);
});

test('unresolved bills block switching providers but submitted Shopify bills stay frozen', async () => {
  const f = fixture({ provider: 'shopify', email: 'bill@example.com' });
  f.billing.prepareMerchantShopifyCharge = async () => { throw new Error('approval needed'); };
  await assert.rejects(f.bill(), /approval/);
  await assert.rejects(f.service.save(ID, { ...f.merchant.billing_controls, provider: 'stripe' }, 'admin'), /Resolve existing/);
  f.billing.prepareMerchantShopifyCharge = async () => ({ id: 'line-1' }); await f.bill();
  await f.service.save(ID, { ...f.merchant.billing_controls, provider: 'stripe' }, 'admin'); await f.bill();
  assert.equal(f.shopifyCalls.length, 1); assert.equal(f.calls.creates, 0);
  assert.equal(f.runs[0].provider, 'shopify');
});
