/**
 * ORDER UPDATE SERVICE
 * --------------------------------------------------
 * - SAME business logic as original webhooks.js
 * - No Express / no router / no globals
 * - Services injected (safe for worker + controller)
 * - 1:1 behavior preserved
 */

const { isDeepStrictEqual } = require("node:util");

const toMoney = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
};

const getLineDiscount = (lineItem = {}) => {
  const allocations = Array.isArray(lineItem.discount_allocations)
    ? lineItem.discount_allocations
    : [];

  if (allocations.length > 0) {
    return allocations
      .reduce((total, allocation) => total + toMoney(allocation?.amount), 0)
      .toFixed(2);
  }

  return toMoney(
    lineItem.discount_total ??
      lineItem.total_discount ??
      lineItem.total_discount_set?.shop_money?.amount
  ).toFixed(2);
};

// ------------------------------------
// Normalize order payload for comparison
// (Only business-critical fields)
// ------------------------------------
const normalizeOrderPayload = (source = {}) => {
  return {
    financial_status: source.financial_status ?? null,

    totals: {
      total_price: String(
        source.total_price ??
        source.total_price_set?.shop_money?.amount ??
        "0"
      ),
      total_line_items_price: String(
        source.total_line_items_price ??
        source.total_line_items_price_set?.shop_money?.amount ??
        "0"
      ),
      total_discounts: String(
        source.total_discounts ??
        source.total_discounts_set?.shop_money?.amount ??
        "0"
      ),
      current_total_price: String(
        source.current_total_price ??
        source.current_total_price_set?.shop_money?.amount ??
        "0"
      ),
      current_subtotal_price: String(
        source.current_subtotal_price ??
        source.current_subtotal_price_set?.shop_money?.amount ??
        "0"
      ),
      current_total_discounts: String(
        source.current_total_discounts ??
        source.current_total_discounts_set?.shop_money?.amount ??
        "0"
      ),
      current_total_tax: String(
        source.current_total_tax ??
        source.current_total_tax_set?.shop_money?.amount ??
        "0"
      ),
    },

    line_items: (source.line_items || [])
      .map((li) => ({
        id: li.id,
        sku: li.sku ?? null,
        quantity: Number(li.quantity ?? 0),
        price: String(
          li.final_sale_price ??
          li.final_price ??
          li.price ??
          "0"
        ),
        discount: getLineDiscount(li),
      }))
      .sort((a, b) => (a.id || 0) - (b.id || 0)),

    refunds: (source.refunds || [])
      .map((r) => ({
        id: r.id,
        amount: String(r.amount ?? "0"),
        line_items: (r.refund_line_items || [])
          .map((item) => ({
            id: item.id ?? item.line_item_id,
            quantity: Number(item.quantity ?? 0),
            subtotal: String(
              item.subtotal ?? item.subtotal_set?.shop_money?.amount ?? "0"
            ),
            tax: String(
              item.total_tax ?? item.total_tax_set?.shop_money?.amount ?? "0"
            ),
          }))
          .sort((a, b) => String(a.id).localeCompare(String(b.id))),
        transactions: (r.transactions || [])
          .map((transaction) => ({
            id: transaction.id,
            kind: transaction.kind ?? null,
            status: transaction.status ?? null,
            amount: String(transaction.amount ?? "0"),
          }))
          .sort((a, b) => String(a.id).localeCompare(String(b.id))),
        adjustments: (r.order_adjustments || [])
          .map((adjustment) => ({
            id: adjustment.id,
            kind: adjustment.kind ?? null,
            amount: String(adjustment.amount ?? "0"),
          }))
          .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      }))
      .sort((a, b) => (a.id || 0) - (b.id || 0)),
  };
};

