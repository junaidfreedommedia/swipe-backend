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

function parseArgs(argv) {
  const args = {
    merchantId: null,
    orderNumber: null,
    apply: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--merchant" && argv[i + 1]) {
      args.merchantId = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--order-number" && argv[i + 1]) {
      args.orderNumber = Number(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

function pickWinner(docs) {
  return [...docs].sort((a, b) => {
    const aUpdated = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bUpdated = new Date(b.updatedAt || b.createdAt || 0).getTime();
    if (bUpdated !== aUpdated) return bUpdated - aUpdated;

    const aCreated = new Date(a.createdAt || 0).getTime();
    const bCreated = new Date(b.createdAt || 0).getTime();
    if (bCreated !== aCreated) return bCreated - aCreated;

    return String(b._id).localeCompare(String(a._id));
  })[0];
}

async function main() {
  const { merchantId, orderNumber, apply } = parseArgs(process.argv);

  if (!orderNumber || !Number.isFinite(orderNumber)) {
    throw new Error("Missing required --order-number <number>");
  }

  const match = {
    order_number: orderNumber,
  };

  if (merchantId) {
    match.merchant = ObjectId(merchantId);
  }

  const docs = await Models.Order.find(match)
    .select({
      _id: 1,
      merchant: 1,
      id: 1,
      order_number: 1,
      createdAt: 1,
      updatedAt: 1,
      order_created_at: 1,
      total_price: 1,
      is_protected: 1,
      tracking_status: 1,
    })
    .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
    .lean();

  console.log(`Matched docs: ${docs.length}`);

  if (docs.length <= 1) {
    console.log("No duplicates found for the given order_number.");
    return;
  }

  const winner = pickWinner(docs);
  const losers = docs.filter((doc) => String(doc._id) !== String(winner._id));

  console.log("\nKeeping:");
  console.log(JSON.stringify(winner, null, 2));

  console.log("\nDelete candidates:");
  losers.forEach((doc) => console.log(JSON.stringify(doc, null, 2)));

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to delete candidates.");
    return;
  }

  const loserIds = losers.map((doc) => doc._id);
  const result = await Models.Order.deleteMany({ _id: { $in: loserIds } });
  console.log(`\nDeleted docs: ${result.deletedCount || 0}`);
}

main()
  .then(() => setTimeout(() => process.exit(0), 250))
  .catch((err) => {
    console.error("Failed to delete duplicate orders by order_number:", err);
    setTimeout(() => process.exit(1), 250);
  });
