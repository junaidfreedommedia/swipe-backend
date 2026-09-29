const path = require("path");
const axios = require("axios");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
process.env.ALLOW_CONFIG_MUTATIONS = "true";
require("../config/config");
const Models = require("../models");

console.log("✅ DB readyState:", mongoose.connection.readyState);

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const MERCHANT_ID = "68b92e71c99f83570e774662";

async function fetchOrderByName(orderName) {
  const url = `https://${SHOP_DOMAIN}/admin/api/2025-07/orders.json`;
  const res = await axios.get(url, {
    params: { name: orderName, status: "any", limit: 1 },
    headers: { "X-Shopify-Access-Token": TOKEN }
  });
  return res.data.orders[0] || null;
}

async function fetchProductImage(productId) {
  try {
    const url = `https://${SHOP_DOMAIN}/admin/api/2025-07/products/${productId}.json`;
    const res = await axios.get(url, {
      headers: { "X-Shopify-Access-Token": TOKEN }
    });
    const p = res.data.product;
    return p.image?.src || (p.images && p.images[0]?.src) || null;
  } catch (err) {
    console.error("❌ Product image fetch failed:", err.message);
    return null;
  }
}

(async () => {
  try {
    const orderNames = [
      "#1325", "#1324", "#1323", "#1322", "#1321", "#1320",
      "#1319", "#1318", "#1317", "#1316", "#1315", "#1314", "#1313"
    ];

    const merchantDoc = await Models.Merchant.findById(MERCHANT_ID).lean();
    if (!merchantDoc) throw new Error("Merchant not found: " + MERCHANT_ID);

    for (const orderName of orderNames) {
      console.log(`🔍 Fetching order ${orderName}…`);
      const o = await fetchOrderByName(orderName);

      if (!o) {
        console.log(`⚠️ Order ${orderName} not found.`);
        continue;
      }

      // Attach product images
      for (const item of o.line_items) {
        if (item.product_id) {
          const imageUrl = await fetchProductImage(item.product_id);
          item.image_url = imageUrl;
          console.log(`   • Fetched image for product ${item.product_id}: ${imageUrl}`);
        }
      }

      // Check if already exists
      const exists = await Models.Order.findOne({ id: o.id, merchant: MERCHANT_ID });
      if (exists) {
        console.log("⚪ Already in DB:", o.name);
        continue;
      }

      console.log("🟢 Inserting missing order:", o.name);

      const tags = (o.tags || "").split(",").map(t => t.trim()).filter(Boolean);
      const tracking_status = o.fulfillment_status === "fulfilled" ? "fulfilled" : "unfulfilled";
      const protItem = o.line_items.find(li => li.title === "Swipe Package Protection");
      const isProt = !!protItem;
      const protAmount = isProt ? Number(protItem.price) : 0;

      const orderDetails = {
        ...o,
        order_created_at: o.created_at,
        merchant: merchantDoc._id,
        tracking_status,
        "customer.name": `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim(),
        browser_ip: o.client_details?.browser_ip || o.browser_ip || null,
        tags,
        is_protected: isProt,
        protection_amount: protAmount,
        protection_item: isProt ? protItem : null,
      };

      await Models.Order.create(orderDetails);
      console.log("   ✔ Created", o.name);
    }

    console.log("✅ Done fetching & inserting all orders");
  } catch (err) {
    console.error("❌ Fatal error:", err);
  } finally {
    process.exit(0);
  }
})();
