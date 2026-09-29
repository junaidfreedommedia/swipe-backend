const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const merchant = "111111111111111111111111", other = "222222222222222222222222", reportId = "333333333333333333333333";
const setup = ({ savedReport = null, createPdf = async () => Buffer.from("test-pdf") } = {}) => {
  const routes = {}; let query;
  const router = { use() {} };
  for (const method of ["get", "post", "delete"]) router[method] = (route, ...handlers) => { routes[`${method} ${route}`] = handlers; };
  const filename = path.resolve(__dirname, "../controllers/merchant/return-finance.js"), local = createRequire(filename);
  const Auth = { check() {}, requireSuperAdmin() {}, isSuperAdmin: (user) => user.super,
    getAssignedMerchantIds: (user) => user.merchants || [], assertMerchantAccess(user, id) { if (!user.super && ![user.merchant, ...(user.merchants || [])].includes(String(id))) throw Object.assign(new Error("No access"), { status: 403 }); } };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module: { exports: {} }, require: (name) => name === "express" ? { Router: () => router } : name === "../../utils/returnFinancePdf" ? { createPdf } : local(name), Auth,
    Models: { ReturnFinanceReport: { findOne(condition) { query = condition; return { lean: async () => savedReport }; },
      find(condition) { query = condition; return { select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [] }; }, countDocuments: async () => 0 } },
  }, { filename });
  return { routes, Auth, getQuery: () => query };
};
const run = async (handler, user, query = {}) => {
  let error, response;
  await handler({ user, query, params: { id: reportId } }, { set() { return this; }, send(value) { response = value; } }, (e) => { error = e; });
  return { error, response };
};
test("merchant list is restricted to own store and arbitrary merchant filters are denied", async () => {
  const app = setup();
  await run(app.routes["get /"].at(-1), { role: "merchant", merchant });
  assert.equal(String(app.getQuery().merchant), merchant);
  assert.ok(app.getQuery()["snapshot.rows.status"].$in.includes("exchanged"));
  const denied = await run(app.routes["get /"].at(-1), { role: "merchant", merchant }, { merchantId: other });
  assert.equal(denied.error.status, 403);
});
test("simple admins can only list assigned stores; preview and PDF use identical store scopes", async () => {
  const app = setup(), user = { role: "admin", merchants: [merchant] };
  await run(app.routes["get /"].at(-1), user);
  assert.deepEqual(app.getQuery().merchant.$in.map(String), [merchant]);
  for (const route of ["get /:id", "get /:id/pdf"]) {
    const result = await run(app.routes[route].at(-1), user);
    assert.equal(result.error.status, 404);
    assert.deepEqual(app.getQuery().merchant.$in.map(String), [merchant]);
  }
  assert.equal((await run(app.routes["get /"].at(-1), user, { merchantId: other })).error.status, 403);
});
test("only super admins can generate or delete reports", () => {
  const app = setup();
  assert.equal(app.routes["post /"][0], app.Auth.requireSuperAdmin);
  assert.equal(app.routes["delete /:id"][0], app.Auth.requireSuperAdmin);
});
test("month and year list filters work independently and reject invalid values", async () => {
  const app = setup(), user = { role: "admin", super: true };
  await run(app.routes["get /"].at(-1), user, { year: "2026" });
  assert.equal(app.getQuery().month.$regex, "^2026-[0-9]{2}$");
  await run(app.routes["get /"].at(-1), user, { monthNumber: "9" });
  assert.equal(app.getQuery().month.$regex, "^[0-9]{4}-09$");
  await run(app.routes["get /"].at(-1), user, { month: "2026-09", year: "2026", monthNumber: "9" });
  assert.equal(app.getQuery().month, "2026-09");
  assert.equal((await run(app.routes["get /"].at(-1), user, { monthNumber: "13" })).error.status, 400);
});
test("JSON preview and PDF both filter legacy snapshots before returning data", async () => {
  let pdfSnapshot;
  const app = setup({ savedReport: { _id: reportId, month: "2026-09", snapshot: { version: 4, rows: [
    { status: "exchanged", type: "Exchange", total_value: 80, refund: 0, stripe_charge: 50, currency: "USD" },
    { status: "processed", type: "refund", amount: 100, currency: "USD" },
  ], notes: [], totals: { USD: { refund: 100 } } } }, createPdf: async (snapshot) => { pdfSnapshot = snapshot; return Buffer.from("test-pdf"); } });
  const user = { role: "merchant", merchant };
  const preview = await run(app.routes["get /:id"].at(-1), user);
  assert.equal(preview.response.data.snapshot.rows.length, 1);
  assert.equal(preview.response.data.snapshot.totals.USD.refund, 0);
  const download = await run(app.routes["get /:id/pdf"].at(-1), user);
  assert.equal(download.error, undefined); assert.equal(pdfSnapshot.rows.length, 1);
  assert.equal(pdfSnapshot.totals.USD.stripe_charge, 50); assert.equal(pdfSnapshot.totals.USD.refund, 0);
});

test("old reports prompt regeneration instead of fabricating item totals", async () => {
  const app = setup({ savedReport: { snapshot: { version: 3, rows: [] } } });
  for (const route of ["get /:id", "get /:id/pdf"]) {
    const result = await run(app.routes[route].at(-1), { role: "merchant", merchant });
    assert.equal(result.error.status, 409); assert.match(result.error.message, /Generate this report again/);
  }
});
