const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const { buildOrderSearchFilter, EMAIL_SEARCH_COLLATION } = require("../utils/orderSearch");
const plain = (value) => JSON.parse(JSON.stringify(value));
const merchantId = "6737063863393e78f6ce3028";

function setup({ emails = ["Test+tag@Example.com", "test+tag@example.com"], count = 2 } = {}) {
  const calls = [];
  const rows = [{ _id: "6a9bc7ccc731cccc68f4b0cd", order_number: 42 }];
  const orders = {
    find(filter) {
      const call = { method: "find", filter: plain(filter) };
      calls.push(call);
      const query = {};
      for (const method of ["select", "sort", "skip", "limit", "collation"]) {
        query[method] = (value) => { call[method] = plain(value); return query; };
      }
      query.lean = async () => call.collation
        ? emails.map((email) => ({ customer: { email } })) : rows;
      return query;
    },
    async countDocuments(filter) { calls.push({ method: "count", filter: plain(filter) }); return count; },
    async estimatedDocumentCount() { calls.push({ method: "estimate" }); return count; },
  };
  const source = fs.readFileSync(path.resolve(__dirname, "../services/Order.js"), "utf8");
  const Order = {};
  vm.runInNewContext(source.slice(source.indexOf("Order.OrderList = async"), source.indexOf("Order.ProductList = async")), {
    Order, orderSchema: orders, buildOrderSearchFilter, mongoose, moment,
    ADMIN_TYPE: { SIMPLE_ADMIN: "simple" }, MSG: { DATA_FOUND: "found", DATA_NOT_FOUND: "empty" },
    console: { error() {} },
    throwError(message, status) { throw Object.assign(new Error(message), { status }); },
  });
  return { calls, orders, list: Order.OrderList };
}

test("complete email uses literal indexed equality and preserves all stored casing", async () => {
  const app = setup();
  const filter = await buildOrderSearchFilter("  TEST+tag@example.com  ", app.orders);
  assert.deepEqual(app.calls[0].filter, { "customer.email": "TEST+tag@example.com" });
  assert.deepEqual(app.calls[0].collation, EMAIL_SEARCH_COLLATION);
  assert.deepEqual(filter, { "customer.email": { $in: ["Test+tag@Example.com", "test+tag@example.com"] } });
});

test("partial email, customer name and numeric searches retain existing behavior", async () => {
  const app = setup();
  for (const value of ["Jane", "jane@", "jane@example"]) {
    const filter = await buildOrderSearchFilter(value, app.orders);
    assert.deepEqual(filter.$or, [
      { "customer.email": { $regex: "^" + value, $options: "i" } },
      { "customer.name": { $regex: "^" + value, $options: "i" } },
    ]);
  }
  assert.deepEqual(await buildOrderSearchFilter("108658", app.orders), { order_number: 108658 });
  assert.deepEqual(await buildOrderSearchFilter(undefined, app.orders), {});
  assert.equal(app.calls.length, 0);
});

test("email search preserves merchant access scopes", async () => {
  for (const [request, expected] of [
    [{ user: { role: "merchant" }, merchant: { _id: merchantId } }, merchantId],
    [{ user: { role: "admin", admin_type: "simple", merchants: [merchantId] } }, { $in: [merchantId] }],
    [{ user: { role: "admin", admin_type: "simple", merchants: [] } }, { $in: [] }],
  ]) {
    const app = setup();
    await app.list({ ...request, query: { search: "test+tag@example.com" } });
    const count = app.calls.find((c) => c.method === "count");
    assert.deepEqual(count.filter.merchant, expected);
    assert.deepEqual(app.calls.at(-1).filter, count.filter);
    assert.equal(app.calls.at(-1).collation, undefined);
  }
});

test("unassigned merchant is rejected before any search", async () => {
  const app = setup();
  await assert.rejects(app.list({ user: { role: "admin", admin_type: "simple", merchants: [] }, query: {
    merchant: merchantId, search: "test+tag@example.com",
  } }), { status: 403 });
  assert.equal(app.calls.length, 0);
});

test("date, tags, status, protection and subscription filters survive email search", async () => {
  const app = setup();
  await app.list({ user: { role: "admin" }, query: {
    merchant: merchantId, search: "test+tag@example.com", is_protected: "true",
    is_subscription: "true", tags: "TEMU,VIP", status: "Delivered",
    start_date: "9-01-2026", end_date: "9-16-2026",
  } });
  const filter = app.calls.find((c) => c.method === "count").filter;
  assert.equal(filter.merchant, merchantId);
  assert.equal(filter.is_protected, true);
  assert.equal(filter.tracking_status, "Delivered");
  assert.deepEqual(filter.tags, { $all: ["TEMU", "VIP"] });
  assert.ok(filter.createdAt.$gte && filter.createdAt.$lte);
  assert.ok(filter.$and[0].$or.some((c) => c.is_subscription === true));
  assert.equal(filter["customer.email"].$in.length, 2);
  assert.equal(app.calls.at(-1).collation, undefined);
});

test("no email match returns no orders without dropping the search filter", async () => {
  const app = setup({ emails: [], count: 0 });
  const result = await app.list({ user: { role: "admin" }, query: { search: "missing@example.com" } });
  assert.deepEqual(app.calls.find((c) => c.method === "count").filter, { "customer.email": { $in: [] } });
  assert.equal(result.data.totalRecords, 0);
  assert.equal(result.data.response.length, 0);
  assert.equal(app.calls.filter((c) => c.method === "find").length, 1);
});

test("forward, reverse and cursor pagination keep the indexed email filter", async () => {
  for (const query of [{ page: 2 }, { page: 4 }, { lastId: "6a9bc7ccc731cccc68f4b0ce" }]) {
    const app = setup({ count: 100 });
    const result = await app.list({ user: { role: "admin" }, query: { ...query, search: "test+tag@example.com" } });
    assert.equal(result.data.totalRecords, 100);
    const fetch = app.calls.at(-1);
    assert.equal(fetch.filter["customer.email"].$in.length, 2);
    assert.equal(fetch.collation, undefined);
    assert.equal(fetch.limit, 25);
    if (query.page === 2) assert.equal(fetch.skip, 25);
    if (query.page === 4) assert.deepEqual(fetch.sort, { _id: 1 });
    if (query.lastId) assert.equal(fetch.filter._id.$lt, query.lastId);
  }
});

test("unfiltered admin view still uses estimated count", async () => {
  const app = setup();
  await app.list({ user: { role: "admin" }, query: {} });
  assert.equal(app.calls[0].method, "estimate");
});
