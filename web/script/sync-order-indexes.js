/**
 * Sync Order + SpecialOrder indexes (drop old, create required)
 * -----------------------------------------------------------
 *
 * WARNING:
 * - This will DROP indexes that are not declared in the schema.
 * - Run during low-traffic maintenance windows.
 *
 * How to run:
 *   node web/script/sync-order-indexes.js
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

async function printIndexes(model, label) {
  const idx = await model.collection.indexes();
  console.log(`\n📌 ${label} indexes (${idx.length}):`);
  for (const i of idx) {
    console.log(` - ${i.name}:`, i.key, i.unique ? "(unique)" : "");
  }
}

(async () => {
  try {
    console.log("\n=== BEFORE ===");
    await printIndexes(Models.Order, "orders");
    await printIndexes(Models.SpecialOrder, "updates_orders");

    console.log("\n🔧 Syncing indexes...");
    await Models.Order.syncIndexes();
    await Models.SpecialOrder.syncIndexes();

    console.log("\n=== AFTER ===");
    await printIndexes(Models.Order, "orders");
    await printIndexes(Models.SpecialOrder, "updates_orders");

    console.log("\n✅ Index sync complete");
  } catch (err) {
    console.error("\n❌ Index sync failed:", err);

    // Common failure: duplicate keys when adding unique indexes
    if (String(err?.message || "").includes("E11000 duplicate key")) {
      console.error(
        "\nLikely cause: duplicate documents exist that violate the new unique index.\n" +
          "Recommended next steps:\n" +
          "1) Identify duplicates by { merchant, id } in orders, and/or { merchant, order_id } in updates_orders\n" +
          "2) Delete/merge duplicates\n" +
          "3) Re-run this script"
      );
    }

    process.exitCode = 1;
  } finally {
    setTimeout(() => process.exit(process.exitCode || 0), 250);
  }
})();
