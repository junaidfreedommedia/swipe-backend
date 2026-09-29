const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const listReturns = async (options) => {
  const queries = [];
  let skip;
  let limit;
  let distinctQuery;
  let projection;
  const schema = {
    find(condition, fields) {
      projection = fields;
      queries.push(condition);
      return {
        sort() { return this; },
        skip(value) { skip = value; return this; },
        limit(value) { limit = value; return this; },
        lean: async () => [],
      };
    },
    countDocuments: async (condition) => { queries.push(condition); return 0; },
    distinct: async (field, condition) => {
      distinctQuery = { field, condition };
      return ["requested", "declined"];
    },
  };
  const filename = path.resolve(__dirname, "../services/Return.js");
  const context = {
    module: { exports: {} },
    require: createRequire(filename),
    Models: { Return: schema, ReturnLookupAttempt: {} },
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  const result = await context.module.exports.list(options);
  return { queries: JSON.parse(JSON.stringify(queries)), skip, limit, projection, distinctQuery: JSON.parse(JSON.stringify(distinctQuery || null)), result };
};

test("combines selected statuses and keeps merchant, search, date and pagination filters", async () => {
  const { queries, skip, limit } = await listReturns({
    merchantId: "store-1",
    status: "needs_review,declined",
    search: "buyer",
    startDate: "2026-09-01",
    page: 2,
    limit: 25,
  });
  assert.deepEqual(queries[0].status, { $in: ["requested", "needs_review", "declined"] });
  assert.equal(queries[0].merchant, "store-1");
  assert.equal(queries[0].$or[2]["customer.email"].$regex, "buyer");
  assert.equal(queries[0].createdAt.$gte, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(queries[1], queries[0]);
  assert.deepEqual(queries[2], { merchant: "store-1", status: { $in: ["requested", "needs_review"] } });
  assert.equal(skip, 25);
  assert.equal(limit, 25);
});

test("single statuses still work and clearing selection removes only the status filter", async () => {
  const single = await listReturns({ merchantId: "store-1", status: "declined" });
  assert.deepEqual(single.queries[0].status, { $in: ["declined"] });
  for (const status of [undefined, "all", "", []]) {
    const { queries } = await listReturns({ merchantIds: ["store-1", "store-2"], status });
    assert.equal(queries[0].status, undefined);
    assert.deepEqual(queries[0].merchant, { $in: ["store-1", "store-2"] });
  }
});

test("accepts array selections and deduplicates the review alias", async () => {
  const { queries } = await listReturns({ status: ["requested", "needs_review", "approved"] });
  assert.deepEqual(queries[0].status, { $in: ["requested", "needs_review", "approved"] });
});

test("available statuses span all pages and ignore active filters while respecting store access", async () => {
  for (const scope of [{ merchantId: "store-1" }, { merchantIds: ["store-1", "store-2"] }]) {
    const { distinctQuery, result } = await listReturns({ ...scope, status: "declined", search: "buyer", page: 3 });
    assert.deepEqual(distinctQuery, {
      field: "status",
      condition: { merchant: scope.merchantId || { $in: scope.merchantIds } },
    });
    assert.deepEqual(Array.from(result.available_statuses), ["requested", "declined"]);
  }
});

test("rows-only list skips counts and returns only the fields needed by the dashboard", async () => {
  const { queries, projection, distinctQuery, result, skip } = await listReturns({ merchantIds: [], view: "rows", page: 2 });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].merchant, { $in: [] });
  assert.equal(distinctQuery, null);
  assert.equal(skip, 25);
  assert.equal(result.total, undefined);
  for (const field of ["_id", "merchant", "shop", "return_number", "status", "outcome", "customer.email", "items.quantity", "items.title", "subtotal", "createdAt"]) assert.equal(projection[field], 1);
  for (const field of ["shopify_payload", "easypost", "timeline", "public_token", "policy_snapshot"]) assert.equal(projection[field], undefined);
});

test("summary-only mode skips rows and uses the same date, search and status filters", async () => {
  const options = { merchantId: "store-1", search: "order", status: "approved", startDate: "2026-09-01", endDate: "2026-09-30" };
  const full = await listReturns(options);
  const summary = await listReturns({ ...options, view: "summary" });
  assert.deepEqual(summary.queries[0], full.queries[0]);
  assert.deepEqual(summary.queries[1], full.queries[2]);
  assert.deepEqual(summary.distinctQuery, full.distinctQuery);
  assert.equal(summary.projection, undefined);
  assert.equal(summary.result.rows, undefined);
  assert.equal(summary.result.total, full.result.total);
});
