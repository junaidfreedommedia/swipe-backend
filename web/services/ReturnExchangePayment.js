const shopify = require("../shopify.js");
const { eventsFromDetails } = require("../utils/returnFinance");

const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const normalizeShopifyId = (value) => {
  const match = String(value || "").match(/(\d+)$/);
  return match ? Number(match[1]) : null;
};

const buildShopifyAddress = (address) => {
  if (!address) return undefined;
  return {
    first_name: address.first_name,
    last_name: address.last_name,
    name: address.name,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    province: address.province,
    country: address.country,
    zip: address.zip,
    phone: address.phone,
  };
};

const frontendUrl = (publicToken, state) => {
  const baseUrl = String(process.env.FE_HOST || Config.get("APP").FE_HOST || "")
    .trim()
    .replace(/\/$/, "");
  if (!baseUrl) {
    const error = new Error(
      "Customer portal URL is not configured. Add FE_HOST to the backend environment."
    );
    error.status = 503;
    throw error;
  }
  return `${baseUrl}/returns/status/${encodeURIComponent(publicToken)}?payment=${state}`;
};

const toStripeAmount = (amount, currency) => {
  const code = String(currency || "USD").toUpperCase();
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(code) ? 1 : 100;
  const value = Math.round(Number(amount || 0) * multiplier);
  if (!Number.isSafeInteger(value) || value < 1) {
    const error = new Error("The remaining exchange amount is not valid for payment.");
    error.status = 400;
    throw error;
  }
  return value;
};

const createCheckoutSession = async ({
  record,
  customerEmail,
  amountDue,
  currency,
}) => {
  const returnId = String(record._id);
  return StripeAPI.checkoutSessionCreate(
    {
      mode: "payment",
      customer_email: customerEmail,
      client_reference_id: returnId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: String(currency || "USD").toLowerCase(),
            unit_amount: toStripeAmount(amountDue, currency),
            product_data: {
              name: `Exchange balance for return ${record.return_number}`,
              description: "Remaining amount after applying the returned item credit",
            },
          },
        },
      ],
      metadata: {
        return_id: returnId,
        return_number: String(record.return_number),
        shop: String(record.shop),
      },
      payment_intent_data: {
        metadata: {
          return_id: returnId,
          return_number: String(record.return_number),
        },
      },
      success_url: frontendUrl(record.public_token, "success"),
      cancel_url: frontendUrl(record.public_token, "cancelled"),
    },
    { idempotencyKey: `return-${returnId}-exchange-balance` }
  );
};

const getShopifySession = async (shop) => {
  const session = await Services.ShopifySession.get({ shop });
  if (!session) {
    const error = new Error("Shopify session not found. Reconnect this store and try again.");
    error.status = 409;
    throw error;
  }
  return session;
};

const updateResolvedItems = async (recordId, selections) => {
  for (const selection of selections) {
    await Models.Return.updateOne(
      { _id: recordId },
      {
        $set: {
          "items.$[item].resolution": "reorder",
          "items.$[item].resolved_at": new Date(),
          "items.$[item].exchange_product_id": String(
            selection.replacement_product_id || ""
          ),
          "items.$[item].exchange_product_title":
            selection.replacement_product_title || "Replacement",
          "items.$[item].exchange_product_image_url":
            selection.replacement_product_image_url || "",
          "items.$[item].exchange_variant_id": String(
            selection.replacement_variant_id || ""
          ),
          "items.$[item].exchange_variant_title":
            selection.replacement_variant_title || "Replacement",
          "items.$[item].exchange_unit_price": Number(
            selection.replacement_unit_price || 0
          ),
        },
      },
      { arrayFilters: [{ "item.line_item_id": String(selection.line_item_id) }] }
    );
  }
};

