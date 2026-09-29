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

async function main() {
  const merchantArg = process.argv[2] || null;
  const match = {
    merchant: { $exists: true, $ne: null },
    id: { $exists: true, $ne: null },
  };

  if (merchantArg) {
    match.merchant = ObjectId(merchantArg);
  }

  const rows = await Models.Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: { merchant: "$merchant", id: "$id" },
        count: { $sum: 1 },
        docs: {
          $push: {
            _id: "$_id",
            order_number: "$order_number",
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

  console.log(`Duplicate groups found: ${rows.length}`);

  rows.forEach((row, index) => {
    console.log(`\n#${index + 1}`);
    console.log(`merchant=${row._id.merchant} shopify_order_id=${row._id.id} count=${row.count}`);
    row.docs.forEach((doc) => {
      console.log(
        JSON.stringify({
          _id: doc._id,
          order_number: doc.order_number,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
          order_created_at: doc.order_created_at,
          total_price: doc.total_price,
          is_protected: doc.is_protected,
        })
      );
    });
  });
}

main()
  .then(() => setTimeout(() => process.exit(0), 250))
  .catch((err) => {
    console.error("Failed to find duplicate orders:", err);
    setTimeout(() => process.exit(1), 250);
  });
