const DEFAULT_CURRENCY = "USD";

const assertReturnProtection = (order, policy) => {
  if (policy?.protected_orders_only !== true) return;
  const hasProtection =
    order?.is_protected === true ||
    Boolean(order?.protection_item?.id) ||
    (order?.line_items || []).some((item) =>
      String(item.title || "").toLowerCase().includes("swipe package protection") ||
      String(item.sku || "").toLowerCase() === "swipe"
    );
  if (!hasProtection) {
    const error = new Error(
      "This store only accepts returns for orders with Swipe Package Protection. Your order does not include Swipe Package Protection."
    );
    error.status = 403;
    throw error;
  }
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const roundMoney = (value) =>
  Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;

const normalizeOrderNumber = (value) =>
  String(value || "")
    .trim()
    .replace(/^#/, "");

const normalizePostcode = (value) =>
  String(value || "")
    .trim()
    .replace(/[\s-]/g, "")
    .toUpperCase();

const normalizeShopifyResourceId = (value) =>
  String(value || "")
    .trim()
    .split("/")
    .pop();

const validateExchangeVariant = (item, requestedVariantId, quantity = 1) => {
  const variants = Array.isArray(item?.exchange_variants)
    ? item.exchange_variants
    : [];
  const availableVariants = variants.length
    ? variants
    : item?.variant_id
    ? [
        {
          id: item.variant_id,
          title: item.variant_title || "Standard",
          variant_title: item.variant_title || "",
          sku: item.sku || "",
          unit_price: Number(item.unit_price || 0),
          image_url: item.image_url || "",
          selected_options: [],
          inventory_quantity: null,
          inventory_tracked: false,
          inventory_policy: "CONTINUE",
          available: true,
        },
      ]
    : [];
  const targetId = requestedVariantId || item?.variant_id;
  const variant = availableVariants.find(
    (candidate) =>
      normalizeShopifyResourceId(candidate?.id) ===
      normalizeShopifyResourceId(targetId)
  );

  if (!variant) {
    return { error: "Choose a valid exchange size or color." };
  }
  if (variant.available === false) {
    return { error: "The selected exchange option is out of stock." };
  }

  const requestedQuantity = Math.max(1, Number(quantity) || 1);
  const inventoryQuantity = Number(variant.inventory_quantity || 0);
  const inventoryTracked = variant.inventory_tracked === true;
  const inventoryPolicy = String(variant.inventory_policy || "DENY");
  if (
    inventoryTracked &&
    inventoryPolicy !== "CONTINUE" &&
    inventoryQuantity < requestedQuantity
  ) {
    return { error: "There is not enough stock for the selected exchange option." };
  }

  return { variant };
};

const verifyOrderIdentity = (order, emailOrPostcode) => {
  const submitted = String(emailOrPostcode || "").trim();
  if (!submitted) return false;

  const submittedEmail = submitted.toLowerCase();
  const orderEmail = String(order?.customer?.email || "").trim().toLowerCase();
  if (orderEmail && submittedEmail === orderEmail) return true;

  const submittedPostcode = normalizePostcode(submitted);
  const postcodes = [
    order?.shipping_address?.zip,
    order?.billing_address?.zip,
  ]
    .map(normalizePostcode)
    .filter(Boolean);

  return postcodes.includes(submittedPostcode);
};

const getDeliveredAt = (order) => {
  const fulfillmentDates = (Array.isArray(order?.fulfillments)
    ? order.fulfillments
    : []
  )
    .map(
      (fulfillment) =>
        fulfillment?.delivered_at ||
        fulfillment?.updated_at ||
        fulfillment?.created_at
    )
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()));

  if (fulfillmentDates.length) {
    return new Date(Math.max(...fulfillmentDates.map((value) => value.getTime())));
  }

  const fallback = order?.processed_at || order?.order_created_at || order?.createdAt;
  const date = fallback ? new Date(fallback) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

const isOrderDelivered = (order) => {
  if (String(order?.tracking_status || "").toLowerCase() === "delivered") {
    return true;
  }

  return (Array.isArray(order?.fulfillments) ? order.fulfillments : []).some(
    (fulfillment) => {
      const status = String(
        fulfillment?.shipment_status || fulfillment?.status || ""
      ).toLowerCase();
      return status === "delivered" || Boolean(fulfillment?.delivered_at);
    }
  );
};

const hasFinalSaleMarker = (lineItem, policy, order) => {
  const finalSaleTags = (policy?.final_sale_tags || [])
    .map((tag) => String(tag).trim().toLowerCase())
    .filter(Boolean);
  const orderTags = (Array.isArray(order?.tags) ? order.tags : [])
    .map((tag) => String(tag).trim().toLowerCase())
    .filter(Boolean);

  if (orderTags.some((tag) => finalSaleTags.includes(tag))) return true;

  return (Array.isArray(lineItem?.properties) ? lineItem.properties : []).some(
    (property) => {
      const name = String(property?.name || property?.key || "").toLowerCase();
      const value = String(property?.value || "").toLowerCase();
      return (
        name.includes("final_sale") ||
        name.includes("final-sale") ||
        value === "final_sale" ||
        value === "final-sale" ||
        value === "true" && name.includes("final")
      );
    }
  );
};

const buildReturnableItems = (order, policy, now = new Date()) => {
  const deliveredAt = getDeliveredAt(order);
  const delivered = isOrderDelivered(order);
  const windowDays = Math.max(1, Number(policy?.return_window_days) || 30);
  const windowEndsAt = deliveredAt
    ? new Date(deliveredAt.getTime() + windowDays * 24 * 60 * 60 * 1000)
    : null;
  const daysLeft = windowEndsAt
    ? Math.max(
        0,
        Math.ceil((windowEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      )
    : 0;
  const windowOpen = Boolean(windowEndsAt && windowEndsAt >= now);

  const items = (Array.isArray(order?.line_items) ? order.line_items : [])
    .filter((item) => item && item.id)
    .filter((item) => {
      const title = String(item.title || item.name || "").toLowerCase();
      const sku = String(item.sku || "").toLowerCase();
      return !title.includes("swipe package protection") && sku !== "swipe";
    })
    .map((item) => {
      const finalSale = hasFinalSaleMarker(item, policy, order);
      const availableQuantity = Math.max(
        0,
        Number(item.current_quantity ?? item.quantity ?? 0)
      );
      let ineligibleReason = null;

      if (!delivered) ineligibleReason = "Order has not been delivered";
      else if (!windowOpen) ineligibleReason = "Return window has closed";
      else if (finalSale) ineligibleReason = "Final sale";
      else if (!availableQuantity) ineligibleReason = "No quantity available";

      return {
        line_item_id: String(item.id),
        line_item_graphql_id:
          item.admin_graphql_api_id || `gid://shopify/LineItem/${item.id}`,
        fulfillment_line_item_id: item.fulfillment_line_item_id || null,
        product_id: item.product_id ? String(item.product_id) : null,
        variant_id: item.variant_id ? String(item.variant_id) : null,
        title: item.title || item.name || "Item",
        variant_title: item.variant_title || "",
        sku: item.sku || "",
        image_url: item.image_url || "",
        unit_price: roundMoney(item.final_price || item.price),
        max_quantity: availableQuantity,
        eligible: !ineligibleReason,
        ineligible_reason: ineligibleReason,
      };
    });

  return {
    delivered,
    delivered_at: deliveredAt,
    window_ends_at: windowEndsAt,
    days_left: daysLeft,
    items,
  };
};

const calculateReturnSummary = ({ items, outcome, policy, currency }) => {
  const selectedItems = Array.isArray(items) ? items : [];
  const subtotal = roundMoney(
    selectedItems.reduce(
      (sum, item) =>
        sum + toNumber(item.unit_price) * Math.max(1, Number(item.quantity) || 1),
      0
    )
  );
  const waiveShippingFee = selectedItems.some(
    (item) => item.waive_shipping_fee === true
  );
  const restockingFee = roundMoney(
    subtotal * (Math.max(0, toNumber(policy?.restocking_fee_percent)) / 100)
  );
  const returnShippingFee = waiveShippingFee
    ? 0
    : roundMoney(policy?.return_shipping_fee);
  const refundTotal = roundMoney(
    Math.max(0, subtotal - restockingFee - returnShippingFee)
  );
  const exchangeTotal = roundMoney(
    selectedItems.reduce(
      (sum, item) =>
        sum +
        toNumber(item.exchange_unit_price) *
          Math.max(1, Number(item.quantity) || 1),
      0
    )
  );
  const storeCreditTotal = roundMoney(
    refundTotal + (outcome === "store_credit" && policy?.store_credit_bonus_enabled !== false
      ? toNumber(policy?.store_credit_bonus) : 0)
  );
  const revenueKept = roundMoney(
    outcome === "refund" ? subtotal - refundTotal : subtotal
  );

  return {
    currency: currency || DEFAULT_CURRENCY,
    subtotal,
    restocking_fee: restockingFee,
    return_shipping_fee: returnShippingFee,
    refund_total: refundTotal,
    exchange_total: exchangeTotal,
    store_credit_total: storeCreditTotal,
    revenue_kept: revenueKept,
    keep_item: subtotal <= Math.max(0, toNumber(policy?.keep_item_max)),
  };
};

const calculateExchangeAdjustment = ({ items, replacementItems }) => {
  const returned = Array.isArray(items) ? items : [];
  const replacements = Array.isArray(replacementItems) ? replacementItems : [];
  const returnCredit = roundMoney(
    returned.reduce(
      (sum, item) =>
        sum + toNumber(item.unit_price) * Math.max(1, Number(item.quantity) || 1),
      0
    )
  );
  const replacementTotal = roundMoney(
    replacements.reduce(
      (sum, item) =>
        sum +
        toNumber(item.replacement_unit_price) *
          Math.max(1, Number(item.quantity) || 1),
      0
    )
  );
  const creditApplied = roundMoney(Math.min(returnCredit, replacementTotal));

  return {
    return_credit: returnCredit,
    replacement_total: replacementTotal,
    credit_applied: creditApplied,
    amount_due: roundMoney(Math.max(0, replacementTotal - returnCredit)),
    credit_due: roundMoney(Math.max(0, returnCredit - replacementTotal)),
  };
};

const allocateRefundTransactions = (transactions, requestedAmount) => {
  const rows = Array.isArray(transactions) ? transactions : [];
  const refundedByParent = rows.reduce((map, transaction) => {
    if (
      String(transaction?.kind || "").toLowerCase() === "refund" &&
      String(transaction?.status || "").toLowerCase() === "success" &&
      transaction?.parent_id
    ) {
      const key = String(transaction.parent_id);
      map[key] = roundMoney((map[key] || 0) + toNumber(transaction.amount));
    }
    return map;
  }, {});
  const sources = rows.filter(
    (transaction) =>
      ["sale", "capture"].includes(
        String(transaction?.kind || "").toLowerCase()
      ) && String(transaction?.status || "").toLowerCase() === "success"
  );
  const available = roundMoney(
    sources.reduce(
      (sum, transaction) =>
        sum +
        Math.max(
          0,
          toNumber(transaction.amount) -
            toNumber(refundedByParent[String(transaction.id)])
        ),
      0
    )
  );
  let remaining = roundMoney(requestedAmount);
  const allocations = [];

  for (const transaction of sources) {
    if (remaining <= 0) break;
    const refundable = roundMoney(
      Math.max(
        0,
        toNumber(transaction.amount) -
          toNumber(refundedByParent[String(transaction.id)])
      )
    );
    if (!refundable) continue;
    const amount = roundMoney(Math.min(refundable, remaining));
    allocations.push({
      parent_id: transaction.id,
      amount: amount.toFixed(2),
      kind: "refund",
      gateway: transaction.gateway,
    });
    remaining = roundMoney(remaining - amount);
  }

  return { allocations, available, remaining };
};

module.exports = {
  assertReturnProtection,
  normalizeOrderNumber,
  normalizePostcode,
  normalizeShopifyResourceId,
  validateExchangeVariant,
  verifyOrderIdentity,
  buildReturnableItems,
  calculateReturnSummary,
  calculateExchangeAdjustment,
  allocateRefundTransactions,
  roundMoney,
};
