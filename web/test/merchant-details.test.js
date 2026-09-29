const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute the real controller with isolated service dependencies, so a slow
// external sheet connection can be simulated without network or database writes.
const loadDetails = ({ sheetEnabled = true, billed = true, denied = false } = {}) => {
    const merchant = {
        _id: "000000000000000000000099", name: "Test Store", shop_id: "test-store",
        is_billing: billed, account_manager: "manager", google_sheet_claim_sync_enabled: sheetEnabled,
        google_sheet_id: sheetEnabled ? "test-sheet" : null,
        google_sheet_url: sheetEnabled ? "https://docs.google.com/spreadsheets/d/test-sheet" : null,
    };
    const calls = { repair: 0, merchant: 0, access: 0, billing: 0 };
    const claims = ["REVIEWING", "APPROVED", "CLOSED", "RESOLVED"].map((status) => ({ status }));
    const Services = {
        Merchant: { get: async () => { calls.merchant++; return merchant; } },
        GoogleSheet: { repairMerchantSpreadsheet: () => { calls.repair++; return new Promise(() => {}); } },
        Claim: { aggregate: async () => [{ claim_order: claims }] },
        Task: { get: async () => ({ done: true }) },
        User: { getAll: async () => [{ display_name: "Test User" }], get: async () => ({ email: "manager@example.com" }) },
        ShopifySession: { get: async () => ({ shop: "test-store" }) },
        Billing: { checkBillingStatus: async () => { calls.billing++; return false; } },
    };
    const noop = (req, res, next) => next();
    const context = {
        Services, console, module: { exports: {} },
        require: (name) => {
            if (name === "express") return require("express");
            if (["./../../shopify", "./../../app-install", "heic-convert"].includes(name)) return {};
            throw new Error(`Unexpected controller dependency: ${name}`);
        },
        Auth: {
            check: noop, validate: noop, requireSuperAdmin: noop, requireMerchantAccess: () => noop,
            assertMerchantAccess: (user, id) => {
                calls.access++;
                assert.equal(id, merchant._id);
                if (denied) throw new Error("Merchant access denied");
            },
        },
        Func: { validate: () => noop }, AdminRules: {}, MerchantRules: {},
        Moment: require("moment-timezone"), ObjectId: (id) => id, empty: (value) => !value,
        CLAIM_STATUS: Object.fromEntries(["REVIEWING", "APPROVED", "CLOSED", "RESOLVED"].map(status => [status, status])),
        MSG: { DATA_FOUND: "Data found", DATA_NOT_FOUND: "Data not found" },
    };
    const filename = path.resolve(__dirname, "../controllers/admin/merchant.js");
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
    const route = context.module.exports.stack.find(layer => layer.route?.path === "/:id" && layer.route.methods.get);
    const handler = route.route.stack.at(-1).handle;
    const request = async () => {
        let payload, error, timer;
        try {
            await Promise.race([
                handler({ params: { id: merchant._id }, query: {}, user: { role: "admin" } }, { send: data => { payload = data; } }, err => { error = err; }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Store details waited for a stalled sheet connection")), 1000); }),
            ]);
        } finally { clearTimeout(timer); }
        if (error) throw error;
        return payload;
    };
    return { request, calls, merchant };
};

test("opening and refreshing a connected store returns details without starting or waiting for sheet repair", async () => {
    const { request, calls, merchant } = loadDetails();
    for (let attempt = 0; attempt < 3; attempt++) {
        const { data } = await request();
        assert.equal(data.merchant_id, merchant._id);
        assert.equal(data.merchant_name, "Test Store");
        assert.equal(data.google_sheet_claim_sync_enabled, true);
        assert.equal(data.google_sheet_url, merchant.google_sheet_url);
        assert.equal(data.total, 4);
        for (const status of ["in_review", "approved", "closed", "resolved"]) assert.equal(data[status], 1);
        assert.equal(data.shopify_billing, true);
        assert.equal(data.task.done, true);
        assert.equal(data.user[0].display_name, "Test User");
        assert.equal(data.merchant_account_manager.email, "manager@example.com");
    }
    assert.equal(calls.repair, 0);
    assert.equal(calls.access, 3);
});

test("store details still check billing when needed and support stores without sheet sync", async () => {
    for (const sheetEnabled of [true, false]) {
        const { request, calls } = loadDetails({ sheetEnabled, billed: false });
        const { data } = await request();
        assert.equal(data.google_sheet_claim_sync_enabled, sheetEnabled);
        assert.equal(data.shopify_billing, false);
        assert.equal(calls.billing, 1);
        assert.equal(calls.repair, 0);
    }
});

test("store details still reject unauthorized merchant access before fetching store data", async () => {
    const { request, calls } = loadDetails({ denied: true });
    await assert.rejects(request(), /Merchant access denied/);
    assert.equal(calls.merchant, 0);
    assert.equal(calls.repair, 0);
});
