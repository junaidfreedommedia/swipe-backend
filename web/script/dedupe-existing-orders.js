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
    }
  }

  return args;
}

function sortDocsForKeep(docs) {
  return [...docs].sort((a, b) => {
    const aUpdated = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bUpdated = new Date(b.updatedAt || b.createdAt || 0).getTime();
    if (bUpdated !== aUpdated) return bUpdated - aUpdated;

    const aCreated = new Date(a.createdAt || 0).getTime();
    const bCreated = new Date(b.createdAt || 0).getTime();
    if (bCreated !== aCreated) return bCreated - aCreated;

    return String(b._id).localeCompare(String(a._id));
  });
}

async function main() {
  const { merchantId, apply } = parseArgs(process.argv);
  const match = {
    merchant: { $exists: true, $ne: null },
    id: { $exists: true, $ne: null },
  };

  if (merchantId) {
    match.merchant = ObjectId(merchantId);
  }

  const groups = await Models.Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          merchant: "$merchant",
          id: "$id",
        },
        count: { $sum: 1 },
        docs: {
          $push: {
            _id: "$_id",
            order_number: "$order_number",
            number: "$number",
            createdAt: "$createdAt",
            updatedAt: "$updatedAt",
            order_created_at: "$order_created_at",
            total_price: "$total_price",
            is_protected: "$is_protected",
          },
        },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1, "_id.merchant": 1, "_id.id": 1 } },
  ]).option({ allowDiskUse: true });

  console.log(`Duplicate groups found: ${groups.length}`);

  if (!groups.length) {
    return;
  }

  const loserIds = [];

  groups.forEach((group, index) => {
    const ranked = sortDocsForKeep(group.docs);
    const keeper = ranked[0];
    const losers = ranked.slice(1);
    loserIds.push(...losers.map((doc) => doc._id));

    console.log(`\n#${index + 1} merchant=${group._id.merchant} shopify_order_id=${group._id.id} count=${group.count}`);
    console.log(`KEEP ${JSON.stringify(keeper)}`);
    losers.forEach((doc) => {
      console.log(`DROP ${JSON.stringify(doc)}`);
    });
  });

  console.log(`\nTotal delete candidates: ${loserIds.length}`);

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to delete duplicate docs.");
    return;
  }

  const result = await Models.Order.deleteMany({ _id: { $in: loserIds } });
  console.log(`Deleted docs: ${result.deletedCount || 0}`);
}

main()
  .then(() => setTimeout(() => process.exit(0), 250))
  .catch((err) => {
    console.error("Failed to dedupe existing orders:", err);
    setTimeout(() => process.exit(1), 250);
  });
