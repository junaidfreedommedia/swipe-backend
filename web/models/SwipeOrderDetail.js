const mongoose = require("mongoose");
const SwipeOrderDetailSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, index: true, required: true },
    date: { type: String, required: true }, 
    order_number: { type: Number, index: true, required: true },
    line_id: { type: String, required: true }, 
    product_id: { type: Number },
    variant_id: { type: Number },
    title: String,
    sku: String,
    quantity: { type: Number, default: 0 },
    price_cents: { type: Number, default: 0 },          
    swipe_price_cents: { type: Number, default: 0 },   
    swipe_discount_cents: { type: Number, default: 0 }, 
    net_swipe_cents: { type: Number, default: 0 },      
    swipe_refunded_cents: { type: Number, default: 0 }, 
    discount_applications: [
      {
        type: { type: String },
        title: String,         
        method: String,        
        value_type: String,
        value: mongoose.Schema.Types.Mixed,
        target_selection: String,
      }
    ],
  },
  { timestamps: true }
);
SwipeOrderDetailSchema.index(
  { merchant: 1, date: 1, order_number: 1, line_id: 1 },
  { unique: true, name: "uniq_detail_line" }
);
module.exports = mongoose.model("SwipeOrderDetail", SwipeOrderDetailSchema, "swipe_order_details");
