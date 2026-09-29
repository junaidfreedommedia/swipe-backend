// Adds only the email search indexes. Does not load app models, start jobs,
// modify orders, or drop/rebuild unrelated indexes.
const fs = require("node:fs");
const path = require("node:path");
const { MongoClient } = require("mongoose").mongo;
const { EMAIL_SEARCH_COLLATION, EMAIL_SEARCH_INDEX } = require("../utils/orderSearch");
const env = require("dotenv").parse(fs.readFileSync(path.resolve(__dirname, "../../.env")));

async function main() {
  const databaseName = process.env.DATABASE_NAME || env.DATABASE_NAME;
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!databaseName || !url) throw new Error("Database configuration missing");
  const client = new MongoClient(`${url}/${databaseName}`, {
    serverSelectionTimeoutMS: 15000,
    family: 4,
    appName: "EnsureOrderEmailIndexes",
  });
  try {
    await client.connect();
    const orders = client.db(databaseName).collection("orders");
    console.log(`Ensuring email search indexes in ${databaseName}.orders`);
    await orders.createIndex(
      { "customer.email": 1, order_number: 1 },
      { name: "customer.email_1_order_number_1" }
    );
    await orders.createIndex(
      { "customer.email": 1 },
      { name: EMAIL_SEARCH_INDEX, collation: EMAIL_SEARCH_COLLATION }
    );
    console.log("Email search indexes ready; no order records changed.");
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("Index setup failed:", error.name, error.code || "");
  process.exitCode = 1;
});
