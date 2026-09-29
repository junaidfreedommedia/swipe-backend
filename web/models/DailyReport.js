const mongoose = require("mongoose");
const { Schema } = mongoose;

const HourlyStatSchema = new Schema({
  hour: { type: Number },
  ymdH: { type: String },
  net_items_sold: { type: Number, default: 0 },
protected_order_percentage: { type: String, default: "0.00%" },

  total_price: { type: String, default: "$0.00" },
  total_gross_sales: { type: String, default: "$0.00" },
  swipe_discounts: { type: String, default: "$0.00" },
  gross_returns_amount: { type: String, default: "$0.00" },
  net_returns_amount: { type: String, default: "$0.00" },
  net_sales: { type: String, default: "$0.00" },
});

const DailyReportSchema = new Schema(
  {
    merchant: { type: Schema.Types.ObjectId, ref: "merchants", index: true },
    date: { type: String, index: true },
    timezone: { type: String, default: "America/Chicago", index: true },

 total_gross_sales: { type: String, default: "$0.00" },
swipe_discounts: { type: String, default: "$0.00" },
gross_returns_amount: { type: String, default: "$0.00" },
net_returns_amount: { type: String, default: "$0.00" },
net_sales: { type: String, default: "$0.00" },
total_price: { type: String, default: "$0.00" },
protected_order_percentage: { type: String, default: "0.00%" },
net_items_sold: { type: Number, default: 0 },
 total_orders: { type: Number, default: 0 },
    total_returns_count: { type: Number, default: 0 },
    today_returns_count: { type: Number, default: 0 },
    previous_returns_count: { type: Number, default: 0 },
    computed_at: { type: Date, default: Date.now },
    total_order_amount: { type: String, default: "$0.00" },
    total_order_amount_c: { type: Number, default: 0 },
    saved_revenue: { type: String, default: "$0.00" },
    saved_revenue_c: { type: Number, default: 0 },

    protected_order_list: [
      {
        order_number: String,
        order_created_at: Date,
        swipe_price: String,
        swipe_discount: String,
        net_swipe: String,
        returned_qty_today: { type: Number, default: 0 },
        returned_qty_previous: { type: Number, default: 0 },
        refunded_amount_today: { type: String, default: "$0.00" },
        refunded_amount_previous: { type: String, default: "$0.00" }
      }
    ],

    hourly_stats: [HourlyStatSchema],
    version: { type: Number, default: 4 },
  },
  { timestamps: true }
);

/* =========================
   REQUIRED INDEXES
   ========================= */

// 1️⃣ Single merchant + date (fastest lookup, unique)
DailyReportSchema.index(
  { merchant: 1, date: 1 },
  { unique: true, name: "merchant_date_unique" }
);

// 2️⃣ Admin pages / today-first queries
DailyReportSchema.index(
  { date: 1, merchant: 1 },
  { name: "date_merchant_lookup" }
);

// 3️⃣ Cleanup / SKIP DAILY REPORT
DailyReportSchema.index(
  { date: 1, total_orders: 1 },
  { name: "date_total_orders_cleanup" }
);

// 4️⃣ Latest reports per merchant
DailyReportSchema.index(
  { merchant: 1, computed_at: -1 },
  { name: "merchant_computed_at_desc" }
);

module.exports = mongoose.model("daily_reports", DailyReportSchema);
