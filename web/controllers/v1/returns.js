const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const Config = require("../../config/config");
const {
  assertReturnProtection,
  normalizeOrderNumber,
  verifyOrderIdentity,
  buildReturnableItems,
  calculateReturnSummary,
  validateExchangeVariant,
  normalizeShopifyResourceId,
} = require("../../utils/returns");

const LOOKUP_SECRET = Config.get("APP").SECRET;

const normalizeShop = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

const getRequestIp = (req) =>
  String(
    req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket?.remoteAddress ||
      req.ip ||
      ""
  )
    .trim()
    .replace(/^::ffff:/i, "");

const findMerchant = async (shop) => {
  const normalized = normalizeShop(shop);
  if (!normalized) return null;
  return Services.Merchant.get({
    is_active: true,
    $or: [
      { shop_id: normalized },
      { myshopify_domain: normalized },
      { domain: normalized },
      { site_url: normalized },
    ],
  });
};

const getBranding = async (merchantId) => {
  const returnBranding = await Models.Branding.findOne({
    merchant: merchantId,
    type: "returnExchange",
  }).lean();
  if (returnBranding) return returnBranding;
  return Models.Branding.findOne({
    merchant: merchantId,
    type: "swipe",
    sub_type: "order",
  }).lean();
};

const publicBranding = (merchant, branding, policy) => ({
  store_name: merchant.name,
  logo: branding?.logo || merchant.store_logo || null,
  portal_background_image_url: policy?.portal_background_image_url || "",
  type_face: branding?.type_face || "sans-serif",
  colors: {
    font_color: branding?.colors?.font_color || "#232021",
    bg_color: branding?.colors?.bg_color || "#fbe7ec",
    button_bg_color: branding?.colors?.button_bg_color || "#232021",
    button_text_color: branding?.colors?.button_text_color || "#ffffff",
  },
});

const signLookupToken = (merchant, order) =>
  jwt.sign(
    {
      purpose: "return_lookup",
      merchantId: String(merchant._id),
      orderId: String(order._id),
      shop: merchant.shop_id || merchant.myshopify_domain,
    },
    LOOKUP_SECRET,
    { expiresIn: "30m" }
  );

const verifyLookupToken = (token) => {
  try {
    const decoded = jwt.verify(token, LOOKUP_SECRET);
    if (decoded.purpose !== "return_lookup") throw new Error("Invalid token");
    return decoded;
  } catch (error) {
    const invalid = new Error("Return session expired. Please find your order again.");
    invalid.status = 401;
    throw invalid;
  }
};

const findOrder = async (merchantId, orderNumber) => {
  const normalized = normalizeOrderNumber(orderNumber);
  const numeric = Number(normalized);
  const alternatives = [
    { name: normalized.startsWith("#") ? normalized : `#${normalized}` },
    { name: normalized },
  ];
  if (Number.isFinite(numeric)) {
    alternatives.push({ id: numeric }, { number: numeric }, { order_number: numeric });
  }
  return Services.Order.get({ merchant: merchantId, $or: alternatives });
};

const findExistingReturn = (merchantId, orderId) =>
  Models.Return.findOne({ merchant: merchantId, order: orderId })
    .sort({ createdAt: -1 })
    .lean();

const hasBlockedProductTag = (product, policy) => {
  const blocked = new Set(
    (policy?.final_sale_tags || []).map((tag) => String(tag).trim().toLowerCase())
  );
  return (product?.product_tags || []).some((tag) =>
    blocked.has(String(tag).trim().toLowerCase())
  );
};

const getPublicReturnStatus = async (record) => {
  const [merchant, branding, policy] = await Promise.all([
    Services.Merchant.get({ _id: record.merchant }),
    getBranding(record.merchant),
    Services.ReturnPolicy.getOrCreate(record.merchant),
  ]);
  return {
    return_number: record.return_number,
    public_token: record.public_token,
    status: record.status,
    outcome: record.outcome,
    gift_card: record.gift_card_details?.status === "issued" ? {
      amount: record.gift_card_details.amount,
      currency: record.gift_card_details.currency,
      email_sent: Boolean(record.gift_card_details.notification_sent_at),
    } : null,
    items: record.items,
    totals: {
      subtotal: record.subtotal,
      restocking_fee: record.restocking_fee,
      return_shipping_fee: record.return_shipping_fee,
      refund_total: record.refund_total,
      store_credit_total: record.store_credit_total,
    },
    label: record.easypost,
    payment: record.reorder_details?.stripe_checkout_session_id
      ? {
          provider: "stripe",
          status: record.reorder_details.payment_status,
          amount: Number(record.reorder_details.amount_due || 0),
          currency:
            record.reorder_details.currency || record.subtotal?.currency || "USD",
          checkout_url:
            record.reorder_details.payment_status === "pending"
              ? record.reorder_details.checkout_url
              : null,
        }
      : null,
    timeline: record.timeline,
    review_reason: record.review_reason,
    decline_reason: record.decline_reason,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    branding: merchant ? publicBranding(merchant, branding, policy) : null,
  };
};

