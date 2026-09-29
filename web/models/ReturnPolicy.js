const Schema = Mongoose.Schema;

const reasonSchema = Schema(
  {
    code: { type: String, required: true },
    label: { type: String, required: true },
    shopify_reason: { type: String, required: true },
    requires_photo: { type: Boolean, default: false },
    waive_shipping_fee: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
  },
  { _id: false }
);

const returnAddressSchema = Schema(
  {
    enabled: { type: Boolean, default: false },
    name: String,
    company: String,
    street1: String,
    street2: String,
    city: String,
    state: String,
    zip: String,
    country: String,
    phone: String,
    email: String,
  },
  { _id: false }
);

const ReturnPolicySchema = Schema(
  {
    merchant: {
      type: Schema.Types.ObjectId,
      ref: "merchants",
      required: true,
      unique: true,
    },
    return_window_days: { type: Number, default: 30, min: 1, max: 365 },
    label_expiry_days: { type: Number, default: 14, min: 1, max: 90 },
    restocking_fee_percent: { type: Number, default: 0, min: 0, max: 100 },
    return_shipping_fee: { type: Number, default: 0, min: 0 },
    auto_approve_max: { type: Number, default: 50, min: 0 },
    keep_item_max: { type: Number, default: 12, min: 0 },
    allow_exchanges: { type: Boolean, default: true },
    allow_refunds: { type: Boolean, default: true },
    allow_store_credit: { type: Boolean, default: false },
    protected_orders_only: { type: Boolean, default: false },
    store_credit_bonus: { type: Number, default: 5, min: 0 },
    store_credit_bonus_enabled: { type: Boolean, default: true },
    always_verify_otp: { type: Boolean, default: false },
    otp_value_threshold: { type: Number, default: 250, min: 0 },
    final_sale_tags: { type: [String], default: ["final-sale"] },
    exchange_price_difference_action: {
      type: String,
      enum: ["refund", "store_credit"],
      default: "refund",
    },
    portal_background_image_url: { type: String, default: "" },
    portal_background_image_key: { type: String, default: "" },
    reasons: {
      type: [reasonSchema],
      default: () => [
        {
          code: "too_small",
          label: "Too small",
          shopify_reason: "SIZE_TOO_SMALL",
        },
        {
          code: "too_big",
          label: "Too big",
          shopify_reason: "SIZE_TOO_LARGE",
        },
        {
          code: "damaged",
          label: "Arrived damaged",
          shopify_reason: "DEFECTIVE",
          requires_photo: true,
          waive_shipping_fee: true,
        },
        {
          code: "wrong_item",
          label: "Wrong item",
          shopify_reason: "WRONG_ITEM",
          requires_photo: true,
          waive_shipping_fee: true,
        },
        {
          code: "changed_mind",
          label: "Changed my mind",
          shopify_reason: "UNWANTED",
        },
        {
          code: "other",
          label: "Other",
          shopify_reason: "OTHER",
        },
      ],
    },
    return_address: { type: returnAddressSchema, default: () => ({}) },
  },
  { timestamps: true, id: false }
);

module.exports = Mongoose.model("return_policies", ReturnPolicySchema);