const assertCheckoutMatchesRecord = (record, checkoutSession) => {
  const details = record?.reorder_details || {};
  const expectedSessionId = String(details.stripe_checkout_session_id || "");
  const expectedCurrency = String(details.currency || "USD").toLowerCase();
  const expectedAmount = toStripeAmount(details.amount_due, expectedCurrency);
  if (
    String(checkoutSession?.id || "") !== expectedSessionId ||
    String(checkoutSession?.currency || "").toLowerCase() !== expectedCurrency ||
    Number(checkoutSession?.amount_total) !== expectedAmount
  ) {
    const error = new Error("Stripe checkout does not match this return payment.");
    error.status = 409;
    throw error;
  }
};

const finalizePaidReplacement = async (record, checkoutSession) => {
  if (!record || record.reorder_details?.payment_status === "paid") return record;
  assertCheckoutMatchesRecord(record, checkoutSession);

  const staleBefore = new Date(Date.now() - PROCESSING_TIMEOUT_MS);
  const paidAt = record.reorder_details?.stripe_paid_at || new Date();
  const amountPaid = Number(checkoutSession.amount_total) / (ZERO_DECIMAL_CURRENCIES.has(String(checkoutSession.currency).toUpperCase()) ? 1 : 100);
  const claimed = await Models.Return.findOneAndUpdate(
    {
      _id: record._id,
      status: "payment_pending",
      $or: [
        { "reorder_details.payment_status": "pending" },
        { "reorder_details.payment_status": "payment_received" },
        {
          "reorder_details.payment_status": "processing",
          "reorder_details.processing_at": { $lt: staleBefore },
        },
      ],
    },
    {
      $set: {
        "reorder_details.payment_status": "processing",
        "reorder_details.processing_at": new Date(),
        "reorder_details.stripe_payment_intent_id":
          checkoutSession?.payment_intent ||
          record.reorder_details?.stripe_payment_intent_id,
        "reorder_details.stripe_paid_at": paidAt,
        "reorder_details.stripe_amount_paid": amountPaid,
      },
      $addToSet: { finance_events: { $each: eventsFromDetails({ reorder_details: {
        ...record.reorder_details, payment_status: "payment_received", stripe_paid_at: paidAt, stripe_amount_paid: amountPaid,
      } }).filter((event) => event.type === "payment") } },
    },
    { new: true, lean: true }
  );

  if (!claimed) {
    return Services.Return.get({ _id: record._id });
  }

  try {
    const session = await getShopifySession(claimed.shop);
    const selections = Array.isArray(claimed.reorder_details.items)
      ? claimed.reorder_details.items
      : [];
    let replacementOrder = null;
    if (claimed.reorder_details.id) {
      replacementOrder = await shopify.api.rest.Order.find({
        session,
        id: normalizeShopifyId(claimed.reorder_details.id),
      });
    }
    if (!replacementOrder) {
      const originalOrder = await shopify.api.rest.Order.find({
        session,
        id: normalizeShopifyId(claimed.shopify_order_id),
      });
      replacementOrder = new shopify.api.rest.Order({ session });
      replacementOrder.line_items = selections.map((selection) => ({
        variant_id: selection.replacement_variant_id,
        quantity: selection.quantity,
      }));
      if (originalOrder.customer?.id) {
        replacementOrder.customer = { id: originalOrder.customer.id };
      }
      replacementOrder.email =
        originalOrder.email ||
        originalOrder.contact_email ||
        originalOrder.customer?.email ||
        claimed.customer?.email;
      replacementOrder.phone =
        originalOrder.phone || originalOrder.shipping_address?.phone;
      replacementOrder.shipping_address = buildShopifyAddress(
        originalOrder.shipping_address
      );
      replacementOrder.billing_address = buildShopifyAddress(
        originalOrder.billing_address || originalOrder.shipping_address
      );
      replacementOrder.currency = claimed.reorder_details.currency || "USD";
      replacementOrder.tags = `REORDER_BY_SWIPE, RETURN_${claimed.return_number}`;
      replacementOrder.financial_status = "paid";
      replacementOrder.discount_codes = [
        {
          code: "SWIPE_RETURN_CREDIT",
          amount: Number(claimed.reorder_details.credit_applied || 0).toFixed(2),
          type: "fixed_amount",
        },
      ];
      await replacementOrder.save({ update: true });
      await Models.Return.updateOne(
        { _id: claimed._id },
        {
          $set: {
            "reorder_details.id": replacementOrder.id,
            "reorder_details.name": replacementOrder.name,
            "reorder_details.order_number": replacementOrder.order_number,
          },
        }
      );
    }

    await updateResolvedItems(claimed._id, selections);
    const latest = await Services.Return.get({ _id: claimed._id });
    const hasPending = (latest.items || []).some(
      (item) => !item.resolution || item.resolution === "pending"
    );
    const status = hasPending ? "processed" : "exchanged";
    const updated = await Services.Return.updateStatus(claimed._id, status, {
      label: status === "exchanged" ? "Replacement order created" : "Items reordered",
      detail: `Stripe payment received. Shopify replacement order ${
        replacementOrder?.name ||
        replacementOrder?.order_number ||
        replacementOrder?.id
      } was created.`,
      set: {
        reorder_details: {
          ...claimed.reorder_details,
          id: replacementOrder?.id,
          name: replacementOrder?.name,
          order_number: replacementOrder?.order_number,
          payment_status: "paid",
          paid_at: new Date(),
          processed_at: new Date(),
        },
        processed_at: new Date(),
      },
    });
    let merchant = null;
    try {
      merchant = await Services.Merchant.get(
        { _id: claimed.merchant },
        { name: 1 }
      );
    } catch (error) {
      Logger.error(`Return email store lookup failed: ${error.message}`);
    }
    await Services.ReturnCustomerNotification.sendReplacementCreated({
      record: updated,
      customerEmail: replacementOrder?.email || claimed.customer?.email,
      storeName: merchant?.name,
      replacementOrder,
      items: selections,
      total: Number(claimed.reorder_details.replacement_total || 0),
      currency: claimed.reorder_details.currency || "USD",
    });
    return updated;
  } catch (error) {
    await Models.Return.updateOne(
      { _id: claimed._id, "reorder_details.payment_status": "processing" },
      {
        $set: {
          "reorder_details.payment_status": "payment_received",
          "reorder_details.payment_error": error.message,
        },
        $unset: { "reorder_details.processing_at": 1 },
      }
    );
    throw error;
  }
};