const mergeShopifyReturnableItems = (localResult, liveItems, policy) => {
  if (!Array.isArray(liveItems) || !liveItems.length) return localResult;
  const byLineItem = new Map();
  liveItems.forEach((item) => {
    byLineItem.set(String(item.line_item_id), item);
    byLineItem.set(String(item.line_item_graphql_id), item);
  });
  const tags = (policy.final_sale_tags || []).map((tag) =>
    String(tag).toLowerCase()
  );

  return {
    ...localResult,
    delivered: true,
    items: localResult.items.map((item) => {
      const live =
        byLineItem.get(String(item.line_item_id)) ||
        byLineItem.get(String(item.line_item_graphql_id));
      if (!live) {
        return {
          ...item,
          eligible: false,
          ineligible_reason: item.ineligible_reason || "Not returnable in Shopify",
        };
      }
      const finalSale = (live.product_tags || []).some((tag) =>
        tags.includes(String(tag).toLowerCase())
      );
      return {
        ...item,
        ...live,
        eligible: !finalSale && localResult.days_left > 0,
        ineligible_reason: finalSale
          ? "Final sale"
          : localResult.days_left > 0
          ? null
          : "Return window has closed",
      };
    }),
  };
};

const mergeExchangeVariants = (result, products) => {
  if (!Array.isArray(products) || !products.length) return result;
  const byProductId = new Map(
    products.map((product) => [
      normalizeShopifyResourceId(product.product_id),
      product,
    ])
  );

  return {
    ...result,
    items: result.items.map((item) => {
      if (Array.isArray(item.exchange_variants) && item.exchange_variants.length) {
        return item;
      }
      const product = byProductId.get(normalizeShopifyResourceId(item.product_id));
      if (!product?.exchange_variants?.length) return item;

      return {
        ...item,
        product_tags: product.product_tags || item.product_tags || [],
        exchange_variants: product.exchange_variants.map((variant) => ({
          ...variant,
          image_url: variant.image_url || item.image_url || "",
        })),
      };
    }),
  };
};

