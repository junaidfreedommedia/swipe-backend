/**
 * Backfill missing Order.order_created_at
 * -----------------------------------
 *
 * Why:
 * - Reports/aggregations rely on `order_created_at` (Shopify order created_at)
 * - Order indexes are built around `order_created_at` for performance
 * - Some legacy orders may have null/missing `order_created_at`
 *
 * What this does:
 * - Sets order_created_at = createdAt wherever order_created_at is null or missing
 * - Leaves existing valid order_created_at untouched
 *
 * How to run:
 *   node web/script/backfill-order-created-at.js
 */

require("dotenv").config({ path: "../.env" });

global._ = require("lodash");
global.Path = require("path");
global.Fs = require("fs-extra");
global.Logger = require("../utils/logger");

const Config = require("../config/config");
global.Config = Config;

require("../utils/global");
require("../utils/constants");

global.Models = require("../models");

(async () => {
  try {
    const filter = {
      $or: [{ order_created_at: { $exists: false } }, { order_created_at: null }],
    };

    const before = await Models.Order.countDocuments(filter);
    console.log(`🔎 Orders missing order_created_at: ${before}`);

    if (before === 0) {
      console.log("✅ No backfill needed");
      process.exit(0);
    }

    // Use native driver pipeline update (fast, server-side)
    const res = await Models.Order.collection.updateMany(filter, [
      { $set: { order_created_at: "$createdAt" } },
    ]);

    console.log(
      `✅ Backfill complete. Matched: ${res.matchedCount ?? res.n ?? 0}, Modified: ${res.modifiedCount ?? res.nModified ?? 0}`
    );

    const after = await Models.Order.countDocuments(filter);
    console.log(`🔎 Remaining missing order_created_at: ${after}`);
  } catch (err) {
    console.error("❌ Backfill failed:", err);
    process.exitCode = 1;
  } finally {
    // Allow Mongoose to flush logs
    setTimeout(() => process.exit(process.exitCode || 0), 250);
  }
})();
