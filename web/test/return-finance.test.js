const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { createRequire } = require("node:module");
const { eventsFromDetails, buildReport, resolvedSnapshot, confirmedRefundAmount } = require("../utils/returnFinance");
const { renderHtml } = require("../utils/returnFinancePdf");
const base = { _id: "r1", shop: "shop", return_number: "1001", status: "exchanged", customer: { email: "buyer@example.com" } };
const date = "2026-09-12T10:00:00Z";
const details = {
  refund_details: { shopify_refund_id: "rf1", amount: 20.15, currency: "USD", processed_at: date, items: [{ line_item_id: "a" }] },
  reorder_details: { id: "ex1", replacement_total: 50, currency: "USD", processed_at: date, payment_status: "paid", amount_due: 10,
    stripe_checkout_session_id: "cs1", stripe_paid_at: date, items: [{ line_item_id: "b" }] },
  credit_refund_details: { status: "refunded", shopify_refund_id: "rf2", amount: 3.25, currency: "USD", processed_at: date },
  easypost: { shipment_id: "sh1", postage_amount: 5.3, currency: "USD", purchased_at: date },
};

test("one row per completed return keeps returned item value separate from cash amounts", () => {
  const record = { ...base, ...details, subtotal: { amount: 80, currency: "USD" }, createdAt: "2026-08-01", finance_events: eventsFromDetails(details) };
  const report = buildReport([record, record], "2026-09", "Store");
  assert.equal(report.rows.length, 1);
  assert.deepEqual(report.totals.USD, { total_value: 80, refund: 23.4, stripe_charge: 10 });
  assert.equal(report.rows[0].type, "Exchange");
  assert.equal(report.rows[0].created_at, "2026-08-01");
  assert.equal(report.version, 4);
});
test("month follows final completion and includes earlier payments exactly once", () => {
  const record = { ...base, ...details, timeline: [{ status: "exchanged", created_at: "2026-10-01T00:00:00Z" }] };
  assert.equal(buildReport([record], "2026-09", "Store").rows.length, 0);
  const row = buildReport([record], "2026-10", "Store").rows[0];
  assert.equal(row.stripe_charge, 10); assert.equal(row.refund, 23.4);
});
test("unfinished requests never enter reports even with paid financial events", () => {
  for (const status of ["requested", "approved", "received", "processed", "payment_pending", "declined", "closed"]) {
    assert.equal(buildReport([{ ...base, ...details, status }], "2026-09", "Store").rows.length, 0);
  }
});
test("equal-value exchanges are included with zero Stripe charge", () => {
  const record = { ...base, subtotal: { amount: 35, currency: "USD" }, reorder_details: { id: "ex", processed_at: date, replacement_total: 35, amount_due: 0 } };
  const row = buildReport([record], "2026-09", "Store").rows[0];
  assert.equal(row.total_value, 35); assert.equal(row.stripe_charge, 0); assert.equal(row.refund, 0);
});
test("refunds use settled amounts and unknown historical amounts remain unknown", () => {
  assert.equal(confirmedRefundAmount([{ status: "success", amount: "10.50" }]), 10.5);
  assert.equal(confirmedRefundAmount([{ status: "pending", amount: "10.50" }]), null);
  const record = { ...base, status: "refunded", refund_details: { ...details.refund_details, amount: undefined }, refund_total: { amount: 100 },
    items: [{ line_item_id: "a", unit_price: 12, quantity: 2, resolution: "refund", resolved_at: date }] };
  const row = buildReport([record], "2026-09", "Store").rows[0];
  assert.equal(row.refund, null); assert.equal(row.total_value, 24); assert.equal(row.stripe_charge, 0); assert.equal(row.type, "Refund");
});
test("mixed resolutions retain all refund transactions and one total item value", () => {
  const record = { ...base, ...details, order: { name: "#1001" }, subtotal: { amount: 60, currency: "USD" },
    items: [{ line_item_id: "a", resolution: "refund" }, { line_item_id: "b", resolution: "reorder" }],
    finance_events: eventsFromDetails({ refund_details: { ...details.refund_details, shopify_refund_id: "older", amount: 4 } }) };
  const row = buildReport([record], "2026-09", "Store").rows[0];
  assert.equal(row.type, "Exchange & Refund"); assert.equal(row.refund, 27.4); assert.equal(row.total_value, 60); assert.equal(row.return_number, "#1001");
});
test("currency totals remain separate and old transaction snapshots require regeneration", () => {
  const usd = { ...base, ...details, subtotal: { amount: 80, currency: "USD" } };
  const eur = { ...base, _id: "r2", status: "refunded", subtotal: { amount: 20, currency: "EUR" }, refund_details: { ...details.refund_details, currency: "EUR" } };
  const report = buildReport([usd, eur], "2026-09", "Store");
  assert.equal(report.totals.USD.stripe_charge, 10); assert.equal(report.totals.EUR.stripe_charge, 0);
  assert.deepEqual(resolvedSnapshot(report), report);
  assert.throws(() => resolvedSnapshot({ version: 3, rows: [] }), /Generate this report again/);
});
test("PDF has seven requested columns and no provider IDs, shipping rows or technical notes", () => {
  const report = buildReport([{ ...base, ...details, subtotal: { amount: 80, currency: "USD" } }], "2026-09", "<script>Store</script>");
  const html = renderHtml(report);
  for (const label of ["Created date", "Completed (UTC)", "Order number", "Type", "Total item value", "Refund", "Charged by Stripe"]) assert.ok(html.includes(label));
  for (const text of ["Shipping label cost", "Exchange value", "excluded from totals", "cs1", "rf1", "<script>"]) assert.ok(!html.includes(text));
  assert.match(html, /USD 80.00/); assert.match(html, /USD 23.40/); assert.match(html, /USD 10.00/);
  assert.throws(() => buildReport([], "2026-13", "Store"), /valid month/);
});
test("generation reads full returned item values and original order names without billing", async () => {
  const filename = path.resolve(__dirname, "../services/ReturnFinance.js");
  let filter, selected, saved, populated;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, require: createRequire(filename), Buffer,
    Models: { Return: { find(query) { filter = query; return { select(value) { selected = value; return this; }, populate(value) { populated = value; return this; }, lean: async () => [{ ...base, ...details, subtotal: { amount: 80, currency: "USD" } }] }; } },
      ReturnFinanceReport: { findOneAndUpdate: async (query, update) => { saved = query; return update.$set; } } },
    Services: new Proxy({}, { get() { throw new Error("No billing calls allowed"); } }),
  }, { filename });
  const report = await module.exports.generate({ _id: "merchant-1", name: "Store" }, "2026-09");
  assert.equal(saved.merchant, "merchant-1"); assert.equal(populated, "order"); assert.ok(selected.includes("subtotal "));
  assert.deepEqual(Array.from(filter.status.$in), ["exchanged", "refunded"]);
  assert.equal(report.snapshot.rows[0].total_value, 80);
});
test("status changes save financial events atomically without changing rejection behavior", async () => {
  const filename = path.resolve(__dirname, "../services/Return.js");
  const module = { exports: {} }; let update;
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, require: createRequire(filename),
    Models: { Return: { findOneAndUpdate: async (_, value) => { update = value; } } },
  }, { filename });
  await module.exports.updateStatus("r1", "refunded", { set: { refund_details: details.refund_details } });
  assert.equal(update.$addToSet.finance_events.$each[0].amount, 20.15);
  assert.equal(update.$set.status, "refunded"); assert.ok(update.$push.timeline);
  await module.exports.updateStatus("r1", "declined", { detail: "Not eligible" });
  assert.equal(update.$addToSet, undefined); assert.equal(update.$set.status, "declined");
});
test("a received Stripe payment is recorded even if replacement creation fails and retries preserve its date", async () => {
  const filename = path.resolve(__dirname, "../services/ReturnExchangePayment.js"), local = createRequire(filename);
  const module = { exports: {} }; let captured;
  const record = { ...base, status: "payment_pending", reorder_details: { ...details.reorder_details, id: undefined,
    processed_at: undefined, payment_status: "payment_received", stripe_paid_at: new Date(date) } };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, require: (name) => name === "../shopify.js" ? {} : local(name),
    Models: { Return: { findOneAndUpdate: async (_, update) => { captured = update; return record; }, updateOne: async () => {} } },
    Services: { ShopifySession: { get: async () => { throw new Error("Store temporarily unavailable"); } } },
  }, { filename });
  await assert.rejects(module.exports.finalizePaidReplacement(record, { id: "cs1", currency: "usd", amount_total: 1000 }), /temporarily unavailable/);
  const event = captured.$addToSet.finance_events.$each[0];
  assert.equal(event.key, "payment:cs1"); assert.equal(event.amount, 10);
  assert.equal(captured.$set["reorder_details.stripe_amount_paid"], 10);
  assert.equal(event.date.toISOString(), new Date(date).toISOString());
  assert.equal(captured.$set["reorder_details.stripe_paid_at"].toISOString(), new Date(date).toISOString());
});

