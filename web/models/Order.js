const Mongoose = require("mongoose");
const Schema = Mongoose.Schema;

const priceSet = Schema(
  {
    shop_money: {
      amount: String,
      currency_code: String,
    },
    presentment_money: {
      amount: String,
      currency_code: String,
    },
  },
  { _id: false }
);

const taxLines = Schema(
  {
    channel_liable: Boolean,
    price: String,
    price_set: priceSet,
    rate: Number,
    title: String,
  },
  { _id: false }
);

const address = Schema(
  {
    first_name: String,
    last_name: String,
    name: String,
    phone: String,
    address1: String,
    address2: String,
    city: String,
    zip: String,
    province: String,
    country: String,
    latitude: String,
    longitude: String,
    country_code: String,
    province_code: String,
  },
  { _id: false }
);

const lineItem = Schema(
  {
    id: Number,
    admin_graphql_api_id: String,
    fulfillable_quantity: Number,
    fulfillment_service: String,
    fulfillment_status: String,
    gift_card: Boolean,
    grams: Number,
    name: String,
    price: String,
    price_set: priceSet,
    product_exists: Boolean,
    product_id: Number,
    quantity: Number,
    sku: String,
    taxable: Boolean,
    title: String,
    total_discount: String,
    total_discount_set: priceSet,
    image_url: String,
    variant_id: Number,
    variant_inventory_management: String,
    variant_title: String,
    selling_plan_name: String,
    vendor: String,
    tax_lines: [taxLines],
    properties: [Schema.Types.Mixed],
    final_price: String,

    // 🔹 Added fields for accurate discount tracking
    discount_total: String,        // Sum of discount_allocations
    final_sale_price: String,      // price - discount_total (per line)
  },
  { _id: false }
);

const discountCombinesWith = Schema(
  {
    order_discounts: { type: Boolean, default: false },
    product_discounts: { type: Boolean, default: false },
    shipping_discounts: { type: Boolean, default: false },
  },
  { _id: false }
);

const discountCodeSchema = Schema(
  {
    code: String,
    amount: String,
    type: String,
    combines_with: discountCombinesWith,
  },
  { _id: false }
);

const discountApplicationSchema = Schema(
  {
    type: String,
    title: String,
    description: String,
    value: String,
    value_type: String,
    allocation_method: String,
    target_selection: String,
    target_type: String,
  },
  { _id: false }
);

