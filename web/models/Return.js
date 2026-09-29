const Schema = Mongoose.Schema;

const moneySchema = Schema(
  {
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
  },
  { _id: false }
);

const returnItemSchema = Schema(
  {
    line_item_id: String,
    line_item_graphql_id: String,
    fulfillment_line_item_id: String,
    return_line_item_id: String,
    product_id: String,
    variant_id: String,
    title: String,
    variant_title: String,
    sku: String,
    image_url: String,
    quantity: { type: Number, required: true, min: 1 },
    max_quantity: { type: Number, required: true, min: 1 },
    unit_price: { type: Number, default: 0 },
    reason_code: { type: String, required: true },
    reason_label: String,
    shopify_reason: String,
    customer_note: String,
    photo_urls: [String],
    exchange_product_id: String,
    exchange_product_title: String,
    exchange_product_image_url: String,
    exchange_variant_id: String,
    exchange_variant_title: String,
    exchange_unit_price: Number,
    resolution: {
      type: String,
      enum: ["pending", "refund", "reorder", "store_credit"],
      default: "pending",
    },
    resolved_at: Date,
    disposition: {
      type: String,
      enum: ["RESTOCKED", "NOT_RESTOCKED"],
      default: "RESTOCKED",
    },
  },
  { _id: false }
);

const timelineSchema = Schema(
  {
    status: String,
    label: String,
    detail: String,
    actor: String,
    created_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ReturnSchema = Schema(
  {
    merchant: {
      type: Schema.Types.ObjectId,
      ref: "merchants",
      required: true,
      index: true,
    },
    order: {
      type: Schema.Types.ObjectId,
      ref: "orders",
      required: true,
      index: true,
    },
    shop: { type: String, required: true },
    shopify_order_id: String,
    shopify_return_id: String,
    return_number: { type: String, required: true },
    public_token: { type: String, required: true, unique: true },
    idempotency_key: String,
    status: {
      type: String,
      enum: [
        "requested",
        "needs_review",
        "approved",
        "declined",
        "label_ready",
        "in_transit",
        "received",
        "processed",
        "payment_pending",
        "refunded",
        "exchanged",
        "credited",
        "closed",
        "cancelled",
      ],
      default: "requested",
      index: true,
    },
    outcome: {
      type: String,
      enum: ["refund", "exchange", "store_credit"],
      required: true,
    },
    customer: {
      name: String,
      email: String,
      phone: String,
      address: Schema.Types.Mixed,
      request_ip: String,
      order_ip: String,
    },
    items: { type: [returnItemSchema], required: true },
    subtotal: { type: moneySchema, default: () => ({}) },
    restocking_fee: { type: moneySchema, default: () => ({}) },
    return_shipping_fee: { type: moneySchema, default: () => ({}) },
    refund_total: { type: moneySchema, default: () => ({}) },
    exchange_total: { type: moneySchema, default: () => ({}) },
    store_credit_total: { type: moneySchema, default: () => ({}) },
    revenue_kept: { type: moneySchema, default: () => ({}) },
    policy_snapshot: Schema.Types.Mixed,
    auto_approved: { type: Boolean, default: false },
    review_reason: String,
    decline_reason: String,
    easypost: {
      shipment_id: String,
      rate_id: String,
      carrier: String,
      service: String,
      tracking_code: String,
      tracker_id: String,
      label_url: String,
      label_pdf_url: String,
      qr_code_url: String,
      postage_amount: Number,
      currency: String,
      purchased_at: Date,
      label_expires_at: Date,
    },
    shopify_payload: Schema.Types.Mixed,
    refund_details: Schema.Types.Mixed,
    credit_refund_details: Schema.Types.Mixed,
    gift_card_details: Schema.Types.Mixed,
    gift_card_code: { type: String, select: false },
    refund_operation: Schema.Types.Mixed,
    reorder_details: Schema.Types.Mixed,
    processed_actions: { type: [String], default: () => [] },
    finance_events: { type: [Schema.Types.Mixed], default: () => [] },
    timeline: { type: [timelineSchema], default: () => [] },
    approved_at: Date,
    declined_at: Date,
    received_at: Date,
    processed_at: Date,
    closed_at: Date,
  },
  { timestamps: true, id: false }
);

ReturnSchema.index({ merchant: 1, return_number: 1 }, { unique: true });
ReturnSchema.index({ merchant: 1, order: 1 }, { unique: true });
ReturnSchema.index(
  { merchant: 1, idempotency_key: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotency_key: { $exists: true, $type: "string" },
    },
  }
);
ReturnSchema.index({ merchant: 1, status: 1, createdAt: -1 });
ReturnSchema.index({ merchant: 1, createdAt: -1 });
ReturnSchema.index({ createdAt: -1 });

module.exports = Mongoose.model("returns", ReturnSchema);
