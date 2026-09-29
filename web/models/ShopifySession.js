const Mongoose = require("mongoose");

// ✅ Shopify Session Schema
const ShopifySessionSchema = new Mongoose.Schema(
  {
    id: { type: String, unique: true, required: true }, // e.g. offline_store / online_store
    shop: { type: String, required: true, index: true }, // e.g. mystore.myshopify.com
    state: String,
    isOnline: { type: Boolean, default: false },
    scope: String,
    accessToken: String,
  },
  {
    timestamps: true,
    id: false,
    toObject: { virtuals: true, getters: true },
    toJSON: { virtuals: true, getters: true },
  }
);

/* 
====================================================
✅ saveOrUpdate()
Automatically updates existing session or creates a new one.
Handles both online/offline, prevents duplicates.
====================================================
*/
ShopifySessionSchema.statics.saveOrUpdate = async function (sessionData) {
  const { shop, id } = sessionData;

  // clean duplicates for safety
  await this.deleteMany({
    shop,
    id: { $ne: id },
    isOnline: sessionData.isOnline,
  });

  // upsert record
  return this.updateOne(
    { id },
    { $set: sessionData },
    { upsert: true }
  );
};

/* 
====================================================
✅ getShopifySession(shop, mode)
Helper to fetch existing token easily:
- mode = 'online' | 'offline' | 'auto' (default auto)
====================================================
*/
ShopifySessionSchema.statics.getShopifySession = async function (shop, mode = "auto") {
  shop = shop.toLowerCase();

  if (mode === "online") {
    const online = await this.findOne({ shop, isOnline: true });
    if (online) return online;
  }

  if (mode === "offline") {
    const offline = await this.findOne({ shop, isOnline: false });
    if (offline) return offline;
  }

  // auto-detect (prefer online, fallback offline)
  const online = await this.findOne({ shop, isOnline: true });
  if (online) return online;

  const offline = await this.findOne({ shop, isOnline: false });
  if (offline) return offline;

  return null; // no session found
};

module.exports = Mongoose.model("shopify_sessions", ShopifySessionSchema);
