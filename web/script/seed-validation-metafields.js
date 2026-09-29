/**
 * Seed checkout validation metafields on a product
 * --------------------------------------------------
 * Sets swipe_validation.is_restricted = "true" on the product whose
 * handle matches PRODUCT_HANDLE (default: "swipe").
 *
 * Usage:
 *   SHOP=yourstore.myshopify.com node web/script/seed-validation-metafields.js
 *   SHOP=yourstore.myshopify.com PRODUCT_HANDLE=swipe node web/script/seed-validation-metafields.js
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

global._ = require("lodash");
global.Path = require("path");
global.Fs = require("fs-extra");
global.Logger = console;

const mongoose = require("mongoose");
const Config = require("../config/config");
const ShopifySession = require("../models/ShopifySession.js");
const shopify = require("../shopify.js");

const SHOP = process.env.SHOP;
if (!SHOP) {
  console.error("ERROR: Set SHOP env var, e.g. SHOP=yourstore.myshopify.com node ...");
  process.exit(1);
}

const PRODUCT_HANDLE = process.env.PRODUCT_HANDLE || "swipe";
const ERROR_MESSAGE =
  process.env.ERROR_MESSAGE ||
  "You cannot purchase Swipe on its own. Please add other items to your cart.";

async function run() {
  await mongoose.connect(Config.get("MONGO_URI"));
  console.log("Connected to MongoDB");

  const session = await ShopifySession.getShopifySession(SHOP);
  if (!session) {
    console.error(`No session found for shop: ${SHOP}`);
    process.exit(1);
  }

  const client = new shopify.api.clients.Graphql({ session });

  // 1. Find product by handle
  const productRes = await client.query({
    data: {
      query: `
        query getProduct($query: String!) {
          products(first: 1, query: $query) {
            edges {
              node {
                id
                title
                handle
              }
            }
          }
        }
      `,
      variables: { query: `handle:${PRODUCT_HANDLE}` },
    },
  });

  const productNode = productRes.body.data.products.edges[0]?.node;
  if (!productNode) {
    console.error(`Product with handle "${PRODUCT_HANDLE}" not found on ${SHOP}`);
    process.exit(1);
  }
  const product = productNode;
  console.log(`Found product: ${product.title} (${product.id})`);

  // 2. Get shop GID for error message metafield
  const shopRes = await client.query({
    data: { query: `query { shop { id } }` },
  });
  const shopId = shopRes.body.data.shop.id;

  // 3. Set metafields — product flag + shop error message
  const result = await client.query({
    data: {
      query: `
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { ownerId namespace key value }
            userErrors  { field message }
          }
        }
      `,
      variables: {
        metafields: [
          {
            ownerId: product.id,
            namespace: "swipe_validation",
            key: "is_restricted",
            type: "boolean",
            value: "true",
          },
          {
            ownerId: shopId,
            namespace: "swipe_validation",
            key: "restricted_error_message",
            type: "single_line_text_field",
            value: ERROR_MESSAGE,
          },
        ],
      },
    },
  });

  const { metafields, userErrors } = result.body.data.metafieldsSet;

  if (userErrors?.length) {
    console.error("Shopify userErrors:", userErrors);
    process.exit(1);
  }

  console.log("Metafields set successfully:");
  metafields.forEach((m) =>
    console.log(`  [${m.ownerId}] ${m.namespace}.${m.key} = "${m.value}"`)
  );

  await mongoose.disconnect();
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
