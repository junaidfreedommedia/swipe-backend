const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const { createRequire } = require("node:module");
function load(file, globals, override) {
  const filename = path.resolve(__dirname, file), local = createRequire(filename);
  const context = { module: { exports: {} }, ...globals, require: n => override?.(n) || local(n) };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return context.module.exports;
}
const address = { enabled: true, name: "Warehouse", street1: "10 Main St", city: "Naples", zip: "34102", country: "US" };
test("address edits are store scoped, merge existing fields and normalize country and disabled values", async () => {
  let saved;
  const policy = load("../services/ReturnPolicy.js", { Models: { ReturnPolicy: {
    findOne: async () => ({ return_address: address }),
    findOneAndUpdate: async (q, update) => { assert.equal(q.merchant, "store-1"); saved = update.$set; return saved; },
  } } });
  await policy.update("store-1", { return_address: { street1: " 20 New St ", country: "ca" } });
  assert.equal(saved.return_address.street1, "20 New St");
  assert.equal(saved.return_address.name, "Warehouse");
  assert.equal(saved.return_address.country, "CA");
  assert.deepEqual(Object.keys(saved), ["return_address"]);
  await policy.update("store-1", { return_address: { enabled: "false" } });
  assert.equal(saved.return_address.enabled, false);
  assert.equal(saved.return_address.street1, address.street1);
  await assert.rejects(policy.update("store-1", { return_address: { street1: " " } }), { status: 400 });
  await assert.rejects(policy.update("store-1", { return_address: { country: "USA" } }), { status: 400 });
});
test("shipping uses the saved destination or Shopify fallback, and never recreates an existing label", async () => {
  let destination, fallbackCalls = 0, purchases = 0;
  const shipping = load("../services/ReturnShipping.js", { Services: {
    ShopifyReturns: { getSession: async () => ({}) },
    Return: { attachLabel: async (id, label) => label },
  } }, n => n === "../utils/easypost" ? {
    normalizeEasyPostAddress: a => a,
    getShopifyReturnAddress: async () => { fallbackCalls++; return { street1: "Shopify warehouse" }; },
    createReturnShipment: async args => { destination = args.returnAddress; return { id: "shipment", rates: [{ id: "rate", rate: "5", currency: "USD" }] }; },
    purchaseReturnLabel: async () => { purchases++; return { shipment: {} }; },
  } : null);
  const options = { merchant: { shop_id: "store.myshopify.com" }, order: { shipping_address: {} }, returnRecord: { _id: "return", subtotal: { amount: 100 } }, policy: { return_address: address } };
  await shipping.createLabel(options);
  assert.equal(destination.street1, address.street1);
  assert.equal(fallbackCalls, 0);
  await shipping.createLabel({ ...options, policy: { return_address: { ...address, enabled: false } } });
  assert.equal(destination.street1, "Shopify warehouse");
  assert.equal(fallbackCalls, 1);
  await shipping.createLabel({ ...options, returnRecord: { easypost: { shipment_id: "existing" } } });
  assert.equal(purchases, 2);
});