const loadReturnableItems = async (merchant, order, policy) => {
  // Enforce on lookup and submission, before Shopify or test-mode eligibility.
  assertReturnProtection(order, policy);
  let result = buildReturnableItems(order, policy);
  let shopifyAvailable = false;
  try {
    const liveItems = await Services.ShopifyReturns.getReturnableItems({
      shop: merchant.shop_id || merchant.myshopify_domain,
      orderId:
        order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`,
    });
    result = mergeShopifyReturnableItems(result, liveItems, policy);
    shopifyAvailable = true;
  } catch (error) {
    Logger.warn(`Returnable fulfillment fallback: ${error.message}`);
  }

  const missingVariantProductIds = result.items
    .filter(
      (item) =>
        item.product_id &&
        (!Array.isArray(item.exchange_variants) || !item.exchange_variants.length)
    )
    .map((item) => item.product_id);

  if (missingVariantProductIds.length) {
    try {
      const products = await Services.ShopifyReturns.getExchangeVariants({
        shop: merchant.shop_id || merchant.myshopify_domain,
        productIds: missingVariantProductIds,
      });
      result = mergeExchangeVariants(result, products);
      shopifyAvailable = shopifyAvailable || products.length > 0;
    } catch (error) {
      Logger.warn(`Shopify exchange variant fallback: ${error.message}`);
    }
  }

  // Local/test stores can exercise the full return flow before a test order
  // has a real carrier delivery event. Production keeps the delivery rule.
  if (String(process.env.RETURN_TEST_MODE || "").toLowerCase() === "true") {
    result = {
      ...result,
      delivered: true,
      days_left: Number(policy.return_window_days || 30),
      items: result.items.map((item) => ({
        ...item,
        eligible:
          Number(item.max_quantity || 0) > 0 &&
          item.ineligible_reason !== "Final sale",
        ineligible_reason:
          item.ineligible_reason === "Final sale" ? "Final sale" : null,
      })),
    };
  }
  return { ...result, shopify_available: shopifyAvailable };
};

router.get("/config/:shop", async (req, res, next) => {
  try {
    const merchant = await findMerchant(req.params.shop);
    if (!merchant) return res.status(404).send({ message: "Store not found." });
    const [policy, branding] = await Promise.all([
      Services.ReturnPolicy.getOrCreate(merchant._id),
      getBranding(merchant._id),
    ]);
    return res.send({
      data: {
        branding: publicBranding(merchant, branding, policy),
        policy: Services.ReturnPolicy.toPublic(policy),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/lookup", async (req, res, next) => {
  try {
    const { shop, order_number: orderNumber, email_or_postcode: identity } =
      req.body || {};
    await Services.Return.recordLookupAttempt({
      ip: req.ip,
      shop: normalizeShop(shop),
    });
    const merchant = await findMerchant(shop);
    if (!merchant) {
      return res.status(404).send({ message: "Order details did not match." });
    }
    const order = await findOrder(merchant._id, orderNumber);
    if (!order || !verifyOrderIdentity(order, identity)) {
      return res.status(404).send({ message: "Order details did not match." });
    }
    const existingReturn = await findExistingReturn(merchant._id, order._id);
    if (existingReturn) {
      return res.send({
        data: {
          existing_return: await getPublicReturnStatus(existingReturn),
        },
      });
    }
    const [policy, branding] = await Promise.all([
      Services.ReturnPolicy.getOrCreate(merchant._id),
      getBranding(merchant._id),
    ]);
    const eligibility = await loadReturnableItems(merchant, order, policy);

    return res.send({
      data: {
        lookup_token: signLookupToken(merchant, order),
        order: {
          id: order._id,
          name: order.name,
          currency: order.currency || "USD",
          delivered_at: eligibility.delivered_at,
          days_left: eligibility.days_left,
          items: eligibility.items,
        },
        branding: publicBranding(merchant, branding, policy),
        policy: Services.ReturnPolicy.toPublic(policy),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/catalog", async (req, res, next) => {
  try {
    const decoded = verifyLookupToken(req.body?.lookup_token);
    const merchant = await Services.Merchant.get({
      _id: decoded.merchantId,
      is_active: true,
    });
    if (!merchant) return res.status(404).send({ message: "Store not found." });

    const policy = await Services.ReturnPolicy.getOrCreate(merchant._id);
    if (!policy.allow_exchanges) {
      return res.status(400).send({ message: "Exchanges are unavailable for this store." });
    }

    const excluded = new Set(
      (Array.isArray(req.body?.exclude_product_ids)
        ? req.body.exclude_product_ids
        : []
      ).map(normalizeShopifyResourceId)
    );
    const products = await Services.ShopifyReturns.searchExchangeProducts({
      shop: merchant.shop_id || merchant.myshopify_domain,
      search: req.body?.search,
      limit: 30,
    });
    const data = products.filter(
      (product) =>
        !excluded.has(normalizeShopifyResourceId(product.product_id)) &&
        !hasBlockedProductTag(product, policy)
    );

    return res.send({ data });
  } catch (error) {
    return next(error);
  }
});

router.post("/photo", async (req, res, next) => {
  try {
    verifyLookupToken(req.body?.lookup_token || req.headers["x-return-token"]);
    const file = req.files?.file;
    if (!file) return res.status(400).send({ message: "Photo is required." });
    if (!String(file.mimetype || "").startsWith("image/")) {
      return res.status(400).send({ message: "Only image files are allowed." });
    }
    if (Number(file.size || file.data?.length || 0) > 5 * 1024 * 1024) {
      return res.status(400).send({ message: "Photo must be smaller than 5MB." });
    }
    const extension = String(file.name || "photo.jpg").split(".").pop();
    const fileName = `return-${createRandomString(18)}.${extension}`;
    const uploaded = await S3.uploadExport(
      fileName,
      file.data,
      `returns/${process.env.S3_ENVIRONMENT || "dev"}`
    );
    return res.send({ data: { url: uploaded.Location } });
  } catch (error) {
    return next(error);
  }
});

router.post("/request", async (req, res, next) => {
  try {
    const decoded = verifyLookupToken(req.body?.lookup_token);
    const [merchant, order] = await Promise.all([
      Services.Merchant.get({ _id: decoded.merchantId, is_active: true }),
      Services.Order.get({ _id: decoded.orderId, merchant: decoded.merchantId }),
    ]);
    if (!merchant || !order) {
      return res.status(404).send({ message: "Order not found." });
    }
    const existingReturn = await findExistingReturn(merchant._id, order._id);
    if (existingReturn) {
      return res.status(409).send({
        message: "A return already exists for this order.",
        data: {
          existing_return: await getPublicReturnStatus(existingReturn),
        },
      });
    }
    const policy = await Services.ReturnPolicy.getOrCreate(merchant._id);
    const outcome = String(req.body?.outcome || "").toLowerCase();
    const outcomeAllowed =
      (outcome === "refund" && policy.allow_refunds) ||
      (outcome === "exchange" && policy.allow_exchanges) ||
      (outcome === "store_credit" && policy.allow_store_credit);
    if (!outcomeAllowed) {
      return res.status(400).send({ message: "Selected outcome is unavailable." });
    }

    const eligibility = await loadReturnableItems(merchant, order, policy);
    const eligibleById = new Map(
      eligibility.items.map((item) => [String(item.line_item_id), item])
    );
    const reasonsByCode = new Map(
      (policy.reasons || [])
        .filter((reason) => reason.enabled !== false)
        .map((reason) => [reason.code, reason])
    );
    const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!requestedItems.length) {
      return res.status(400).send({ message: "Select at least one item." });
    }

    const exchangeProductsById = new Map();
    if (outcome === "exchange") {
      const requestedProductIds = [
        ...new Set(
          requestedItems
            .map((item) => item.exchange_product_id)
            .filter(Boolean)
        ),
      ];
      if (requestedProductIds.length) {
        const products = await Services.ShopifyReturns.getExchangeVariants({
          shop: merchant.shop_id || merchant.myshopify_domain,
          productIds: requestedProductIds,
        });
        products.forEach((product) => {
          exchangeProductsById.set(
            normalizeShopifyResourceId(product.product_id),
            product
          );
        });
      }
    }

    let selectedItems;
    try {
      selectedItems = requestedItems.map((requested) => {
        const eligible = eligibleById.get(String(requested.line_item_id));
        const reason = reasonsByCode.get(requested.reason_code);
        const quantity = Number(requested.quantity);
        if (!eligible?.eligible) throw new Error("One selected item is not returnable.");
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > eligible.max_quantity) {
          throw new Error("Invalid return quantity.");
        }
        if (!reason) throw new Error("Choose a return reason for every item.");
        const photoUrls = Array.isArray(requested.photo_urls)
          ? requested.photo_urls.filter(Boolean)
          : [];
        if (reason.requires_photo && !photoUrls.length) {
          throw new Error(`A photo is required for ${reason.label}.`);
        }
        let exchangeVariant = null;
        let exchangeProduct = null;
        if (outcome === "exchange") {
          const originalProductId = normalizeShopifyResourceId(eligible.product_id);
          const requestedProductId = normalizeShopifyResourceId(
            requested.exchange_product_id || eligible.product_id
          );
          const isDifferentProduct = requestedProductId !== originalProductId;
          if (isDifferentProduct) {
            exchangeProduct = exchangeProductsById.get(requestedProductId);
            if (!exchangeProduct) {
              throw new Error("Choose a valid replacement product.");
            }
            if (
              String(exchangeProduct.product_status || "ACTIVE").toUpperCase() !==
                "ACTIVE" ||
              hasBlockedProductTag(exchangeProduct, policy)
            ) {
              throw new Error("The selected replacement product is unavailable.");
            }
          }
          const validation = validateExchangeVariant(
            isDifferentProduct
              ? { exchange_variants: exchangeProduct.exchange_variants }
              : eligible,
            requested.exchange_variant_id,
            quantity
          );
          if (validation.error) throw new Error(validation.error);
          exchangeVariant = validation.variant;
        }
        return {
          ...eligible,
          quantity,
          reason_code: reason.code,
          reason_label: reason.label,
          shopify_reason: reason.shopify_reason,
          customer_note: String(requested.customer_note || "").slice(0, 255),
          photo_urls: photoUrls,
          waive_shipping_fee: reason.waive_shipping_fee,
          restocking_fee_percent: Number(policy.restocking_fee_percent || 0),
          exchange_product_id: exchangeProduct?.product_id || eligible.product_id,
          exchange_product_title: exchangeProduct?.product_title || eligible.title,
          exchange_product_image_url:
            exchangeProduct?.product_image_url ||
            exchangeVariant?.image_url ||
            eligible.image_url,
          exchange_variant_id: exchangeVariant?.id,
          exchange_variant_title:
            exchangeVariant?.title || exchangeVariant?.variant_title,
          exchange_unit_price: Number(exchangeVariant?.unit_price || 0),
        };
      });
    } catch (validationError) {
      validationError.status = 400;
      throw validationError;
    }

    const summary = calculateReturnSummary({
      items: selectedItems,
      outcome,
      policy,
      currency: order.currency,
    });
    const minimumReturnValue = Math.max(0, Number(policy.keep_item_max || 0));
    if (minimumReturnValue > 0 && summary.subtotal <= minimumReturnValue) {
      const currency = order.currency || "USD";
      return res.status(400).send({
        message: `Return value must be more than ${currency} ${minimumReturnValue.toFixed(2)}. Your selected items total ${currency} ${summary.subtotal.toFixed(2)}.`,
      });
    }
    let autoApproved = summary.subtotal <= Number(policy.auto_approve_max || 0);
    let reviewReason = autoApproved
      ? null
      : `Value above ${order.currency || "USD"} ${policy.auto_approve_max}`;
    let shopifyPayload = null;
    try {
      shopifyPayload = await Services.ShopifyReturns.submit({
        shop: merchant.shop_id || merchant.myshopify_domain,
        orderId:
          order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`,
        items: selectedItems,
        outcome,
        autoApprove: autoApproved,
        shippingFee: summary.return_shipping_fee,
        currency: order.currency || "USD",
      });
      if (shopifyPayload?.skipped) {
        autoApproved = false;
        reviewReason = "Shopify fulfillment data needs review";
      }
    } catch (error) {
      autoApproved = false;
      reviewReason = `Shopify sync pending: ${error.message}`;
      shopifyPayload = { error: error.message };
    }

    let returnRecord;
    try {
      returnRecord = await Services.Return.create({
        merchant,
        order,
        shop: merchant.shop_id || merchant.myshopify_domain,
        outcome,
        customer: {
          name:
            order.customer?.name ||
            `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim(),
          email: order.customer?.email,
          phone: order.customer?.phone,
          address: order.shipping_address,
          request_ip: getRequestIp(req),
          order_ip: order.browser_ip,
        },
        items: selectedItems,
        summary,
        policy,
        idempotencyKey: String(req.body?.idempotency_key || "").trim() || undefined,
        status: autoApproved ? "approved" : "needs_review",
        reviewReason,
        autoApproved,
        shopifyPayload,
      });
    } catch (error) {
      if (error?.code === 11000) {
        const duplicateReturn = await findExistingReturn(merchant._id, order._id);
        if (duplicateReturn) {
          return res.status(409).send({
            message: "A return already exists for this order.",
            data: {
              existing_return: await getPublicReturnStatus(duplicateReturn),
            },
          });
        }
      }
      throw error;
    }

    await Services.ReturnCustomerNotification.sendFiled({
      record: returnRecord,
      customerEmail: returnRecord.customer?.email || order.customer?.email,
      storeName: merchant.name,
    });

    if (autoApproved && !summary.keep_item) {
      try {
        returnRecord = await Services.ReturnShipping.createLabel({
          merchant,
          order,
          policy,
          returnRecord,
        });
      } catch (error) {
        Logger.error(`Return label pending: ${error.stack || error.message}`);
      }
    }

    if (autoApproved) {
      await Services.ReturnCustomerNotification.sendApproved({
        record: returnRecord,
        customerEmail: returnRecord.customer?.email || order.customer?.email,
        storeName: merchant.name,
      });
    }

    return res.status(201).send({
      data: {
        return_number: returnRecord.return_number,
        public_token: returnRecord.public_token,
        status: returnRecord.status,
        outcome: returnRecord.outcome,
        totals: {
          subtotal: returnRecord.subtotal,
          restocking_fee: returnRecord.restocking_fee,
          return_shipping_fee: returnRecord.return_shipping_fee,
          refund_total: returnRecord.refund_total,
          store_credit_total: returnRecord.store_credit_total,
        },
        label: returnRecord.easypost || null,
        keep_item: summary.keep_item,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/status/:token", async (req, res, next) => {
  try {
    let record = await Services.Return.get({ public_token: req.params.token });
    if (!record) return res.status(404).send({ message: "Return not found." });
    if (
      record.status === "payment_pending" &&
      record.reorder_details?.stripe_checkout_session_id
    ) {
      record = await Services.ReturnExchangePayment.sync(record);
    }
    return res.send({ data: await getPublicReturnStatus(record) });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
