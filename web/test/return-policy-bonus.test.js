const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

test("bonus settings persist per merchant and public policy omits a disabled bonus", async () => {
  const current = { merchant: "merchant-a", store_credit_bonus: 5 };
  const context = { module: { exports: {} }, Models: { ReturnPolicy: {
    findOne: async () => current,
    findOneAndUpdate: async (scope, change, options) => {
      assert.equal(scope.merchant, "merchant-a");
      assert.equal(options.runValidators, true);
      Object.assign(current, change.$set);
      return { ...current };
    },
  } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../services/ReturnPolicy.js"), "utf8"), context);
  const service = context.module.exports;
  assert.equal(service.toPublic(current).store_credit_bonus, 5);
  await service.update("merchant-a", { store_credit_bonus_enabled: false, store_credit_bonus: 2.5 });
  assert.equal(current.store_credit_bonus, 2.5);
  assert.equal(service.toPublic(current).store_credit_bonus, 0);
  await service.update("merchant-a", { store_credit_bonus_enabled: true });
  assert.equal(service.toPublic(current).store_credit_bonus, 2.5);
  for (const amount of [-1, "invalid", Infinity]) {
    await assert.rejects(service.update("merchant-a", { store_credit_bonus: amount }), error => error.status === 400);
  }
  assert.equal(current.store_credit_bonus, 2.5);
});
