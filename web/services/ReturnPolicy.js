const ReturnPolicySchema = Models.ReturnPolicy;

const ReturnPolicy = {};

const BOOLEAN_FIELDS = [
  "allow_exchanges",
  "allow_refunds",
  "allow_store_credit",
  "store_credit_bonus_enabled",
  "protected_orders_only",
  "always_verify_otp",
];
const NUMBER_FIELDS = [
  "return_window_days",
  "label_expiry_days",
  "restocking_fee_percent",
  "return_shipping_fee",
  "auto_approve_max",
  "keep_item_max",
  "store_credit_bonus",
  "otp_value_threshold",
];
const STRING_FIELDS = ["exchange_price_difference_action"];

const normalizePolicyUpdate = (payload = {}) => {
  const update = {};

  BOOLEAN_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      update[field] = payload[field] === true || payload[field] === "true";
    }
  });
  NUMBER_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      const value = Number(payload[field]);
      if (Number.isFinite(value)) update[field] = value;
    }
  });
  STRING_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      update[field] = String(payload[field] || "").trim();
    }
  });

  if (Array.isArray(payload.final_sale_tags)) {
    update.final_sale_tags = payload.final_sale_tags
      .map((value) => String(value).trim())
      .filter(Boolean);
  }
  if (Array.isArray(payload.reasons)) {
    update.reasons = payload.reasons
      .map((reason) => ({
        code: String(reason.code || "").trim(),
        label: String(reason.label || "").trim(),
        shopify_reason: String(reason.shopify_reason || "OTHER").trim(),
        requires_photo: Boolean(reason.requires_photo),
        waive_shipping_fee: Boolean(reason.waive_shipping_fee),
        enabled: reason.enabled !== false,
      }))
      .filter((reason) => reason.code && reason.label);
  }
  if (payload.return_address && typeof payload.return_address === "object") {
    const allowedAddressFields = [
      "enabled",
      "name",
      "company",
      "street1",
      "street2",
      "city",
      "state",
      "zip",
      "country",
      "phone",
      "email",
    ];
    update.return_address = {};
    allowedAddressFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(payload.return_address, field)) {
        update.return_address[field] =
          field === "enabled"
            ? payload.return_address[field] === true || payload.return_address[field] === "true"
            : String(payload.return_address[field] || "").trim();
      }
    });
  }

  return update;
};

ReturnPolicy.get = async (condition, projection = {}, options = { lean: true }) =>
  ReturnPolicySchema.findOne(condition, projection, options);

ReturnPolicy.getOrCreate = async (merchantId) => {
  const existing = await ReturnPolicy.get({ merchant: merchantId });
  if (existing) return existing;
  const created = await new ReturnPolicySchema({ merchant: merchantId }).save();
  return created.toObject();
};

ReturnPolicy.update = async (merchantId, payload) => {
  if (Object.prototype.hasOwnProperty.call(payload, "store_credit_bonus") &&
      (!Number.isFinite(Number(payload.store_credit_bonus)) || Number(payload.store_credit_bonus) < 0)) {
    throw Object.assign(new Error("Enter a bonus amount of 0 or more."), { status: 400 });
  }
  const current = await ReturnPolicy.getOrCreate(merchantId);
  const update = normalizePolicyUpdate(payload);
  if (update.return_address) {
    const address = { ...current.return_address, ...update.return_address };
    if (address.country) address.country = address.country.toUpperCase();
    if (address.enabled) {
      if (["name", "street1", "city", "zip", "country"].some((key) => !String(address[key] || "").trim())) {
        throw Object.assign(new Error("Complete the required return address fields before saving."), { status: 400 });
      }
      if (!/^[A-Z]{2}$/.test(address.country)) {
        throw Object.assign(new Error("Enter a two-letter country code, such as US, CA or GB."), { status: 400 });
      }
    }
    update.return_address = address;
  }
  return ReturnPolicySchema.findOneAndUpdate(
    { merchant: merchantId },
    { $set: update },
    { new: true, runValidators: true, lean: true }
  );
};

ReturnPolicy.toPublic = (policy) => ({
  return_window_days: policy.return_window_days,
  label_expiry_days: policy.label_expiry_days,
  keep_item_max: policy.keep_item_max,
  allow_exchanges: policy.allow_exchanges,
  allow_refunds: policy.allow_refunds,
  allow_store_credit: policy.allow_store_credit,
  protected_orders_only: policy.protected_orders_only === true,
  store_credit_bonus: policy.store_credit_bonus_enabled === false ? 0 : policy.store_credit_bonus,
  store_credit_bonus_enabled: policy.store_credit_bonus_enabled !== false,
  restocking_fee_percent: policy.restocking_fee_percent,
  return_shipping_fee: policy.return_shipping_fee,
  portal_background_image_url: policy.portal_background_image_url || "",
  reasons: (policy.reasons || []).filter((reason) => reason.enabled !== false),
});

ReturnPolicy.normalizePolicyUpdate = normalizePolicyUpdate;

module.exports = ReturnPolicy;
