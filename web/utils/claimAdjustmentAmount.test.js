const assert = require("node:assert/strict");
const {
  calculateReorderGrossTotal,
} = require("./claimAdjustmentAmount");

const lineItems = [
  { id: 1, price: "65.50", final_price: "57.00", quantity: 1 },
  { id: 2, price: "49.99", final_price: "43.50", quantity: 1 },
  { id: 3, price: "39.99", final_price: "35.00", quantity: 1 },
];

assert.equal(
  calculateReorderGrossTotal(lineItems, [
    { id: 1, quantity: 1 },
    { id: 2, quantity: 1 },
  ]),
  115.49
);

assert.equal(
  calculateReorderGrossTotal(
    [{ id: "1", price_set: { shop_money: { amount: "12.34" } } }],
    [{ item_id: 1, quantity: 2 }]
  ),
  24.68
);

assert.equal(calculateReorderGrossTotal(lineItems, [{ id: 999, quantity: 1 }]), 0);

console.log("claimAdjustmentAmount tests passed");
