const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const path = require("node:path");
const { assertReturnProtection } = require("../utils/returns");

test("protection restriction defaults off and accepts existing protected order formats", () => {
  for (const policy of [{}, { protected_orders_only: false }]) {
    assert.doesNotThrow(() => assertReturnProtection({}, policy));
  }
  const policy = { protected_orders_only: true };
  for (const order of [
    { is_protected: true },
    { protection_item: { id: 12 } },
    { line_items: [{ title: "Swipe Package Protection" }] },
    { line_items: [{ sku: "swipe" }] },
  ]) assert.doesNotThrow(() => assertReturnProtection(order, policy));
  for (const order of [{}, { protection_item: null }, { protection_item: {} },
    { is_protected: false, line_items: [{ title: "Sweater" }] }]) {
    assert.throws(() => assertReturnProtection(order, policy), { status: 403 });
  }
});

const loadModule = (relativePath, globals, overrideRequire) => {
  const filename = path.resolve(__dirname, relativePath);
  const localRequire = createRequire(filename);
  const context = {
    module: { exports: {} }, ...globals,
    require: (name) => overrideRequire?.(name) || localRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return context.module.exports;
};

test("policy persists the toggle per merchant without updating other fields", async () => {
  let updateArgs;
  const policy = loadModule("../services/ReturnPolicy.js", { Models: { ReturnPolicy: {
    findOne: async () => ({ merchant: "store-1" }),
    findOneAndUpdate: async (...args) => { updateArgs = args; return args[1].$set; },
  } } });
  for (const enabled of [true, false]) {
    await policy.update("store-1", { protected_orders_only: enabled });
    assert.equal(updateArgs[0].merchant, "store-1");
    assert.equal(JSON.stringify(updateArgs[1]), JSON.stringify({ $set: { protected_orders_only: enabled } }));
    assert.equal(policy.toPublic({ protected_orders_only: enabled }).protected_orders_only, enabled);
  }
  assert.equal(policy.toPublic({}).protected_orders_only, false);
});

test("lookup and stale-token submission enforce latest policy even in test mode", async () => {
  const handlers = {};
  let enabled = false;
  let shopifyCalls = 0;
  let existing = null;
  const order = { _id: "order-1", id: 1, name: "#1", customer: { email: "buyer@example.com" }, line_items: [] };
  const merchant = { _id: "store-1", shop_id: "test.myshopify.com" };
  const router = { get: (route, handler) => { handlers[route] = handler; }, post: (route, handler) => { handlers[route] = handler; } };
  loadModule("../controllers/v1/returns.js", {
    process: { env: { RETURN_TEST_MODE: "true" } },
    Logger: { warn: () => {} },
    Models: {
      Branding: { findOne: () => ({ lean: async () => null }) },
      Return: { findOne: () => ({ sort: () => ({ lean: async () => existing }) }) },
    },
    Services: {
      Merchant: { get: async () => merchant },
      Order: { get: async () => order },
      Return: { recordLookupAttempt: async () => {} },
      ReturnPolicy: {
        getOrCreate: async () => ({ protected_orders_only: enabled, allow_refunds: true, return_window_days: 30 }),
        toPublic: (policy) => policy,
      },
      ShopifyReturns: { getReturnableItems: async () => { shopifyCalls++; return []; } },
    },
  }, (name) => {
    if (name === "express") return { Router: () => router };
    if (name === "../../config/config") return { get: () => ({ SECRET: "test-only" }) };
  });
  const invoke = async (route, body) => {
    let data, error;
    const res = { send: (value) => { data = value; }, status: () => res };
    await handlers[route]({ body, ip: "127.0.0.1" }, res, (err) => { error = err; });
    return { data, error };
  };
  const lookup = { shop: merchant.shop_id, order_number: "1", email_or_postcode: "buyer@example.com" };
  const allowed = await invoke("/lookup", lookup);
  assert.equal(allowed.error, undefined);
  assert.ok(allowed.data.data.lookup_token);
  enabled = true;
  shopifyCalls = 0;
  assert.equal((await invoke("/lookup", lookup)).error.status, 403);
  assert.equal((await invoke("/request", { lookup_token: allowed.data.data.lookup_token, outcome: "refund" })).error.status, 403);
  assert.equal(shopifyCalls, 0);
  order.protection_item = { id: 12 };
  assert.equal((await invoke("/lookup", lookup)).error, undefined);
  const protectedRequest = await invoke("/request", { lookup_token: allowed.data.data.lookup_token, outcome: "refund" });
  assert.equal(protectedRequest.error, undefined);
  assert.equal(protectedRequest.data.message, "Select at least one item.");
  delete order.protection_item;
  enabled = false;
  assert.equal((await invoke("/lookup", lookup)).error, undefined);
  const unprotectedRequest = await invoke("/request", { lookup_token: allowed.data.data.lookup_token, outcome: "refund" });
  assert.equal(unprotectedRequest.error, undefined);
  assert.equal(unprotectedRequest.data.message, "Select at least one item.");
  enabled = true;
  existing = { merchant: merchant._id, return_number: "R1", status: "approved" };
  const tracked = await invoke("/lookup", lookup);
  assert.equal(tracked.error, undefined);
  assert.equal(tracked.data.data.existing_return.return_number, "R1");
});
