const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const moment = require('moment-timezone');
const policy = require('../utils/merchantBillingPolicy');

function load(configured = false, frozen = null) {
  const merchant = { _id: '000000000000000000000001', name: 'Test', shop_id: 'test', billing_type: 'shopify', competition: 10,
    ...(configured ? { billing_controls: { version: 1 } } : {}) };
  const counts = { inserted: 0, updated: 0, charges: 0, pdfs: 0 };
  let rendered;
  const services = { UsageRecord: { aggregate: async () => [{ merchantData: merchant, credit: [{ claim: { _id: '000000000000000000000099' }, amount: 200, credit_type: 'refund' }] }] },
    Claim: { get: async () => ({ createdAt: new Date(), order_name: '#1', combined_refund_total: 200 }) },
    Billing: { chargeStatementOnShopify: async args => { counts.charges++; assert.equal(args.amount, 720); } },
  };
  const context = { module: { exports: {} }, require: name => { assert.equal(name, '../utils/merchantBillingPolicy'); return policy; },
    Models: { Statement: {}, MerchantBillingRun: { findById: () => ({ lean: async () => frozen }) } },
    Services: services, Moment: moment, ObjectIds: x => x, console,
    Logger: { error() {} }, Func: { createStatementPdf: async m => { counts.pdfs++; rendered = structuredClone(m); } },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../services/Statement'), 'utf8'), context);
  const service = context.module.exports; services.Statement = service;
  service.get = async () => null;
  service.insert = async () => { counts.inserted++; return { _id: 'statement', createdAt: new Date() }; };
  service.findOneAndUpdate = async () => { counts.updated++; };
  service.getUsageSummary = async () => ({ fees_collected: 1000, usages: [], credits: [] });
  service.getDailyReportSummary = async () => ({ report_days: 0, total_orders: 0, net_items_sold: 0 });
  return { service, counts, rendered: () => rendered };
}
test('real statement capture path is read-only and uses the same claim rows/commission as the PDF', async () => {
  const f = load(true); const result = await f.service.CreatePdf({ merchantIds: ['000000000000000000000001'], month: 8, year: 2026, captureOnly: true });
  assert.equal(result.billingSnapshots[0].amount_cents, 72000);
  assert.equal(result.billingSnapshots[0].claims.length, 1);
  assert.deepEqual(f.counts, { inserted: 0, updated: 0, charges: 0, pdfs: 0 });
});
test('existing non-migrated Shopify statements preserve their existing charge/PDF flow', async () => {
  const f = load(); await f.service.CreatePdf({ month: 8, year: 2026 });
  assert.equal(f.counts.charges, 1); assert.equal(f.counts.pdfs, 1);
});
test('migrated merchants can generate a report without creating any Shopify charge', async () => {
  const f = load(true); await f.service.CreatePdf({ month: 8, year: 2026 });
  assert.equal(f.counts.charges, 0); assert.equal(f.counts.pdfs, 1);
});
test('regenerated reports retain the billed snapshot even if source totals have changed', async () => {
  const f = load(true, { _id: 'run', status: 'paid', provider: 'stripe', snapshot: {
    fees: 500, credits: 100, commission: 5, amount_cents: 38000,
    claims: [{ raw_type: 'Refund', raw_amount: 100 }],
  } });
  await f.service.CreatePdf({ month: 8, year: 2026 });
  assert.equal(f.rendered().fees_collected, 500); assert.equal(f.rendered().competition, 5);
  assert.equal(f.rendered().total_billed_amount, '400.00'); assert.equal(f.counts.charges, 0);
});

test('legacy entry points recheck the current provider before any Shopify call', async () => {
  const current = { _id: 'merchant', billing_type: 'manual', billing_controls: { version: 1 } };
  const context = { module: { exports: {} }, console,
    Config: { get: () => ({ plan: { usageTerms: 'fees' } }) },
    require: () => ({ GraphqlQueryError: class extends Error {} }),
    Services: { Merchant: { get: async () => current },
      MerchantBilling: { withLock: async (_id, work) => work(current) },
      ShopifySession: { get: () => { throw new Error('Must not call Shopify'); } } },
    throwError: error => { throw error instanceof Error ? error : new Error(error); },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../services/Billing'), 'utf8'), context);
  const billing = context.module.exports;
  assert.equal((await billing.chargeStatementOnShopify({ shop: 'test', amount: 1 })).reason, 'billing_provider_changed');
  const result = await billing.createUsageRecord({ shop: 'test', merchant: 'merchant', amount: 1, billing_type: 'shopify', persist_ledger: false });
  assert.equal(result.createdRecord, true);
});
