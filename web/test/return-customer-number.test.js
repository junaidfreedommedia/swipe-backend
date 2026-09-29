const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const date = new Date("2026-09-14T10:00:00Z");
const current = { _id: "20", merchant: "store-a", createdAt: date, customer: { email: "Buyer+test@example.com" } };
function load(rows) {
  let queries = 0;
  const filename = path.resolve(__dirname, "../services/Return.js");
  const context = {
    module: { exports: {} }, require: createRequire(filename),
    Models: { ReturnLookupAttempt: {}, Return: { countDocuments: async (q) => {
      queries++;
      assert.equal(q.merchant, "store-a");
      assert.equal(q.status, undefined);
      const email = new RegExp(q["customer.email"].$regex, q["customer.email"].$options);
      return rows.filter(r => r.merchant === q.merchant && email.test(r.customer.email) && (
        r.createdAt < q.$or[0].createdAt.$lt ||
        (+r.createdAt === +q.$or[1].createdAt && r._id < q.$or[1]._id.$lt)
      )).length;
    } } },
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return { service: context.module.exports, queries: () => queries };
}
test("return number counts only earlier requests from the same store and exact email", async () => {
  const earlier = { ...current, _id: "10", createdAt: new Date(+date - 1000) };
  const { service } = load([
    earlier,
    { ...earlier, _id: "11", customer: { email: " buyer+TEST@example.com " }, status: "declined" },
    { ...earlier, merchant: "store-b" },
    { ...earlier, customer: { email: "BuyerZtest@exampleXcom" } },
    current,
    { ...earlier, _id: "30", createdAt: new Date(+date + 1000) },
  ]);
  assert.equal(await service.customerReturnNumber(current), 3);
});
test("same-time requests have a stable ID tie break; first request is 1", async () => {
  assert.equal(await load([]).service.customerReturnNumber(current), 1);
  assert.equal(await load([{ ...current, _id: "10" }, current, { ...current, _id: "30" }]).service.customerReturnNumber(current), 2);
});
test("missing identity or date never counts unrelated customers or invents a first return", async () => {
  const loaded = load([]);
  for (const record of [{ ...current, customer: {} }, { ...current, merchant: null }, { ...current, _id: null }, { ...current, createdAt: null }, { ...current, createdAt: "invalid" }]) {
    assert.equal(await loaded.service.customerReturnNumber(record), null);
  }
  assert.equal(loaded.queries(), 0);
});