const OrderSchema = Schema(
  {
    merchant: {
      type: Schema.Types.ObjectId,
      ref: "merchants",
    },
    iana_timezone: { type: String, default: "America/Chicago" },
    id: Number,
    admin_graphql_api_id: String,
    name: String,
    number: Number,
    order_number: Number,
    tags: [String],
    tax_lines: [taxLines],
    token: String,
    app_id: Number,
    cancel_reason: String,
    cancelled_at: String,
    checkout_id: Number,
    checkout_token: String,
    currency: String,
    total_price: String,
    final_total_price: String,
    total_price_set: priceSet,
    current_total_price: String,
    current_subtotal_price: String,
    current_total_discounts: String,
    current_total_tax: String,
    total_tax: String,
    tracking_id: String,
    total_discounts: String,
    total_discounts_set: priceSet,
    total_line_items_price: String,
    total_line_items_price_set: priceSet,
    total_shipping_price_set: priceSet,
    total_tax_set: priceSet,
    total_weight: Number,
    user_id: Number,
    order_created_at: Date,
    billing_address: address,
    customer: {
      id: Number,
      name: String,
       email: {
  type: String,
  trim: true,
  set: function (v) {
    return typeof v === "string" ? v.toLowerCase().trim() : v;
  },
},
      first_name: String,
      last_name: String,
      phone: String,
      admin_graphql_api_id: String,
      customer_created_at: Date,
      state: String,
      verified_email: Boolean,
      tags: String,
      currency: String,
    },
    customer_locale: String,
    discount_codes: [discountCodeSchema],
    discount_applications: [discountApplicationSchema],
    financial_status: String,
    payment_gateway_names: [String],
    presentment_currency: String,
    processed_at: Date,
    reference: String,
    source_identifier: String,
    line_items: [lineItem],
    refunds: [Schema.Types.Mixed],
    shipping_address: address,
    shipping_lines: [Schema.Types.Mixed],
    tracking_company: String,
    tracking_number: String,
    tracking_numbers: [String],
    tracking_url: String,
    tracking_urls: [String],
    fulfillments: [Schema.Types.Mixed],
    is_invoiced: { type: Boolean, default: false },
    protection_amount: String,
    protection_item: {
      id: Number,
      name: String,
      title: String,
      admin_graphql_api_id: String,
      price: String,
      product_id: Number,
      variant_id: Number,
    },
    is_protected: { type: Boolean, default: false },
    is_claim_created: { type: Boolean, default: false },
    refund_amount: String,
    reorder_amount: String,
    claim_resolve_with: String,
    browser_ip: String,
    is_subscription: { type: Boolean, default: false },
    subscription_plan: { type: String, default: "" },

    final_total_sale: String,  

    tracking_status: {
      type: String,
      enum: [
        "unfulfilled",
        "fulfilled",
        "pre_transit",
        "available_for_pickup",
        "return_to_sender",
        "failure",
        "cancelled",
        "in_transit",
        "out_for_delivery",
        "delivered",
      ],
    },
  },
  {
    timestamps: true,
    id: false,
    toObject: { virtuals: true, getters: true },
    toJSON: { virtuals: true, getters: true },
  }
);

// =====================================================
// INDEXES (minimal + aligned with actual query patterns)
// =====================================================

// 0) CRITICAL: Prevent duplicate local orders for the same merchant + Shopify order id.
//    Also accelerates all webhook update paths that query by { merchant, id }.
OrderSchema.index(
  { merchant: 1, id: 1 },
  {
    unique: true,
    name: "uniq_merchant_shopify_id",
    // Safety: allow legacy/partial docs (if any) that are missing merchant/id
    // while still enforcing uniqueness for real orders.
    partialFilterExpression: {
      merchant: { $exists: true, $ne: null },
      id: { $exists: true, $ne: null },
    },
  }
);

OrderSchema.index(
  { merchant: 1, is_protected: 1, order_created_at: -1 },
  { name: "merchant_protected_created_idx" }
);

// 1) Generic merchant + order date access (used by hourly/daily stats that don't filter is_protected)
OrderSchema.index(
  { merchant: 1, order_created_at: -1 },
  { name: "merchant_created_idx" }
);

// 1b) Admin/merchant order detail uses previous/next navigation on Mongo createdAt.
//     This supports queries like:
//     { merchant, createdAt: { $gt/$lt: date } } + sort({ createdAt: 1/-1 })
OrderSchema.index(
  { merchant: 1, createdAt: -1 },
  { name: "merchant_mongo_created_idx" }
);

OrderSchema.index(
  { merchant: 1, is_subscription: 1, createdAt: -1 },
  { name: "merchant_subscription_created_idx" }
);

// 2) Daily report: quickly fetch orders that had a refund processed in a given window.
//    NOTE: Separate index is required because Mongo can't efficiently use an index where
//    order_created_at sits between merchant/is_protected and refunds.processed_at.
OrderSchema.index(
  { merchant: 1, is_protected: 1, "refunds.processed_at": 1 },
  { name: "merchant_protected_refunds_processed_idx" }
);
// Full email lookup, followed by counts/results using the existing simple index.
OrderSchema.index(
  { "customer.email": 1 },
  { name: "order_email_case_insensitive_idx", collation: { locale: "en", strength: 2 } }
);
OrderSchema.index(
  { "customer.email": 1, order_number: 1 },
  { name: "customer.email_1_order_number_1" }
);
module.exports = Mongoose.model("orders", OrderSchema);
