const test = require("node:test");
const assert = require("node:assert/strict");
const { allocateRefundTransactions } = require("../utils/returns");

test("allocates a customer credit refund against the remaining original payment", () => {
  const result = allocateRefundTransactions(
    [
      { id: 10, kind: "sale", status: "success", amount: "49.98", gateway: "shopify_payments" },
      { id: 11, parent_id: 10, kind: "refund", status: "success", amount: "5.00" },
    ],
    39.98
  );

  assert.equal(result.available, 44.98);
  assert.equal(result.remaining, 0);
  assert.deepEqual(result.allocations, [
    {
      parent_id: 10,
      amount: "39.98",
      kind: "refund",
      gateway: "shopify_payments",
    },
  ]);
});

test("reports the unpaid remainder when the order cannot cover the credit refund", () => {
  const result = allocateRefundTransactions(
    [{ id: 10, kind: "capture", status: "success", amount: "20.00", gateway: "card" }],
    39.98
  );

  assert.equal(result.available, 20);
  assert.equal(result.remaining, 19.98);
});
