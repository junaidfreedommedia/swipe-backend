const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const runDecline = async ({ reason = "  Final sale item.  ", failure, emailSent = true } = {}) => {
  const events = [];
  let emailOptions;
  let response;
  let error;
  let httpStatus = 200;
  let handler;
  const record = {
    _id: "return-1",
    merchant: "merchant-1",
    shop: "store.myshopify.com",
    shopify_return_id: "gid://shopify/Return/1",
    status: "needs_review",
    return_number: "2853",
    customer: { email: "buyer@example.com", name: "Buyer" },
    public_token: "return-public-token",
  };
  const router = {
    get() {}, put() {}, delete() {},
    post(route, ...handlers) {
      if (route === "/:id/decline") handler = handlers.at(-1);
    },
  };
  const filename = path.resolve(__dirname, "../controllers/merchant/returns.js");
  const localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module: { exports: {} },
    require: (name) => {
      if (name === "express") return { Router: () => router };
      if (name === "../../shopify.js") return {};
      return localRequire(name);
    },
    Auth: { check() {} },
    Services: {
      Return: {
        get: async (query) => {
          assert.equal(query._id, record._id);
          assert.equal(query.merchant, record.merchant);
          return failure === "missing" ? null : record;
        },
        updateStatus: async (id, status, options) => {
          events.push("save");
          if (failure === "save") throw new Error("Save failed");
          assert.equal(id, record._id);
          assert.equal(status, "declined");
          assert.equal(options.detail, reason.trim());
          return { ...record, status, ...options.set };
        },
      },
      ShopifyReturns: { decline: async () => {
        events.push("shopify");
        if (failure === "shopify") throw new Error("Shopify failed");
      } },
      ReturnCustomerNotification: { sendDeclined: async (options) => {
        events.push("email");
        emailOptions = options;
        return { sent: emailSent };
      } },
    },
  }, { filename });
  const res = {
    status(code) { httpStatus = code; return res; },
    send(body) { response = body; return res; },
  };
  await handler({
    body: { reason },
    params: { id: record._id },
    merchant: { _id: record.merchant, name: "Merchant Store" },
  }, res, (err) => { error = err; });
  return { events, emailOptions, response, error, httpStatus };
};

test("decline emails the return's customer only after Shopify and local saving succeed", async () => {
  const result = await runDecline();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.events, ["shopify", "save", "email"]);
  assert.equal(result.emailOptions.customerEmail, "buyer@example.com");
  assert.equal(result.emailOptions.storeName, "Merchant Store");
  assert.equal(result.emailOptions.record.decline_reason, "Final sale item.");
  assert.equal(result.emailOptions.record.public_token, "return-public-token");
  assert.equal(result.response.data.status, "declined");
});

test("does not email for a missing reason, missing return, or failed rejection", async () => {
  const empty = await runDecline({ reason: "   " });
  assert.equal(empty.httpStatus, 400);
  assert.deepEqual(empty.events, []);
  for (const failure of ["missing", "shopify", "save"]) {
    const result = await runDecline({ failure });
    assert.ok(result.error);
    assert.equal(result.events.includes("email"), false);
    assert.equal(result.response, undefined);
  }
});

test("a failed email result does not undo or report failure for the saved rejection", async () => {
  const result = await runDecline({ emailSent: false });
  assert.equal(result.error, undefined);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.response.data.status, "declined");
  assert.equal(result.response.data.decline_reason, "Final sale item.");
});