const sync = async (record) => {
  const sessionId = record?.reorder_details?.stripe_checkout_session_id;
  if (
    !sessionId ||
    record.reorder_details?.payment_status === "paid" ||
    !StripeAPI.isConfigured()
  ) {
    return record;
  }
  try {
    const checkoutSession = await StripeAPI.checkoutSessionRetrieve(sessionId);
    if (checkoutSession.payment_status === "paid") {
      return finalizePaidReplacement(record, checkoutSession);
    }
    if (checkoutSession.status === "expired") {
      return Services.Return.updateOne(
        { _id: record._id, "reorder_details.payment_status": "pending" },
        {
          $set: {
            "reorder_details.payment_status": "expired",
            "reorder_details.expired_at": new Date(),
          },
        }
      );
    }
  } catch (error) {
    Logger.error(`Stripe replacement payment sync failed: ${error.message}`);
  }
  return record;
};

const handleCheckoutEvent = async (checkoutSession) => {
  const returnId = checkoutSession?.metadata?.return_id;
  if (!returnId) return null;
  const record = await Services.Return.get({ _id: returnId });
  if (!record) return null;
  assertCheckoutMatchesRecord(record, checkoutSession);

  if (checkoutSession.payment_status === "paid") {
    return finalizePaidReplacement(record, checkoutSession);
  }
  if (checkoutSession.status === "expired") {
    return Services.Return.updateOne(
      { _id: record._id, "reorder_details.payment_status": "pending" },
      {
        $set: {
          "reorder_details.payment_status": "expired",
          "reorder_details.expired_at": new Date(),
        },
      }
    );
  }
  return record;
};

module.exports = {
  createCheckoutSession,
  finalizePaidReplacement,
  handleCheckoutEvent,
  sync,
  toStripeAmount,
};
