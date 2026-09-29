const test = require("node:test");
const assert = require("node:assert/strict");

const {
  verifyOrderIdentity,
  buildReturnableItems,
  calculateReturnSummary,
  calculateExchangeAdjustment,
  validateExchangeVariant,
} = require("./returns");

test("matches an order by email or postcode", () => {
  const order = {
    customer: { email: "Customer@Example.com" },
    shipping_address: { zip: "SW1A 1AA" },
  };

  assert.equal(verifyOrderIdentity(order, "customer@example.com"), true);
  assert.equal(verifyOrderIdentity(order, "sw1a-1aa"), true);
  assert.equal(verifyOrderIdentity(order, "wrong@example.com"), false);
});

test("only marks delivered, in-window, non-final-sale items eligible", () => {
  const now = new Date("2026-08-31T00:00:00.000Z");
  const order = {
    tracking_status: "delivered",
    fulfillments: [{ delivered_at: "2026-08-20T00:00:00.000Z" }],
    line_items: [
      { id: 1, title: "Sweater", quantity: 1, price: "68.00" },
      {
        id: 2,
        title: "Final sale cap",
        quantity: 1,
        price: "24.00",
        properties: [{ name: "final_sale", value: "true" }],
      },
    ],
  };

  const result = buildReturnableItems(
    order,
    { return_window_days: 30, final_sale_tags: ["final-sale"] },
    now
  );

  assert.equal(result.days_left, 19);
  assert.equal(result.items[0].eligible, true);
  assert.equal(result.items[1].eligible, false);
  assert.equal(result.items[1].ineligible_reason, "Final sale");
});

test("calculates visible fees and merchant-fault waiver", () => {
  const summary = calculateReturnSummary({
    currency: "USD",
    outcome: "refund",
    policy: {
      restocking_fee_percent: 5,
      return_shipping_fee: 8,
      keep_item_max: 12,
    },
    items: [
      {
        unit_price: 100,
        quantity: 1,
        waive_shipping_fee: true,
      },
    ],
  });

  assert.deepEqual(summary, {
    currency: "USD",
    subtotal: 100,
    restocking_fee: 5,
    return_shipping_fee: 0,
    refund_total: 95,
    exchange_total: 0,
    store_credit_total: 95,
    revenue_kept: 5,
    keep_item: false,
  });
});

test("store credit bonus supports custom amounts, off, zero and existing policies without changing refunds or exchanges", () => {
  const quote = (outcome, policy) => calculateReturnSummary({
    outcome, currency: "USD", policy, items: [{ unit_price: 36.99, quantity: 1 }],
  });
  assert.equal(quote("store_credit", { store_credit_bonus: 5 }).store_credit_total, 41.99);
  assert.equal(quote("store_credit", { store_credit_bonus: 2.5, store_credit_bonus_enabled: true }).store_credit_total, 39.49);
  assert.equal(quote("store_credit", { store_credit_bonus: 5, store_credit_bonus_enabled: false }).store_credit_total, 36.99);
  assert.equal(quote("store_credit", { store_credit_bonus: 0, store_credit_bonus_enabled: true }).store_credit_total, 36.99);
  assert.equal(quote("store_credit", { store_credit_bonus: 5, return_shipping_fee: 2 }).store_credit_total, 39.99);
  for (const outcome of ["refund", "exchange"]) {
    assert.deepEqual(quote(outcome, { store_credit_bonus: 5, store_credit_bonus_enabled: true }),
      quote(outcome, { store_credit_bonus: 5, store_credit_bonus_enabled: false }));
  }
});

test("accepts an available size or color variant from the same product", () => {
  const item = {
    variant_id: "gid://shopify/ProductVariant/10",
    exchange_variants: [
      {
        id: "gid://shopify/ProductVariant/10",
        title: "Size: Small / Color: Blue",
        available: true,
        inventory_tracked: true,
        inventory_policy: "DENY",
        inventory_quantity: 1,
      },
      {
        id: "gid://shopify/ProductVariant/11",
        title: "Size: Medium / Color: Blue",
        available: true,
        inventory_tracked: true,
        inventory_policy: "DENY",
        inventory_quantity: 3,
      },
    ],
  };

  const result = validateExchangeVariant(item, "11", 2);

  assert.equal(result.error, undefined);
  assert.equal(result.variant.id, "gid://shopify/ProductVariant/11");
});

test("rejects an invalid or out-of-stock exchange variant", () => {
  const item = {
    variant_id: "gid://shopify/ProductVariant/10",
    exchange_variants: [
      {
        id: "gid://shopify/ProductVariant/10",
        title: "Small",
        available: false,
        inventory_tracked: true,
        inventory_policy: "DENY",
        inventory_quantity: 0,
      },
    ],
  };

  assert.match(
    validateExchangeVariant(item, "10", 1).error,
    /out of stock/i
  );
  assert.match(
    validateExchangeVariant(item, "999", 1).error,
    /valid exchange/i
  );
});

test("charges only the extra amount for a more expensive replacement", () => {
  assert.deepEqual(
    calculateExchangeAdjustment({
      items: [{ unit_price: 19.99, quantity: 1 }],
      replacementItems: [{ replacement_unit_price: 24.99, quantity: 1 }],
    }),
    {
      return_credit: 19.99,
      replacement_total: 24.99,
      credit_applied: 19.99,
      amount_due: 5,
      credit_due: 0,
    }
  );
});

test("keeps the remaining customer credit for a cheaper replacement", () => {
  assert.deepEqual(
    calculateExchangeAdjustment({
      items: [{ unit_price: 19.99, quantity: 1 }],
      replacementItems: [{ replacement_unit_price: 9.99, quantity: 1 }],
    }),
    {
      return_credit: 19.99,
      replacement_total: 9.99,
      credit_applied: 9.99,
      amount_due: 0,
      credit_due: 10,
    }
  );
});
