const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOrderPriceSummary } = require("./orderPriceSummary");

test("matches Shopify's partially-refunded order summary", () => {
  const summary = buildOrderPriceSummary({
    financial_status: "partially_refunded",
    order_created_at: "2026-08-21T09:36:00.000Z",
    total_price: "246.46",
    total_price_set: { shop_money: { amount: "246.46" } },
    current_total_price: "165.57",
    current_subtotal_price: "165.57",
    current_total_discounts: "41.97",
    current_total_tax: "0.00",
    discount_codes: [{ code: "HOLIDAYSALE", amount: "41.97" }],
    line_items: [
      { id: 1, title: "Item 1", quantity: 2 },
      { id: 2, title: "Item 2", quantity: 3 },
      { id: 3, title: "Refunded 1", quantity: 0, refunded: true },
      { id: 4, title: "Refunded 2", quantity: 0, refunded: true },
    ],
    refunds: [
      {
        refund_line_items: [
          { quantity: 1, subtotal: "54.99", total_tax: "0.00" },
          { quantity: 1, subtotal: "25.90", total_tax: "0.00" },
        ],
        transactions: [
          { kind: "refund", status: "success", amount: "80.89" },
        ],
      },
    ],
  });

  assert.deepEqual(summary, {
    status: "partially_refunded",
    original_order_date: "2026-08-21T09:36:00.000Z",
    original_order_amount: 246.46,
    subtotal_amount: 165.57,
    item_count: 5,
    discount_label: "HOLIDAYSALE",
    discount_amount: 41.97,
    shipping_amount: 0,
    tax_amount: 0,
    total_amount: 165.57,
    paid_amount: 246.46,
    refunded_amount: 80.89,
    refunded_item_count: 2,
    refund_reason: "No reason provided",
    net_payment: 165.57,
  });
});

test("does not subtract a refund twice when Shopify current total exists", () => {
  const summary = buildOrderPriceSummary({
    total_price: "100.00",
    current_total_price: "60.00",
    refunds: [
      {
        transactions: [
          { kind: "refund", status: "success", amount: "40.00" },
        ],
      },
    ],
  });

  assert.equal(summary.total_amount, 60);
  assert.equal(summary.net_payment, 60);
});

test("uses Shopify's net refund after a second order edit adds value back", () => {
  const summary = buildOrderPriceSummary({
    financial_status: "partially_refunded",
    created_at: "2026-08-22T06:00:00.000Z",
    // Legacy REST total_price changes after edits, while Shopify Admin uses
    // immutable GraphQL originalTotalPriceSet for the Original order row.
    total_price: "198.33",
    total_price_set: { shop_money: { amount: "198.33" } },
    shopify_price_summary: {
      status: "partially_refunded",
      created_at: "2026-08-22T06:00:00.000Z",
      original_order_amount: "165.57",
      paid_amount: "198.33",
      subtotal_amount: "133.26",
      discount_amount: "14.99",
      shipping_amount: "0.00",
      tax_amount: "0.00",
      total_amount: "133.26",
      item_count: 4,
    },
    current_total_price: "133.26",
    current_subtotal_price: "133.26",
    current_total_discounts: "14.99",
    discount_codes: [{ code: "HOLIDAYSALE", amount: "14.99" }],
    transactions: [
      { kind: "capture", status: "success", amount: "198.33" },
    ],
    line_items: [
      { id: 1, title: "Current 1", quantity: 1 },
      { id: 2, title: "Current 2", quantity: 1 },
      { id: 3, title: "Current 3", quantity: 1 },
      { id: 4, title: "Current 4", quantity: 1 },
      {
        id: 5,
        title: "Removed 1",
        quantity: 1,
        current_quantity: 0,
        refunded: true,
      },
      { id: 6, title: "Removed 2", quantity: 0, refunded: true },
      { id: 7, title: "Removed 3", quantity: 0, refunded: true },
    ],
    refunds: [
      {
        refund_line_items: [
          { quantity: 1, subtotal: "42.00", total_tax: "0.00" },
          { quantity: 1, subtotal: "21.00", total_tax: "0.00" },
          { quantity: 1, subtotal: "2.07", total_tax: "0.00" },
        ],
        // This is historical gross refund activity from the earlier edit.
        transactions: [
          { kind: "refund", status: "success", amount: "130.14" },
        ],
      },
    ],
  });

  assert.equal(summary.original_order_amount, 165.57);
  assert.equal(summary.original_order_date, "2026-08-22T06:00:00.000Z");
  assert.equal(summary.status, "partially_refunded");
  assert.equal(summary.subtotal_amount, 133.26);
  assert.equal(summary.item_count, 4);
  assert.equal(summary.discount_label, "HOLIDAYSALE");
  assert.equal(summary.discount_amount, 14.99);
  assert.equal(summary.shipping_amount, 0);
  assert.equal(summary.total_amount, 133.26);
  assert.equal(summary.paid_amount, 198.33);
  assert.equal(summary.refunded_amount, 65.07);
  assert.equal(summary.refunded_item_count, 3);
  assert.equal(summary.refund_reason, "No reason provided");
  assert.equal(summary.net_payment, 133.26);
});

test("keeps the creation-time original total after additions and a refund", () => {
  const summary = buildOrderPriceSummary({
    total_price: "209.26",
    current_total_price: "188.26",
    financial_status: "partially_refunded",
    shopify_price_summary: {
      status: "partially_refunded",
      original_order_amount: "124.27",
      paid_amount: "209.26",
      subtotal_amount: "188.26",
      discount_amount: "14.99",
      shipping_amount: "0.00",
      tax_amount: "0.00",
      total_amount: "188.26",
      item_count: 5,
    },
    refunds: [
      {
        transactions: [
          { kind: "refund", status: "success", amount: "21.00" },
        ],
      },
    ],
  });

  assert.equal(summary.original_order_amount, 124.27);
  assert.equal(summary.subtotal_amount, 188.26);
  assert.equal(summary.item_count, 5);
  assert.equal(summary.discount_amount, 14.99);
  assert.equal(summary.shipping_amount, 0);
  assert.equal(summary.tax_amount, 0);
  assert.equal(summary.total_amount, 188.26);
  assert.equal(summary.paid_amount, 209.26);
  assert.equal(summary.refunded_amount, 21);
  assert.equal(summary.net_payment, 188.26);
});
