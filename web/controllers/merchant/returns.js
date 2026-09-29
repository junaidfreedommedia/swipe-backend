const express = require("express");
const router = express.Router();
const shopify = require("../../shopify.js");
const { confirmedRefundAmount } = require("../../utils/returnFinance");
const {
  allocateRefundTransactions,
  calculateExchangeAdjustment,
} = require("../../utils/returns");

const normalizeShopifyId = (value) => {
  const match = String(value || "").match(/(\d+)$/);
  return match ? Number(match[1]) : null;
};

const getSession = async (shop) => {
  const session = await Services.ShopifySession.get({ shop });
  if (!session) {
    const error = new Error("Shopify session not found. Reconnect this store and try again.");
    error.status = 409;
    throw error;
  }
  return session;
};

const getVariantAvailability = async (session, rawVariantId) => {
  const variantId = normalizeShopifyId(rawVariantId);
  if (!variantId) {
    return {
      variant_id: rawVariantId,
      variant_exists: false,
      available: false,
      total_inventory: 0,
      tracked: false,
    };
  }

  try {
    const variant = await shopify.api.rest.Variant.find({ session, id: variantId });
    if (!variant) throw new Error("Variant not found");
    const tracked = variant.inventory_management === "shopify";
    if (!tracked) {
      return {
        variant_id: variantId,
        variant_exists: true,
        available: true,
        total_inventory: null,
        tracked: false,
        product_id: variant.product_id,
        title: variant.title,
        price: Number(variant.price || 0),
      };
    }

    const inventory = variant.inventory_item_id
      ? await shopify.api.rest.InventoryLevel.all({
          session,
          inventory_item_ids: String(variant.inventory_item_id),
        })
      : null;
    const levels = Array.isArray(inventory?.data) ? inventory.data : [];
    const totalInventory = levels.reduce(
      (sum, level) => sum + Number(level.available || 0),
      0
    );
    return {
      variant_id: variantId,
      variant_exists: true,
      available:
        variant.inventory_policy === "continue" || totalInventory > 0,
      total_inventory: totalInventory,
      tracked: true,
      product_id: variant.product_id,
      title: variant.title,
      price: Number(variant.price || 0),
    };
  } catch (error) {
    Logger.error(`Return variant check failed (${variantId}): ${error.message}`);
    return {
      variant_id: variantId,
      variant_exists: false,
      available: false,
      total_inventory: 0,
      tracked: false,
    };
  }
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

const pendingReturnItem = (record, lineItemId) =>
  (record.items || []).find(
    (item) =>
      String(item.line_item_id) === String(lineItemId) &&
      (!item.resolution || item.resolution === "pending")
  );

const assertProcessable = (record) => {
  if (record.outcome === "store_credit") {
    throw Object.assign(new Error("Use Issue store credit for this return."), { status: 409 });
  }
  if (!["received", "processed"].includes(record.status)) {
    const error = new Error("Mark the return as received before processing it.");
    error.status = 409;
    throw error;
  }
};

const actionWasProcessed = (record, actionKey) =>
  actionKey && (record.processed_actions || []).includes(actionKey);

const updateResolvedItems = async (recordId, selections, resolution) => {
  for (const selection of selections) {
    const set = {
      "items.$[item].resolution": resolution,
      "items.$[item].resolved_at": new Date(),
    };
    if (resolution === "reorder") {
      set["items.$[item].exchange_product_id"] = String(
        selection.replacement_product_id || selection.item?.exchange_product_id || ""
      );
      set["items.$[item].exchange_product_title"] =
        selection.replacement_product_title ||
        selection.item?.exchange_product_title ||
        selection.item?.title;
      set["items.$[item].exchange_product_image_url"] =
        selection.replacement_product_image_url ||
        selection.item?.exchange_product_image_url ||
        selection.item?.image_url;
      set["items.$[item].exchange_variant_id"] = String(
        selection.replacement_variant_id
      );
      set["items.$[item].exchange_variant_title"] =
        selection.replacement_variant_title;
      set["items.$[item].exchange_unit_price"] = Number(
        selection.replacement_unit_price || 0
      );
    }
    await Models.Return.updateOne(
      { _id: recordId },
      { $set: set },
      {
        arrayFilters: [
          { "item.line_item_id": String(selection.line_item_id) },
        ],
      }
    );
  }
};

const nextProcessedStatus = async (recordId, completedStatus) => {
  const latest = await Services.Return.get({ _id: recordId });
  const hasPending = (latest.items || []).some(
    (item) => !item.resolution || item.resolution === "pending"
  );
  return hasPending ? "processed" : completedStatus;
};

const syncPendingReplacement = async (record) => {
  if (record.reorder_details?.stripe_checkout_session_id) {
    return Services.ReturnExchangePayment.sync(record);
  }
  if (record.status !== "payment_pending" || !record.reorder_details?.draft_order_id) {
    return record;
  }

  try {
    const session = await getSession(record.shop);
    const draftOrder = await shopify.api.rest.DraftOrder.find({
      session,
      id: normalizeShopifyId(record.reorder_details.draft_order_id),
    });
    if (!draftOrder?.completed_at || !draftOrder?.order_id) return record;

    const selections = Array.isArray(record.reorder_details.items)
      ? record.reorder_details.items
      : [];
    await updateResolvedItems(record._id, selections, "reorder");
    const status = await nextProcessedStatus(record._id, "exchanged");
    let replacementOrder = null;
    try {
      replacementOrder = await shopify.api.rest.Order.find({
        session,
        id: normalizeShopifyId(draftOrder.order_id),
      });
    } catch (error) {
      Logger.error(`Paid replacement order lookup failed: ${error.message}`);
    }

    return Services.Return.updateStatus(record._id, status, {
      label: status === "exchanged" ? "Replacement order created" : "Items reordered",
      detail: `Customer payment received. Shopify replacement order ${replacementOrder?.name || replacementOrder?.order_number || draftOrder.order_id} was created.`,
      set: {
        reorder_details: {
          ...record.reorder_details,
          id: replacementOrder?.id || draftOrder.order_id,
          name: replacementOrder?.name,
          order_number: replacementOrder?.order_number,
          payment_status: "paid",
          paid_at: draftOrder.completed_at,
          processed_at: new Date(),
        },
        processed_at: new Date(),
      },
    });
  } catch (error) {
    Logger.error(`Pending replacement payment sync failed: ${error.message}`);
    return record;
  }
};

const authorizeReturnStore = (req, _res, next) => {
  try {
    if (!req.merchant) {
      const error = new Error("Select a store to manage returns.");
      error.status = 400;
      throw error;
    }
    if (req.user?.role === USER_ROLE.ADMIN) {
      Auth.assertMerchantAccess(req.user, req.merchant._id);
    }
    return next();
  } catch (error) {
    return next(error);
  }
};

const returnAuth = [Auth.check, authorizeReturnStore];

const authorizeReturnReadScope = (req, _res, next) => {
  try {
    if (req.merchant) {
      if (req.user?.role === USER_ROLE.ADMIN) {
        Auth.assertMerchantAccess(req.user, req.merchant._id);
      }
      return next();
    }
    if (req.user?.role === USER_ROLE.ADMIN) return next();

    const error = new Error("Select a store to manage returns.");
    error.status = 400;
    throw error;
  } catch (error) {
    return next(error);
  }
};

const returnReadAuth = [Auth.check, authorizeReturnReadScope];

const getReturnReadScope = (req) => {
  if (req.merchant) return { merchantId: req.merchant._id };
  return {
    merchantIds: Auth.isSuperAdmin(req.user)
      ? undefined
      : Auth.getAssignedMerchantIds(req.user),
  };
};

const getRecord = async (req) => {
  const record = await Services.Return.get({
    _id: req.params.id,
    merchant: req.merchant._id,
  });
  if (!record) {
    const error = new Error("Return not found.");
    error.status = 404;
    throw error;
  }
  return record;
};

router.get("/policy", ...returnAuth, async (req, res, next) => {
  try {
    const policy = await Services.ReturnPolicy.getOrCreate(req.merchant._id);
    return res.send({
      data: {
        ...policy,
        shop: req.merchant.shop_id || req.merchant.myshopify_domain,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/policy", ...returnAuth, async (req, res, next) => {
  try {
    const policy = await Services.ReturnPolicy.update(req.merchant._id, req.body);
    return res.send({ data: policy, message: "Return policy saved." });
  } catch (error) {
    return next(error);
  }
});

router.post("/policy/background", ...returnAuth, async (req, res, next) => {
  try {
    const file = req.files?.file;
    if (!file || Array.isArray(file)) {
      const error = new Error("Choose one background image to upload.");
      error.status = 400;
      throw error;
    }

    const allowedTypes = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    };
    const extension = allowedTypes[file.mimetype];
    if (!extension) {
      const error = new Error("Background must be a JPG, PNG, or WebP image.");
      error.status = 400;
      throw error;
    }
    if (Number(file.size || file.data?.length || 0) > 5 * 1024 * 1024) {
      const error = new Error("Background image must be 5 MB or smaller.");
      error.status = 400;
      throw error;
    }

    const current = await Services.ReturnPolicy.getOrCreate(req.merchant._id);
    const merchantId = String(req.merchant._id);
    const environment = `returns/${process.env.S3_ENVIRONMENT || process.env.NODE_ENV || "dev"}/${merchantId}`;
    const fileName = `portal-background-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
    const uploaded = await S3.uploadImage(
      fileName,
      file.data,
      environment,
      file.mimetype
    );

    let policy;
    try {
      policy = await Models.ReturnPolicy.findOneAndUpdate(
        { merchant: req.merchant._id },
        {
          $set: {
            portal_background_image_url: uploaded.Location,
            portal_background_image_key: uploaded.Key,
          },
        },
        { new: true, runValidators: true, lean: true }
      );
    } catch (error) {
      await S3.deleteFile(uploaded.Key).catch(() => null);
      throw error;
    }

    if (current.portal_background_image_key) {
      await S3.deleteFile(current.portal_background_image_key).catch((error) =>
        Logger.error(`Old return background cleanup failed: ${error.message}`)
      );
    }

    return res.send({
      data: policy,
      message: "Portal background updated.",
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/policy/background", ...returnAuth, async (req, res, next) => {
  try {
    const current = await Services.ReturnPolicy.getOrCreate(req.merchant._id);
    const policy = await Models.ReturnPolicy.findOneAndUpdate(
      { merchant: req.merchant._id },
      {
        $unset: {
          portal_background_image_url: 1,
          portal_background_image_key: 1,
        },
      },
      { new: true, lean: true }
    );

    if (current.portal_background_image_key) {
      await S3.deleteFile(current.portal_background_image_key).catch((error) =>
        Logger.error(`Return background cleanup failed: ${error.message}`)
      );
    }

    return res.send({
      data: policy,
      message: "Portal background removed.",
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/analytics", ...returnReadAuth, async (req, res, next) => {
  try {
    const scope = getReturnReadScope(req);
    const data = await Services.Return.analytics(
      scope.merchantId,
      req.query.days,
      scope.merchantIds,
      { startDate: req.query.startDate, endDate: req.query.endDate, allTime: req.query.allTime === "true" }
    );
    return res.send({ data });
  } catch (error) {
    return next(error);
  }
});

router.get("/list-summary", ...returnReadAuth, async (req, res, next) => {
  try {
    const data = await Services.Return.list({
      ...getReturnReadScope(req),
      status: req.query.status,
      search: req.query.search,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      view: "summary",
    });
    return res.send({ data });
  } catch (error) {
    return next(error);
  }
});

router.get("/", ...returnReadAuth, async (req, res, next) => {
  try {
    const scope = getReturnReadScope(req);
    const data = await Services.Return.list({
      ...scope,
      status: req.query.status,
      search: req.query.search,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      page: req.query.page,
      limit: req.query.limit,
      view: req.query.view === "rows" ? "rows" : "full",
    });
    return res.send({ data });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", ...returnAuth, async (req, res, next) => {
  try {
    let record = await getRecord(req);
    record = await syncPendingReplacement(record);
    const order = await Services.Order.get({
      _id: record.order,
      merchant: req.merchant._id,
    });
    if (!order) return res.status(404).send({ message: "Original order not found." });

    const customerReturnNumber = await Services.Return.customerReturnNumber(record);

    let replacementOptions = {};
    try {
      const session = await getSession(record.shop);
      const productIds = [
        ...new Set(
          (record.items || [])
            .flatMap((item) => [item.product_id, item.exchange_product_id])
            .map(normalizeShopifyId)
            .filter(Boolean)
        ),
      ];
      const products = await Promise.all(
        productIds.map(async (productId) => {
          try {
            return await shopify.api.rest.Product.find({ session, id: productId });
          } catch (error) {
            Logger.error(`Return product variants unavailable (${productId}): ${error.message}`);
            return null;
          }
        })
      );
      replacementOptions = products.reduce((map, product) => {
        if (!product) return map;
        map[String(product.id)] = (product.variants || []).map((variant) => ({
          id: String(variant.id),
          title: variant.title,
          price: Number(variant.price || 0),
          sku: variant.sku,
        }));
        return map;
      }, {});
    } catch (error) {
      Logger.error(`Return replacement options unavailable: ${error.message}`);
    }

    return res.send({
      data: {
        ...record,
        customer_return_no: customerReturnNumber,
        order_details: {
          _id: order._id,
          id: order.id,
          admin_graphql_api_id: order.admin_graphql_api_id,
          name: order.name,
          number: order.number,
          order_number: order.order_number,
          order_created_at: order.order_created_at,
          createdAt: order.createdAt,
          currency: order.currency,
          financial_status: order.financial_status,
          fulfillment_status: order.fulfillment_status,
          total_price: order.total_price,
          current_total_price: order.current_total_price,
          total_discounts: order.total_discounts,
          total_tax: order.total_tax,
          line_items: order.line_items,
          refunds: order.refunds,
          fulfillments: order.fulfillments,
          shipping_address: order.shipping_address,
          billing_address: order.billing_address,
          customer: order.customer,
          tags: order.tags,
          browser_ip: order.browser_ip,
          tracking_company: order.tracking_company,
          tracking_number: order.tracking_number,
          tracking_url: order.tracking_url,
        },
        replacement_options: replacementOptions,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/comment", ...returnAuth, async (req, res, next) => {
  try {
    const record = await getRecord(req);
    const comment = String(req.body?.comment || "").trim();
    if (!comment) {
      return res.status(400).send({ message: "Write a comment first." });
    }
    if (comment.length > 1000) {
      return res.status(400).send({ message: "Comment must be 1000 characters or less." });
    }

    const data = await Models.Return.findOneAndUpdate(
      { _id: record._id, merchant: req.merchant._id },
      {
        $push: {
          timeline: {
            status: "comment",
            label: "Comment",
            detail: comment,
            actor: req.user?.display_name || "User",
            created_at: new Date(),
          },
        },
      },
      { new: true, runValidators: true, lean: true }
    );

    return res.send({ data, message: "Comment added to the timeline." });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/check-stock", ...returnAuth, async (req, res, next) => {
  try {
    const record = await getRecord(req);
    const variantIds = Array.isArray(req.body?.variant_ids)
      ? [...new Set(req.body.variant_ids.filter(Boolean))]
      : [];
    if (!variantIds.length) {
      return res.status(400).send({ message: "Select at least one replacement variant." });
    }
    const session = await getSession(record.shop);
    const data = await Promise.all(
      variantIds.map((variantId) => getVariantAvailability(session, variantId))
    );
    return res.send({ data, message: "Variant availability checked." });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/store-credit", ...returnAuth, async (req, res, next) => {
  try {
    const record = await getRecord(req);
    const updated = await Services.ReturnGiftCard.issue(record);
    return res.send({ data: updated, message: updated.gift_card_details?.notification_sent_at
      ? "Store credit issued. The gift card code was emailed to the customer."
      : "Store credit issued. Retry sending the gift card email." });
  } catch (error) { return next(error); }
});

router.post("/:id/refund", ...returnAuth, async (req, res, next) => {
  let itemRefundClaim = null;
  try {
    let record = await getRecord(req);
    assertProcessable(record);
    if (["processing", "refunded"].includes(record.credit_refund_details?.status)) {
      return res.status(409).send({
        message: "Customer credit has already been refunded or is being processed.",
      });
    }
    const actionKey = String(req.body?.action_key || "").trim();
    if (!actionKey) return res.status(400).send({ message: "Action key is required." });
    if (actionWasProcessed(record, actionKey)) {
      return res.send({ data: record, message: "This refund was already processed." });
    }

    const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const selections = requestedItems.map((selection) => {
      const item = pendingReturnItem(record, selection.line_item_id);
      const quantity = Number(selection.quantity || 0);
      if (!item || !Number.isInteger(quantity) || quantity < 1 || quantity > Number(item.quantity || 0)) {
        const error = new Error("One or more refund items are invalid or already processed.");
        error.status = 400;
        throw error;
      }
      return { item, line_item_id: String(item.line_item_id), quantity };
    });
    if (!selections.length) return res.status(400).send({ message: "Select items to refund." });

    const orderId = normalizeShopifyId(record.shopify_order_id);
    const session = await getSession(record.shop);
    const order = await shopify.api.rest.Order.find({ session, id: orderId });
    const refundLineItems = selections.map(({ line_item_id, quantity }) => ({
      line_item_id: Number(line_item_id),
      quantity,
      restock_type: "no_restock",
    }));
    const calculation = new shopify.api.rest.Refund({ session });
    calculation.order_id = orderId;
    const calculated = await calculation.calculate({
      body: {
        refund: {
          currency: order.currency,
          refund_line_items: refundLineItems,
        },
      },
    });
    if (!calculated?.refund?.transactions?.length) {
      return res.status(409).send({ message: "Shopify could not calculate this refund. It may already be refunded." });
    }

    itemRefundClaim = await Models.Return.findOneAndUpdate(
      {
        _id: record._id,
        "credit_refund_details.status": { $nin: ["processing", "refunded"] },
        "refund_operation.status": { $ne: "processing" },
      },
      {
        $set: {
          refund_operation: {
            status: "processing",
            type: "items",
            action_key: actionKey,
            started_at: new Date(),
          },
        },
      },
      { new: true, lean: true }
    );
    if (!itemRefundClaim) {
      return res.status(409).send({
        message: "Another refund is already processing or customer credit was refunded.",
      });
    }

    const refund = new shopify.api.rest.Refund({ session });
    refund.order_id = orderId;
    refund.currency = order.currency;
    refund.notify = true;
    refund.note = String(req.body?.note || "Refunded via Swipe Returns").slice(0, 255);
    refund.refund_line_items = refundLineItems;
    refund.transactions = calculated.refund.transactions.map((transaction) => ({
      parent_id: transaction.parent_id,
      amount: transaction.amount,
      kind: "refund",
      gateway: transaction.gateway,
    }));
    await refund.save({ update: true, body: { refund: { order_id: orderId } } });

    await updateResolvedItems(record._id, selections, "refund");
    const status = await nextProcessedStatus(record._id, "refunded");
    record = await Services.Return.updateStatus(record._id, status, {
      label: status === "refunded" ? "Return refunded" : "Items refunded",
      detail: `${selections.length} return item selection(s) refunded in Shopify.`,
      set: {
        refund_details: {
          shopify_refund_id: refund.id,
          amount: confirmedRefundAmount(refund.transactions),
          currency: order.currency,
          items: selections.map(({ line_item_id, quantity }) => ({ line_item_id, quantity })),
          processed_at: new Date(),
        },
        processed_at: new Date(),
      },
    });
    record = await Services.Return.updateOne(
      { _id: record._id },
      {
        $addToSet: { processed_actions: actionKey },
        $unset: { refund_operation: 1 },
      }
    );
    const refundedAmount = (refund.transactions || []).reduce(
      (sum, transaction) => sum + Number(transaction.amount || 0),
      0
    );
    await Services.ReturnCustomerNotification.sendRefundProcessed({
      record,
      storeName: req.merchant?.name,
      customerEmail:
        order.email ||
        order.contact_email ||
        order.customer?.email ||
        record.customer?.email,
      items: selections,
      amount: refundedAmount,
      currency: order.currency,
    });
    return res.send({ data: record, message: "Refund processed in Shopify." });
  } catch (error) {
    if (itemRefundClaim?._id) {
      await Models.Return.updateOne(
        {
          _id: itemRefundClaim._id,
          "refund_operation.type": "items",
          "refund_operation.action_key": itemRefundClaim.refund_operation?.action_key,
        },
        { $unset: { refund_operation: 1 } }
      ).catch(() => {});
    }
    return next(error);
  }
});

router.post("/:id/credit-refund", ...returnAuth, async (req, res, next) => {
  let claimed = null;
  try {
    const record = await getRecord(req);
    const actionKey = String(req.body?.action_key || "").trim();
    if (!actionKey) {
      return res.status(400).send({ message: "Action key is required." });
    }
    if (actionWasProcessed(record, actionKey)) {
      return res.send({
        data: record,
        message: "This customer credit refund was already processed.",
      });
    }
    if (record.outcome !== "exchange") {
      return res.status(409).send({
        message: "Customer credit refund is only available for exchanges.",
      });
    }
    if ((record.items || []).some((item) => item.resolution === "refund")) {
      return res.status(409).send({
        message: "Customer credit cannot be refunded after an item refund.",
      });
    }
    if (!record.reorder_details?.id) {
      return res.status(409).send({
        message: "Create the replacement order before refunding customer credit.",
      });
    }
    if (record.credit_refund_details?.status === "refunded") {
      return res.status(409).send({
        message: "Customer credit has already been refunded.",
      });
    }

    const creditDue = Number(record.reorder_details?.credit_due || 0);
    const currency =
      record.reorder_details?.currency || record.subtotal?.currency || "USD";
    if (!Number.isFinite(creditDue) || creditDue <= 0) {
      return res.status(409).send({ message: "No customer credit is due." });
    }

    claimed = await Models.Return.findOneAndUpdate(
      {
        _id: record._id,
        "credit_refund_details.status": { $nin: ["processing", "refunded"] },
        "refund_operation.status": { $ne: "processing" },
        items: { $not: { $elemMatch: { resolution: "refund" } } },
      },
      {
        $set: {
          credit_refund_details: {
            status: "processing",
            amount: creditDue,
            currency,
            action_key: actionKey,
            started_at: new Date(),
          },
          refund_operation: {
            status: "processing",
            type: "credit",
            action_key: actionKey,
            started_at: new Date(),
          },
        },
      },
      { new: true, lean: true }
    );
    if (!claimed) {
      return res.status(409).send({
        message: "Customer credit refund is already processing or unavailable.",
      });
    }

    const session = await getSession(record.shop);
    const orderId = normalizeShopifyId(record.shopify_order_id);
    const transactionResponse = await shopify.api.rest.Transaction.all({
      session,
      order_id: orderId,
    });
    const transactions = Array.isArray(transactionResponse)
      ? transactionResponse
      : transactionResponse?.data || [];
    const allocation = allocateRefundTransactions(transactions, creditDue);
    if (allocation.remaining > 0 || !allocation.allocations.length) {
      const error = new Error(
        `Only ${currency} ${allocation.available.toFixed(2)} remains refundable on the original order.`
      );
      error.status = 409;
      throw error;
    }

    const refund = new shopify.api.rest.Refund({ session });
    refund.order_id = orderId;
    refund.currency = currency;
    refund.notify = true;
    refund.note = `Customer credit refund for return ${record.return_number}`;
    refund.transactions = allocation.allocations;
    await refund.save({
      update: true,
      body: { refund: { order_id: orderId } },
    });

    const updated = await Services.Return.updateStatus(record._id, record.status, {
      label: "Customer credit refunded",
      detail: `${currency} ${creditDue.toFixed(2)} customer credit was refunded to the original payment method.`,
      set: {
        credit_refund_details: {
          status: "refunded",
          amount: creditDue,
          settled_amount: confirmedRefundAmount(refund.transactions),
          currency,
          shopify_refund_id: refund.id,
          action_key: actionKey,
          processed_at: new Date(),
        },
      },
    });
    const data = await Services.Return.updateOne(
      { _id: updated._id },
      {
        $addToSet: { processed_actions: actionKey },
        $unset: { refund_operation: 1 },
      }
    );
    await Services.ReturnCustomerNotification.sendRefundProcessed({
      record: data,
      storeName: req.merchant?.name,
      customerEmail: data.customer?.email,
      items: [],
      amount: creditDue,
      currency,
      creditRefund: true,
    });
    return res.send({
      data,
      message: `${currency} ${creditDue.toFixed(2)} customer credit refunded.`,
    });
  } catch (error) {
    if (claimed?._id) {
      await Models.Return.updateOne(
        {
          _id: claimed._id,
          "credit_refund_details.status": "processing",
          "refund_operation.type": "credit",
        },
        { $unset: { credit_refund_details: 1, refund_operation: 1 } }
      ).catch(() => {});
    }
    return next(error);
  }
});

router.post("/:id/reorder", ...returnAuth, async (req, res, next) => {
  try {
    let record = await getRecord(req);
    const actionKey = String(req.body?.action_key || "").trim();
    if (!actionKey) return res.status(400).send({ message: "Action key is required." });
    if (actionWasProcessed(record, actionKey)) {
      return res.send({ data: record, message: "This reorder was already processed." });
    }
    if (
      record.status === "payment_pending" &&
      (record.reorder_details?.checkout_url || record.reorder_details?.invoice_url)
    ) {
      return res.send({
        data: record,
        message: "The replacement payment link has already been created.",
      });
    }
    assertProcessable(record);

    const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const selections = requestedItems.map((selection) => {
      const item = pendingReturnItem(record, selection.line_item_id);
      const quantity = Number(selection.quantity || 0);
      const replacementVariantId = normalizeShopifyId(selection.replacement_variant_id);
      if (!item || !replacementVariantId || !Number.isInteger(quantity) || quantity < 1 || quantity > Number(item.quantity || 0)) {
        const error = new Error("One or more reorder items are invalid or already processed.");
        error.status = 400;
        throw error;
      }
      return {
        item,
        line_item_id: String(item.line_item_id),
        quantity,
        replacement_product_id:
          normalizeShopifyId(item.exchange_product_id) ||
          normalizeShopifyId(item.product_id),
        replacement_product_title: item.exchange_product_title || item.title,
        replacement_product_image_url:
          item.exchange_product_image_url || item.image_url,
        replacement_variant_id: replacementVariantId,
        replacement_variant_title: String(selection.replacement_variant_title || "Replacement"),
      };
    });
    if (!selections.length) return res.status(400).send({ message: "Select items to reorder." });

    const session = await getSession(record.shop);
    for (const selection of selections) {
      const availability = await getVariantAvailability(session, selection.replacement_variant_id);
      if (!availability.variant_exists || !availability.available) {
        return res.status(409).send({ message: `${selection.item.title || "Selected variant"} is out of stock.` });
      }
      if (
        normalizeShopifyId(availability.product_id) !==
        normalizeShopifyId(selection.replacement_product_id)
      ) {
        return res.status(400).send({ message: "Replacement variant does not belong to the selected replacement product." });
      }
      if (availability.tracked && Number(availability.total_inventory || 0) < selection.quantity) {
        return res.status(409).send({ message: `${selection.item.title || "Selected variant"} does not have enough stock.` });
      }
      selection.replacement_variant_id = availability.variant_id;
      selection.replacement_variant_title = availability.title || "Replacement";
      selection.replacement_unit_price = Number(availability.price || 0);
    }

    const orderId = normalizeShopifyId(record.shopify_order_id);
    const originalOrder = await shopify.api.rest.Order.find({ session, id: orderId });
    const currency = originalOrder.currency || record.subtotal?.currency || "USD";
    const adjustment = calculateExchangeAdjustment({
      items: selections.map(({ item, quantity }) => ({
        unit_price: item.unit_price,
        quantity,
      })),
      replacementItems: selections,
    });
    const reorderItems = selections.map(
      ({ line_item_id, quantity, replacement_product_id, replacement_product_title, replacement_product_image_url, replacement_variant_id, replacement_variant_title, replacement_unit_price }) => ({
        line_item_id,
        quantity,
        replacement_product_id,
        replacement_product_title,
        replacement_product_image_url,
        replacement_variant_id,
        replacement_variant_title,
        replacement_unit_price,
      })
    );

    if (adjustment.amount_due > 0) {
      const customerEmail =
        originalOrder.email ||
        originalOrder.contact_email ||
        originalOrder.customer?.email ||
        record.customer?.email;
      if (!customerEmail) {
        return res.status(409).send({
          message: "Customer email is required to collect the replacement price difference.",
        });
      }

      if (!StripeAPI.isConfigured()) {
        return res.status(503).send({
          message: "Stripe sandbox is not configured. Add the Stripe test secret key first.",
        });
      }

      const checkoutSession =
        await Services.ReturnExchangePayment.createCheckoutSession({
          record,
          customerEmail,
          amountDue: adjustment.amount_due,
          currency,
        });

      record = await Services.Return.updateStatus(record._id, "payment_pending", {
        label: "Replacement payment requested",
        detail: `${currency} ${adjustment.amount_due.toFixed(2)} Stripe payment requested from ${customerEmail}.`,
        set: {
          exchange_total: { amount: adjustment.replacement_total, currency },
          reorder_details: {
            payment_provider: "stripe",
            stripe_checkout_session_id: checkoutSession.id,
            checkout_url: checkoutSession.url,
            invoice_url: checkoutSession.url,
            payment_status: "pending",
            ...adjustment,
            currency,
            items: reorderItems,
            requested_at: new Date(),
          },
        },
      });
      record = await Services.Return.updateOne(
        { _id: record._id },
        { $addToSet: { processed_actions: actionKey } }
      );

      await Services.ReturnCustomerNotification.sendPaymentLink({
        record,
        customerEmail,
        storeName: req.merchant?.name,
        amount: adjustment.amount_due,
        currency,
        checkoutUrl: checkoutSession.url,
      });

      return res.send({
        data: record,
        message: `${currency} ${adjustment.amount_due.toFixed(2)} Stripe payment link created for the customer.`,
      });
    }

    const newOrder = new shopify.api.rest.Order({ session });
    newOrder.line_items = selections.map((selection) => ({
      variant_id: selection.replacement_variant_id,
      quantity: selection.quantity,
    }));
    if (originalOrder.customer?.id) newOrder.customer = { id: originalOrder.customer.id };
    newOrder.email = originalOrder.email || originalOrder.contact_email || originalOrder.customer?.email;
    newOrder.phone = originalOrder.phone || originalOrder.shipping_address?.phone;
    newOrder.shipping_address = buildShopifyAddress(originalOrder.shipping_address);
    newOrder.billing_address = buildShopifyAddress(
      originalOrder.billing_address || originalOrder.shipping_address
    );
    newOrder.currency = currency;
    newOrder.tags = `REORDER_BY_SWIPE, RETURN_${record.return_number}`;
    newOrder.financial_status = "paid";
    newOrder.discount_codes = [
      {
        code: "SWIPE_RETURN_CREDIT",
        amount: adjustment.credit_applied.toFixed(2),
        type: "fixed_amount",
      },
    ];
    await newOrder.save({ update: true });

    await updateResolvedItems(record._id, selections, "reorder");
    const status = await nextProcessedStatus(record._id, "exchanged");
    record = await Services.Return.updateStatus(record._id, status, {
      label: status === "exchanged" ? "Replacement order created" : "Items reordered",
      detail: `Shopify replacement order ${newOrder.name || newOrder.order_number || newOrder.id} was created.`,
      set: {
        reorder_details: {
          id: newOrder.id,
          name: newOrder.name,
          order_number: newOrder.order_number,
          payment_status: "paid",
          ...adjustment,
          currency,
          items: reorderItems,
          processed_at: new Date(),
        },
        exchange_total: { amount: adjustment.replacement_total, currency },
        processed_at: new Date(),
      },
    });
    record = await Services.Return.updateOne(
      { _id: record._id },
      { $addToSet: { processed_actions: actionKey } }
    );
    await Services.ReturnCustomerNotification.sendReplacementCreated({
      record,
      storeName: req.merchant?.name,
      customerEmail:
        newOrder.email ||
        originalOrder.email ||
        originalOrder.contact_email ||
        originalOrder.customer?.email ||
        record.customer?.email,
      replacementOrder: newOrder,
      items: selections,
      total: adjustment.replacement_total,
      currency,
    });
    return res.send({ data: record, message: "Replacement order created in Shopify." });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/approve", ...returnAuth, async (req, res, next) => {
  try {
    let record = await getRecord(req);
    if (record.outcome === "store_credit" && !["requested", "needs_review"].includes(record.status)) {
      return res.status(409).send({ message: "This store credit return has already been reviewed." });
    }
    if (["declined", "closed", "cancelled"].includes(record.status)) {
      return res.status(409).send({ message: "This return cannot be approved." });
    }
    if (record.shopify_return_id && ["requested", "needs_review"].includes(record.status)) {
      await Services.ShopifyReturns.approve({
        shop: record.shop,
        returnId: record.shopify_return_id,
      });
    }
    record = await Services.Return.updateStatus(record._id, "approved", {
      label: "Return approved",
      detail: "The merchant approved this return.",
      set: { approved_at: new Date(), review_reason: null },
    });
    const order = await Services.Order.get({
      _id: record.order,
      merchant: req.merchant._id,
    });
    const policy = await Services.ReturnPolicy.getOrCreate(req.merchant._id);
    try {
      record = await Services.ReturnShipping.createLabel({
        merchant: req.merchant,
        order,
        policy,
        returnRecord: record,
      });
    } catch (labelError) {
      Logger.error(`Return label pending: ${labelError.stack || labelError.message}`);
    }
    await Services.ReturnCustomerNotification.sendApproved({
      record,
      customerEmail: record.customer?.email,
      storeName: req.merchant?.name,
    });
    return res.send({ data: record, message: "Return approved." });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/decline", ...returnAuth, async (req, res, next) => {
  try {
    const reasonText = String(req.body?.reason || "").trim();
    if (!reasonText) return res.status(400).send({ message: "Decline reason is required." });
    let record = await getRecord(req);
    if (record.outcome === "store_credit" && !["requested", "needs_review"].includes(record.status)) {
      return res.status(409).send({ message: "This store credit return has already been reviewed." });
    }
    if (record.shopify_return_id && ["requested", "needs_review"].includes(record.status)) {
      const allowed = new Set(["FINAL_SALE", "RETURN_PERIOD_ENDED", "OTHER"]);
      const shopifyReason = allowed.has(req.body?.shopify_reason)
        ? req.body.shopify_reason
        : "OTHER";
      await Services.ShopifyReturns.decline({
        shop: record.shop,
        returnId: record.shopify_return_id,
        reason: shopifyReason,
      });
    }
    record = await Services.Return.updateStatus(record._id, "declined", {
      label: "Return declined",
      detail: reasonText,
      set: { decline_reason: reasonText, declined_at: new Date() },
    });
    await Services.ReturnCustomerNotification.sendDeclined({
      record,
      customerEmail: record.customer?.email,
      storeName: req.merchant?.name,
    });
    return res.send({ data: record, message: "Return declined." });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/received", ...returnAuth, async (req, res, next) => {
  try {
    const record = await getRecord(req);
    if (record.outcome === "store_credit" && !["approved", "label_ready", "in_transit"].includes(record.status)) {
      return res.status(409).send({ message: "This store credit return cannot be marked as received again." });
    }
    const updated = await Services.Return.updateStatus(record._id, "received", {
      label: "Return received",
      detail: "The returned parcel was received by the merchant.",
      set: { received_at: new Date() },
    });
    return res.send({ data: updated, message: "Return marked as received." });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
