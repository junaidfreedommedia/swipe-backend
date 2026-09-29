// Yeh file updates_orders.js ya SpecialOrder.js ho sakti hai
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const SpecialOrderSchema = new Schema({
  order_id: Number,
  order_number: Number,
  
  // 🟢 YEH AAP KA SAHI CODE HAI
  type: { 
    type: String, 
    enum: ["refund", "cancel", "return", "update"],
    required: true 
  },

  amount: String,
  status: String,
  payload: Schema.Types.Mixed, 
  merchant: { type: Schema.Types.ObjectId, ref: "merchants" }
}, { timestamps: true });

// =====================================================
// INDEXES (minimal + match actual usage)
// =====================================================
// 1) Upserts are performed by { merchant, order_id }.
SpecialOrderSchema.index(
  { merchant: 1, order_id: 1 },
  {
    unique: true,
    name: "uniq_merchant_order_id",
    partialFilterExpression: {
      merchant: { $exists: true, $ne: null },
      order_id: { $exists: true, $ne: null },
    },
  }
);

// 2) Reporting queries match on merchant + swipe line-items.
SpecialOrderSchema.index(
  { merchant: 1, "payload.line_items.sku": 1 },
  { name: "merchant_payload_sku_idx" }
);


module.exports = mongoose.model("updates_orders", SpecialOrderSchema);