// --------------------------------------------------
// MAIN BUSINESS FUNCTION (UNCHANGED LOGIC)
// --------------------------------------------------
async function processOrderUpdateUnified({
  payload,
  shop,
  mode = "FULL", // "FULL" | "TAGS_ONLY"
  Services,
}) {
  try {
    const orderId = payload?.order_edit?.order_id || payload?.id;
    if (!orderId || !shop) return;

    /* -------------------------------------------------
       1️⃣ Resolve merchant
    ------------------------------------------------- */
    const merchant = await Services.Merchant.get({ shop_id: shop });
    if (!merchant) return;

    /* -------------------------------------------------
       2️⃣ Resolve existing local order
    ------------------------------------------------- */
    let existingOrder = await Services.Order.get({
      id: orderId,
      merchant: merchant._id,
    });

    // Order not created locally yet — ORDERS_UPDATED should NEVER create orders.
    // Use /v1/datafix/backfill-orders API to manually recover missing orders.
    if (!existingOrder) return;

    /* -------------------------------------------------
       3️⃣ Detect BUSINESS vs TRACKING updates
    ------------------------------------------------- */
    const incomingLineItems = Array.isArray(payload.line_items)
      ? payload.line_items
      : null;
    const storedLineItems = Array.isArray(existingOrder.line_items)
      ? existingOrder.line_items
      : [];

    // Shopify sends the complete line-item snapshot for orders/updated. Compare
    // IDs as well as price, quantity, and allocations so post-purchase apps
    // cannot be mistaken for fulfillment/tracking noise.
    const hasLineItemChange =
      incomingLineItems !== null &&
      (incomingLineItems.length !== storedLineItems.length ||
        incomingLineItems.some((li) => {
          const oldItem = storedLineItems.find(
            (oldLineItem) => String(oldLineItem.id) === String(li.id)
          );

          if (!oldItem) return true;

          return (
            Number(li.current_quantity ?? li.quantity ?? 0) !==
              Number(oldItem.current_quantity ?? oldItem.quantity ?? 0) ||
            toMoney(li.price) !== toMoney(oldItem.price) ||
            getLineDiscount(li) !== getLineDiscount(oldItem)
          );
        }));

    const isRefundUpdate =
      Array.isArray(payload.refunds) && payload.refunds.length > 0;

    // ⛔ ABSOLUTE SKIP: no business mutation
    if (
      !hasLineItemChange &&
      !isRefundUpdate &&
      !payload.order_edit
    ) {
      return;
    }

    /* -------------------------------------------------
       4️⃣ TAGS handling (overwrite, never merge)
    ------------------------------------------------- */
    if (mode === "TAGS_ONLY" || mode === "FULL") {
      const tagsString =
        payload.order_edit?.order?.tags ??
        payload.tags ??
        "";

      const finalTags = tagsString
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const existingTags = Array.isArray(existingOrder.tags)
        ? existingOrder.tags
        : [];

      const tagsChanged =
        JSON.stringify([...existingTags].sort()) !==
        JSON.stringify([...finalTags].sort());

      if (tagsChanged) {
        await Services.Order.findOneAndUpdate(
          { _id: existingOrder._id },
          {
            $set: {
              tags: finalTags,
              updatedAt: new Date(),
            },
          }
        );
      }
    }

    /* -------------------------------------------------
       5️⃣ Detect REMOVED items (Shopify order edit)
    ------------------------------------------------- */
    if (mode === "FULL" && payload.order_edit) {
      const oldLineItems = Array.isArray(existingOrder.line_items)
        ? existingOrder.line_items
        : [];

      const newLineItems = Array.isArray(payload.line_items)
        ? payload.line_items
        : [];

      const removedItems = oldLineItems.filter(
        (oldItem) =>
          !newLineItems.some(
            (newItem) => newItem.id === oldItem.id
          )
      );

      if (removedItems.length > 0) {
        await Services.Order.findOneAndUpdate(
          { _id: existingOrder._id },
          {
            $set: {
              removed_items: removedItems,
              updatedAt: new Date(),
            },
          }
        );
      }
    }

    /* -------------------------------------------------
       6️⃣ FULL ORDER UPDATE (business-only diff)
    ------------------------------------------------- */
    if (mode === "FULL") {
      const oldData = normalizeOrderPayload(existingOrder);
      const newData = normalizeOrderPayload(payload);

      if (isDeepStrictEqual(oldData, newData)) {
        return;
      }

      await Services.Order.updateOrderDetails(payload, shop);
    }
  } catch (error) {
    await Services.WebhookError.handle({
      webhook_error:
        error instanceof Error
          ? error.message
          : JSON.stringify(error),
      webhook_payload: payload,
      webhook_name: "processOrderUpdateUnified",
      shop_domain: shop || "Unknown Shop",
    });
  }
}

module.exports = {
  getLineDiscount,
  normalizeOrderPayload,
  processOrderUpdateUnified,
};
