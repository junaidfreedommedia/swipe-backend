const toMoney = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
};

const roundMoney = (value) => Number(toMoney(value).toFixed(2));

const firstDefined = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== "");

const getTransactionAmount = (transactions = [], kinds = []) =>
  transactions
    .filter(
      (transaction) =>
        kinds.includes(String(transaction?.kind || "").toLowerCase()) &&
        String(transaction?.status || "").toLowerCase() === "success"
    )
    .reduce((total, transaction) => total + toMoney(transaction?.amount), 0);

const getRefundDetails = (refunds = [], lineItems = []) => {
  let amount = 0;
  let itemCount = 0;
  const reasons = [];

  for (const refund of Array.isArray(refunds) ? refunds : []) {
    const refundLineItems = Array.isArray(refund?.refund_line_items)
      ? refund.refund_line_items
      : [];
    const refundTransactions = Array.isArray(refund?.transactions)
      ? refund.transactions
      : [];

    itemCount += refundLineItems.reduce(
      (total, item) => total + Math.max(0, toMoney(item?.quantity)),
      0
    );

    const transactionAmount = getTransactionAmount(refundTransactions, [
      "refund",
    ]);

    if (transactionAmount > 0) {
      // A successful Shopify refund transaction already includes refunded
      // product, tax, and shipping amounts, so it is the authoritative value.
      amount += transactionAmount;
    } else {
      const lineAmount = refundLineItems.reduce(
        (total, item) =>
          total + toMoney(item?.subtotal) + toMoney(item?.total_tax),
        0
      );
      const adjustmentAmount = (refund?.order_adjustments || []).reduce(
        (total, adjustment) => total + Math.abs(toMoney(adjustment?.amount)),
        0
      );
      amount += lineAmount + adjustmentAmount;
    }

    const reason = String(refund?.note || refund?.reason || "").trim();
    if (reason) reasons.push(reason);
  }

  if (itemCount === 0 && amount > 0) {
    itemCount = (Array.isArray(lineItems) ? lineItems : []).filter((item) => {
      const title = String(item?.title || item?.name || "").toLowerCase();
      const isProtection = title.includes("swipe package protection");
      return !isProtection && (item?.refunded || Number(item?.quantity) === 0);
    }).length;
  }

  return {
    amount: roundMoney(amount),
    itemCount,
    reason: reasons.join(", ") || "No reason provided",
  };
};

const getShippingPrice = (order = {}) => {
  const originalShipping = toMoney(
    firstDefined(
      order?.shipping_lines?.[0]?.price,
      order?.total_shipping_price_set?.shop_money?.amount,
      order?.total_shipping_price_set?.presentment_money?.amount
    )
  );

  const refundedShipping = (order?.refunds || []).reduce(
    (refundTotal, refund) =>
      refundTotal +
      (refund?.order_adjustments || []).reduce((adjustmentTotal, adjustment) => {
        if (adjustment?.kind !== "shipping_refund") return adjustmentTotal;
        return adjustmentTotal + Math.abs(toMoney(adjustment?.amount));
      }, 0),
    0
  );

  return roundMoney(Math.max(0, originalShipping - refundedShipping));
};

const buildOrderPriceSummary = (order = {}, displayOrder = order) => {
  const source = { ...order, ...displayOrder };
  const shopifySummary =
    order?.shopify_price_summary ||
    displayOrder?.shopify_price_summary ||
    {};
  const lineItems = Array.isArray(displayOrder?.line_items)
    ? displayOrder.line_items
    : order?.line_items || [];
  const refunds = Array.isArray(order?.refunds)
    ? order.refunds
    : displayOrder?.refunds || [];
  const refund = getRefundDetails(refunds, lineItems);

  const capturedAmount = getTransactionAmount(
    displayOrder?.transactions || order?.transactions || [],
    ["sale", "capture"]
  );
  const originalOrderAmount = roundMoney(
    firstDefined(
      shopifySummary?.original_order_amount,
      order?.total_price,
      displayOrder?.total_price,
      order?.total_price_set?.shop_money?.amount,
      displayOrder?.total_price_set?.shop_money?.amount,
      capturedAmount
    )
  );
  const paidAmount = roundMoney(
    firstDefined(
      shopifySummary?.paid_amount,
      capturedAmount || undefined,
      originalOrderAmount
    )
  );

  const currentTotalValue = firstDefined(
    shopifySummary?.total_amount,
    order?.current_total_price,
    displayOrder?.current_total_price
  );
  const totalAmount = roundMoney(
    currentTotalValue !== undefined
      ? currentTotalValue
      : Math.max(0, paidAmount - refund.amount)
  );
  // After multiple order edits Shopify can keep the historical refund
  // transactions (for example, $130.14 removed first) while a later edit adds
  // value back to the order. Its summary then shows the net difference between
  // Paid and the authoritative current total (for example, $65.07), not the
  // historical refund transaction total. Mirror that behaviour here.
  const hasRefund =
    refund.amount > 0 ||
    ["refunded", "partially_refunded"].includes(
      String(source?.financial_status || "").toLowerCase()
    );
  const refundedAmount = roundMoney(
    currentTotalValue !== undefined && hasRefund
      ? Math.max(0, paidAmount - totalAmount)
      : refund.amount
  );
  const netPayment = roundMoney(Math.max(0, paidAmount - refundedAmount));

  const subtotalAmount = roundMoney(
    firstDefined(
      shopifySummary?.subtotal_amount,
      order?.current_subtotal_price,
      displayOrder?.current_subtotal_price,
      displayOrder?.final_total_price,
      displayOrder?.subtotal,
      totalAmount
    )
  );
  const discountAmount = roundMoney(
    firstDefined(
      shopifySummary?.discount_amount,
      order?.current_total_discounts,
      displayOrder?.current_total_discounts,
      order?.total_discounts,
      displayOrder?.total_discounts,
      0
    )
  );
  const taxAmount = roundMoney(
    firstDefined(
      shopifySummary?.tax_amount,
      order?.current_total_tax,
      displayOrder?.current_total_tax,
      order?.total_tax,
      displayOrder?.total_tax,
      0
    )
  );
  const itemCount = Math.max(
    0,
    toMoney(
      firstDefined(
        shopifySummary?.item_count,
        lineItems.reduce(
          (total, item) =>
            total +
            Math.max(0, toMoney(item?.current_quantity ?? item?.quantity)),
          0
        )
      )
    )
  );
  const discountCodes = (source?.discount_codes || [])
    .map((discount) => String(discount?.code || "").trim())
    .filter(Boolean);

  return {
    status: shopifySummary?.status || source?.financial_status || "paid",
    original_order_date:
      shopifySummary?.created_at ||
      order?.created_at ||
      order?.order_created_at ||
      source?.created_at ||
      source?.order_created_at ||
      source?.createdAt ||
      null,
    original_order_amount: originalOrderAmount,
    subtotal_amount: subtotalAmount,
    item_count: itemCount,
    discount_label: discountCodes.join(", ") || "Discount",
    discount_amount: discountAmount,
    shipping_amount: roundMoney(
      firstDefined(shopifySummary?.shipping_amount, getShippingPrice(source))
    ),
    tax_amount: taxAmount,
    total_amount: totalAmount,
    paid_amount: paidAmount,
    refunded_amount: refundedAmount,
    refunded_item_count: refund.itemCount,
    refund_reason: refund.reason,
    net_payment: netPayment,
  };
};

module.exports = {
  buildOrderPriceSummary,
  getRefundDetails,
};
