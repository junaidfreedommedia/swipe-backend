const orderSchema = Models.Order;
const shopify = require("./../shopify.js");
const Order = {};
const { GetFinalPrice } = require("./../../web/utils/functions.js");
const mongoose = require("mongoose");
const EasyPost = require("@easypost/api");
const moment = require('moment-timezone');
const { fetchOrderLineItems } = require("../utils/shopifyLineItems");
const { Types } = require("mongoose");
const ObjectId = Types.ObjectId;
const SpecialOrder = require("../models/SpecialOrder.js");
const Branding = require("../models/Branding.js");
const {
  getMerchantTimezone,
  normalizeTimezone,
} = require("../utils/merchantTimezone");
const api = new EasyPost(process.env.EASYPOST_API_KEY);



Order.insert = async (data) => {
  const orderData = { ...data };
  orderData.iana_timezone = orderData.iana_timezone
    ? normalizeTimezone(orderData.iana_timezone)
    : await getMerchantTimezone(orderData.merchant);

  return new orderSchema(orderData).save({ timestamps: false });
};


Order.get = async (condition, projection, options = { lean: true }) => {
  return orderSchema.findOne(condition, projection, options);
};

Order.getAll = async (condition, projection, options = { lean: true }) => {
  return orderSchema.find(condition, projection, options);
};

Order.aggregate = async (pipeline, allowDiskUse = false) => {
  if (allowDiskUse) return orderSchema.aggregate(pipeline).allowDiskUse(true);
  return orderSchema.aggregate(pipeline);
};

Order.updateOne = async (condition, info) => {
  return orderSchema.updateOne(condition, info);
};

Order.find = async (condition, info, options) => {
  return orderSchema.find(condition, info, options);
};

Order.findOneAndUpdate = async (condition, info, options) => {
  return orderSchema.findOneAndUpdate(condition, info, options);
};

Order.count = async (condition) => {
  return orderSchema.countDocuments(condition);
};


const fetchProductImage = async (session, productId) => {
  if (!productId || !session) return null;

  const client = new shopify.api.clients.Graphql({ session });
  const query = `
    query getProductImage {
      product(id: "gid://shopify/Product/${productId}") {
        images(first: 1) {
          edges {
            node { url }
          }
        }
      }
    }
  `;

  try {
    const response = await client.request(query);
    return response.data.product?.images?.edges?.[0]?.node?.url || null;
  } catch (error) {
    console.error(`❌ ERROR fetching image for product ${productId}:`, error.message);
    return null;
  }
};

const deepMerge = require("lodash.merge");
const fetchProductDetails = async (session, productId) => {
  if (!productId || !session) {
    return { title: null, imageUrl: null };
  }

  const client = new shopify.api.clients.Graphql({ session });
  const query = `
    query getProductDetails {
      product(id: "gid://shopify/Product/${productId}") {
        title
        images(first: 1) {
          edges {
            node { url }
          }
        }
      }
    }
  `;

  try {
    const response = await client.request(query);
    const product = response.data.product;

    return {
      title: product?.title || null,
      imageUrl: product?.images?.edges?.[0]?.node?.url || null,
    };
  } catch (error) {
    console.error(
      `❌ ERROR fetching product details for product ${productId}:`,
      error.message
    );
    return { title: null, imageUrl: null };
  }
};
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (v) =>
  Math.round((toNum(v) + Number.EPSILON) * 100) / 100;

const sumAllocations = (allocs = []) =>
  Array.isArray(allocs)
    ? allocs.reduce((s, a) => s + round2(a?.amount), 0)
    : 0;

const getLineItemSellingPlanTitle = (item = {}) => {
  const directName =
    item?.selling_plan_name ||
    item?.selling_plan_allocation?.name ||
    item?.selling_plan_allocation?.selling_plan?.name ||
    item?.selling_plan_allocation?.selling_plan?.title;

  if (directName) {
    return String(directName).trim();
  }

  const options = Array.isArray(item?.selling_plan_allocation?.selling_plan?.options)
    ? item.selling_plan_allocation.selling_plan.options
    : [];

  if (options.length > 0) {
    return options
      .map((option) => option?.value || option?.name || "")
      .filter(Boolean)
      .join(" / ");
  }

  return "";
};

const hasSubscriptionLineItems = (lineItems = []) =>
  (Array.isArray(lineItems) ? lineItems : []).some((item) => {
    const sellingPlanTitle = getLineItemSellingPlanTitle(item);
    if (sellingPlanTitle) return true;

    const name = String(item?.name || item?.title || "").toLowerCase();
    const vendor = String(item?.vendor || "").toLowerCase();
    
    if (name.includes("subscription") || name.includes("recurring")) return true;
    if (vendor.includes("subscription") || vendor.includes("recurring")) return true;

    if (Array.isArray(item?.properties)) {
      const hasSubProp = item.properties.some(p => {
        const pName = String(p?.name || "").toLowerCase();
        const pValue = String(p?.value || "").toLowerCase();
        return (
          pName.includes("selling_plan") || 
          pName.includes("subscription") || 
          pName.includes("interval") ||
          pValue.includes("subscription") || 
          pValue.includes("recurring") ||
          pValue.includes("month") ||
          pValue.includes("week") ||
          pValue.includes("day") ||
          pValue.includes("year")
        );
      });
      if (hasSubProp) return true;
    }

    return (
      (item?.selling_plan !== undefined && item?.selling_plan !== null) ||
      (item?.selling_plan_id !== undefined && item?.selling_plan_id !== null) ||
      (item?.selling_plan_allocation?.selling_plan?.id !== undefined &&
        item?.selling_plan_allocation?.selling_plan?.id !== null)
    );
  });

const extractOrderSubscriptionPlan = (lineItems = []) => {
  if (!Array.isArray(lineItems)) return "";
  for (const item of lineItems) {
    const title = getLineItemSellingPlanTitle(item);
    if (title) return String(title).trim();
    
    const plan = String(
      item?.shopify_product_info?.subscription_plan ||
      item?.shopify_product_info?.selling_plan ||
      item?.subscription_plan ||
      item?.selling_plan ||
      item?.selling_plan_all ||
      ""
    ).trim();
    if (plan && plan.toLowerCase() !== "subscription") return plan;

    if (Array.isArray(item?.properties)) {
      const found = item.properties.find(p => {
        const pName = String(p?.name || "").toLowerCase();
        const pValue = String(p?.value || "").toLowerCase();
        return (
          pName.includes("subscription") || 
          pName.includes("interval") || 
          pName.includes("selling_plan") ||
          pValue.includes("subscription") ||
          pValue.includes("recurring")
        );
      });
      if (found && found.value) return found.value;
      
      // Look for interval values specifically
      const interval = item.properties.find(p => {
        const val = String(p?.value || "").toLowerCase();
        return val.includes("month") || val.includes("week") || val.includes("year");
      });
      if (interval && interval.value) return interval.value;
    }

    const name = String(item?.name || item?.title || "").toLowerCase();
    const vendor = String(item?.vendor || "").toLowerCase();
    if (name.includes("subscription") || vendor.includes("subscription")) return "Subscription";
    if (name.includes("recurring") || vendor.includes("recurring")) return "Subscription";
  }
  return "";
};

Order.updateOrderDetails = async (payload, shop) => {
  try {
    const orderIdRaw = payload?.order_edit?.order_id ?? payload?.id;
    const orderId = Number(orderIdRaw);
    const orderPayload = payload.order_edit?.order || payload;

    if (!Number.isFinite(orderId) || !orderPayload) {
      console.warn("⚠️ Invalid webhook payload. Missing order ID or order object.");
      return;
    }

    // 1️⃣ Resolve merchant (prefer shop -> safe & index-friendly)
    let merchantId = null;
    let merchantDoc = null;
    if (shop) {
      merchantDoc = await Services.Merchant.get({ shop_id: shop });
      if (merchantDoc?._id) merchantId = merchantDoc._id;
    }

    // 2️⃣ Get existing order (use { merchant, id } when possible)
    const existingOrder = await Order.get(
      merchantId
        ? { id: orderId, merchant: merchantId }
        : { id: orderId }
    );
    if (!existingOrder) {
      console.warn("⚠️ Local order not found for update", { orderId, shop });
      return;
    }

    const baseOrder =
      typeof existingOrder.toObject === "function"
        ? existingOrder.toObject()
        : existingOrder;

    // 3️⃣ Resolve merchant (guarantee non-null)
    merchantId = merchantId || existingOrder.merchant;
    if (!merchantId) {
      console.error("🚨 Merchant missing — aborting update", { orderId, shop });
      return;
    }
    const orderTimezone = await getMerchantTimezone(
      merchantDoc || merchantId
    );

    // 3️⃣ Shopify session (same as old)
    const session = await Services.ShopifySession.get({ shop });

    // Fetch live plan details from Shopify for accuracy
    let shopifyPlanDetails = new Map();
    if (session) {
      try {
        shopifyPlanDetails = await fetchOrderLineItems(session, orderId);
      } catch (err) {
        console.error("Failed to fetch shopify plan details during update:", err.message);
      }
    }

    // 4️⃣ Merge line items (OLD logic preserved)
    const incomingLineItems = orderPayload.line_items || [];
    let mergedLineItems = [];

    const allLineItemIds = new Set([
      ...incomingLineItems.map((item) => String(item.id)),
      ...(baseOrder.line_items || []).map((item) => String(item.id)),
    ]);

    for (const lineItemId of allLineItemIds) {
      const incomingItem = incomingLineItems.find(
        (item) => String(item.id) === lineItemId
      );
      const existingItem = (baseOrder.line_items || []).find(
        (item) => String(item.id) === lineItemId
      );

      let finalItem = { ...existingItem };

      if (incomingItem) {
        const qty =
          incomingItem.current_quantity ??
          incomingItem.quantity ??
          finalItem?.quantity ??
          0;

        const unitPrice = round2(incomingItem.price ?? finalItem.price ?? 0);
        const lineTotal = round2(unitPrice * qty);

        const allocations = incomingItem.discount_allocations || [];
        const lineDiscount = round2(sumAllocations(allocations));

        const unitDiscount = qty > 0 ? round2(lineDiscount / qty) : 0;
        const unitFinalPrice = round2(Math.max(unitPrice - unitDiscount, 0));

        const sellingPlan = shopifyPlanDetails.get(String(incomingItem?.admin_graphql_api_id || finalItem?.admin_graphql_api_id))?.sellingPlanName ||
          getLineItemSellingPlanTitle(incomingItem) ||
          finalItem?.selling_plan_name ||
          "";

        finalItem = {
          ...finalItem,
          ...incomingItem,

          quantity: qty,
          price: unitPrice.toFixed(2),

          // line-level discount
          total_discount: lineDiscount.toFixed(2),

          // unit final price (frontend expects this)
          final_price: unitFinalPrice.toFixed(2),
          discount_allocations: allocations,
          selling_plan_name: sellingPlan,
          shopify_product_info: {
            subscription_plan: sellingPlan,
            vendor: incomingItem?.vendor || finalItem?.vendor,
            product_title: incomingItem?.title || incomingItem?.name || finalItem?.title || finalItem?.name
          },

          // optional but useful
          line_total: lineTotal.toFixed(2),
          final_line_total: round2(unitFinalPrice * qty).toFixed(2),
        };


      }

      // Fetch product details (same as old)
      if (session && finalItem?.product_id) {
        const fetched = await fetchProductDetails(
          session,
          finalItem.product_id
        );
        if (fetched.title) finalItem.title = fetched.title;
        if (fetched.imageUrl) finalItem.image_url = fetched.imageUrl;
      }

      mergedLineItems.push(finalItem);
    }
    const discountApplications = orderPayload.discount_applications || [];
    const hasAcrossDiscount = discountApplications.some(
      (d) => d.allocation_method === "across"
    );

    const orderLevelDiscount = round2(
      orderPayload.total_discounts ??
      orderPayload.total_discounts_set?.shop_money?.amount ??
      0
    );

    if (hasAcrossDiscount && orderLevelDiscount > 0) {
      const existingDiscountSum = round2(
        mergedLineItems.reduce(
          (s, li) => s + round2(li.total_discount),
          0
        )
      );

      const remaining = round2(orderLevelDiscount - existingDiscountSum);

      if (remaining > 0.009) {
        const eligible = mergedLineItems.filter(
          (li) => toNum(li.quantity) > 0 && toNum(li.price) > 0
        );

        const eligibleSubtotal = round2(
          eligible.reduce(
            (s, li) =>
              s + round2(toNum(li.price) * toNum(li.quantity)),
            0
          )
        );

        if (eligibleSubtotal > 0) {
          let allocatedSoFar = 0;

          mergedLineItems = mergedLineItems.map((li) => {
            const qty = toNum(li.quantity);
            const unitPrice = round2(li.price);
            const lineTotal = round2(unitPrice * qty);

            if (qty <= 0 || unitPrice <= 0) return li;

            let addDiscount = round2(
              (lineTotal / eligibleSubtotal) * remaining
            );

            if (allocatedSoFar + addDiscount > remaining) {
              addDiscount = round2(remaining - allocatedSoFar);
            }

            allocatedSoFar = round2(allocatedSoFar + addDiscount);

            const newLineDiscount = round2(
              round2(li.total_discount) + addDiscount
            );

            const unitDiscount = qty > 0
              ? round2(newLineDiscount / qty)
              : 0;

            const unitFinal = round2(
              Math.max(unitPrice - unitDiscount, 0)
            );

            const newAllocations = Array.isArray(li.discount_allocations)
              ? [...li.discount_allocations]
              : [];

            newAllocations.push({
              amount: addDiscount.toFixed(2),
              discount_application_index: 0,
            });

            return {
              ...li,
              total_discount: newLineDiscount.toFixed(2),
              final_price: unitFinal.toFixed(2),
              discount_allocations: newAllocations,
              final_line_total: round2(unitFinal * qty).toFixed(2),
            };
          });
        }
      }
    }


    // 5️⃣ Cancel / refund / return logic (OLD behaviour)
    const orderCancelled = !!orderPayload.cancelled_at;
    const orderRefunded =
      ["refunded", "partially_refunded"].includes(
        orderPayload.financial_status
      );
    const orderReturned =
      Array.isArray(orderPayload.returns) &&
      orderPayload.returns.length > 0;

    let is_swipe_refunded = false;
    let is_swipe_returned = false;

    const swipeItem = mergedLineItems.find((li) =>
      li.title?.includes("Swipe Package Protection")
    );

    if (swipeItem) {
      if (swipeItem.refunded || Number(swipeItem.refund_amount) > 0) {
        is_swipe_refunded = true;
      }

      if (orderReturned) {
        for (const ret of orderPayload.returns) {
          if (
            ret.return_line_items?.some(
              (r) => String(r.line_item_id) === String(swipeItem.id)
            )
          ) {
            is_swipe_returned = true;
          }
        }
      }
    }

    if (orderCancelled) {
      mergedLineItems = mergedLineItems.map((li) => {
        if (li.title?.includes("Swipe Package Protection")) {
          return {
            ...li,
            refunded: true,
            refund_amount: parseFloat(li.price || 0).toFixed(2),
            final_price: "0.00",
            quantity: 0,
          };
        }
        return li;
      });
    }


    const subtotal = mergedLineItems.reduce((sum, li) => {
      const qty = toNum(li.quantity);
      const unitFinal = round2(li.final_price);
      return round2(sum + unitFinal * qty);
    }, 0);


    // 🔒 SAFE MERGE — do NOT overwrite with null / undefined
    const safePayload = {};

    for (const [key, value] of Object.entries(orderPayload)) {
      if (value !== null && value !== undefined) {
        if (key === "tags" && typeof value === "string") {
          safePayload[key] = value.split(",").map((t) => t.trim()).filter(Boolean);
        } else {
          safePayload[key] = value;
        }
      }
    }

    const updatedOrder = deepMerge({}, baseOrder, safePayload);

    // Shopify webhook arrays are complete snapshots. lodash.merge combines
    // arrays by index, which can retain stale refund/transaction entries after
    // a later order edit sends a shorter array. Replace every provided
    // top-level array wholesale; line_items is set to the enriched snapshot
    // immediately below.
    for (const [key, value] of Object.entries(safePayload)) {
      if (Array.isArray(value)) {
        updatedOrder[key] = value;
      }
    }


    updatedOrder.id = orderId;
    updatedOrder.merchant = merchantId;
    updatedOrder.iana_timezone = orderTimezone;
    updatedOrder.line_items = mergedLineItems;
    updatedOrder.is_subscription = hasSubscriptionLineItems(mergedLineItems);
    updatedOrder.subscription_plan = extractOrderSubscriptionPlan(mergedLineItems);
    updatedOrder.subtotal_price = subtotal.toFixed(2);
    updatedOrder.total_line_items_price = subtotal.toFixed(2);

    // ❗ KEEP Shopify-calculated total_price if present
    if (orderPayload.total_price) {
      updatedOrder.total_price = orderPayload.total_price;
    }

    updatedOrder.updatedAt = new Date();
    updatedOrder.order_number =
      baseOrder.order_number || orderPayload.order_number;

    const protectionItem = mergedLineItems.find((li) =>
      li.title?.includes("Swipe Package Protection")
    );

    updatedOrder.protection_item = protectionItem || null;
    updatedOrder.is_protected = !!protectionItem;
    updatedOrder.protection_amount = protectionItem
      ? protectionItem.final_price || "0.00"
      : "0.00";

    // ⛔ Safety: Remove internal Mongo fields from the $set object 
    // to prevent "Modifying _id is not allowed" errors.
    delete updatedOrder._id;
    delete updatedOrder.__v;

    // 8️⃣ Update MAIN order (FIXED: use _id)
    await Order.findOneAndUpdate(
      { _id: existingOrder._id },
      { $set: updatedOrder },
      { new: true }
    );

    // 9️⃣ SpecialOrder (OLD feature preserved)
    let eventType = "update";
    let eventStatus = "updated";

    if (orderCancelled) {
      eventType = "cancel";
      eventStatus = "cancelled";
    } else if (orderReturned) {
      eventType = "return";
      eventStatus = "returned";
    } else if (orderPayload.financial_status === "refunded") {
      eventType = "refund";
      eventStatus = "refunded";
    }

    await SpecialOrder.findOneAndUpdate(
      { merchant: merchantId, order_id: orderId },
      {
        $set: {
          order_id: orderId,
          order_number: updatedOrder.order_number,
          type: eventType,
          amount: subtotal.toFixed(2),
          status: eventStatus,
          payload: updatedOrder,
          merchant: merchantId,
          swipe_flags: {
            is_swipe_refunded,
            is_swipe_returned,
          },
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true, new: true }
    );

    console.log(
      `✅ SUCCESS: Order ${orderId} updated (OLD behaviour preserved)`
    );
  } catch (error) {
    console.error("❌ ERROR: Failed to update order details:", error);
    await Services.WebhookError.handle({
      webhook_error:
        error instanceof Error ? error.message : JSON.stringify(error),
      webhook_payload: payload,
      webhook_name: "updateOrderDetails",
      shop_domain: shop || "Unknown Shop",
    });
  }
};


/**
 * Handles the 'orders/create' webhook from Shopify.
 * This function uses Shopify's own pre-calculated discount allocations 
 * to ensure 100% accuracy for final prices and totals.
 */
Order.handleOrderCreate = async (shop_id, payload, protection) => {
  try {
    console.log("HANDLE ORDER CREATE :", payload.id);

    // 🔹 Log the incoming webhook payload for debugging
    Services.WebhookError.insert({
      webhook_name: "OrderCreateWebhookLogs",
      webhook_payload: payload,
    });

    // 🔹 Get merchant and session information
    const merchantInfo = await Services.Merchant.get({ shop_id });
    if (!merchantInfo) throwError(MSG.MERCHANT_NOT_EXIST);

    const { _id: mId, name: merchant_name, store_logo: storeLogoField } = merchantInfo;
    const is_billing = merchantInfo.is_billing || false;
    const billing_type = is_billing
      ? merchantInfo.billing_type === "shopify"
        ? "shopify"
        : "external"
      : "external";
    const session = await Services.ShopifySession.get({ shop: merchantInfo.shop_id });

    // 🔹 Get branding logo
    let brandingDoc = null;
    try {
      brandingDoc = await Services.Branding.get(
        { merchant: mId, type: "swipe", sub_type: "order" },
        { logo: 1 }
      );
    } catch (error) {
      console.log(error);
    }

    const storeLogo =
      (brandingDoc && brandingDoc.logo) ||
      storeLogoField ||
      merchantInfo?.settings?.branding?.logo;

    // 🔹 Process line items: fetch images and calculate final prices
    if (payload.line_items && session) {
      // 1️⃣ Fetch live plan details from Shopify GraphQL to be 100% accurate
      let shopifyPlanDetails = new Map();
      try {
        shopifyPlanDetails = await fetchOrderLineItems(session, payload.admin_graphql_api_id || payload.id);
      } catch (err) {
        console.error("Failed to fetch shopify plan details during creation:", err.message);
      }

      const updatedLineItems = await Promise.all(
        payload.line_items.map(async (item) => {
          const plainItem = { ...item };

          // Fetch product image
          if (plainItem.product_id) {
            try {
              const imageUrl = await fetchProductImage(session, plainItem.product_id);
              plainItem.image_url = imageUrl;
            } catch (imgError) {
              console.error(`Failed to fetch image for product ${plainItem.product_id}:`, imgError);
              plainItem.image_url = null; // Set a default on failure
            }
          }

          // ✅ FINAL CORRECTED LOGIC
          const totalDiscount = (plainItem.discount_allocations || []).reduce(
            (sum, allocation) => sum + parseFloat(allocation.amount || 0),
            0
          );

          const qty = toNum(plainItem.quantity);
          const unitPrice = round2(plainItem.price);
          const lineTotal = round2(unitPrice * qty);

          const lineDiscount = round2(totalDiscount);
          const unitDiscount = qty > 0 ? round2(lineDiscount / qty) : 0;
          const unitFinal = round2(Math.max(unitPrice - unitDiscount, 0));

          plainItem.price = unitPrice.toFixed(2);
          plainItem.total_discount = lineDiscount.toFixed(2);
          plainItem.final_price = unitFinal.toFixed(2);
          plainItem.line_total = lineTotal.toFixed(2);
          plainItem.final_line_total = round2(unitFinal * qty).toFixed(2);
          
          // Apply live selling plan name if found
          const shopifyDetail = shopifyPlanDetails.get(String(plainItem.admin_graphql_api_id || ""));
          if (shopifyDetail?.sellingPlanName) {
            plainItem.selling_plan_name = shopifyDetail.sellingPlanName;
          } else {
            plainItem.selling_plan_name = getLineItemSellingPlanTitle(plainItem);
          }

          // Apply detailed product info for rich tooltips
          plainItem.shopify_product_info = {
            subscription_plan: plainItem.selling_plan_name,
            vendor: plainItem.vendor,
            product_title: plainItem.title || plainItem.name
          };

          return plainItem;
        })
      );
      // Replace original line_items with the enriched ones
      payload.line_items = updatedLineItems;
    }

    // 🔹 Clean up tags
    const tags = payload.tags || "";
    const parsedTags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);

    // ✅ Shopify "Order Placed" time (authoritative)
    const shopifyCreatedAt = new Date(
      payload.processed_at || payload.created_at
    );

    let orderDetails = {
      ...payload,
      tags: parsedTags,

      // ✅ FORCE Mongo createdAt = Shopify created_at
      createdAt: shopifyCreatedAt,
      updatedAt: shopifyCreatedAt,

      // (optional but fine to keep)
      order_created_at: shopifyCreatedAt,

      merchant: mId,
      iana_timezone: normalizeTimezone(merchantInfo.iana_timezone),
      tracking_status: "unfulfilled",
      "customer.name": `${payload.customer?.first_name || ''} ${payload.customer?.last_name || ''}`.trim(),
      browser_ip: payload.browser_ip,
      is_subscription: hasSubscriptionLineItems(payload.line_items),
      subscription_plan: extractOrderSubscriptionPlan(payload.line_items),
    };


    // 🔹 Map discount applications for reporting purposes
    if (payload.discount_applications && payload.discount_applications.length > 0) {
      orderDetails.discount_applications = payload.discount_applications.map((d) => ({
        application_type: d.type,
        title: d.title,
        description: d.description,
        value: d.value?.toString() || "0",
        value_type: d.value_type,
        allocation_method: d.allocation_method,
        target_selection: d.target_selection,
        target_type: d.target_type,
      }));
    }

    // Clean order name/number
    if (orderDetails.name) {
      orderDetails.name = orderDetails.name.replace(/[^0-9]/g, "");
    }

    // Add protection data if it exists
    if (!empty(protection)) {
      orderDetails.protection_amount = protection.price;
      orderDetails.protection_item = protection;
      orderDetails.is_protected = true;
    }

    // 🔹 Save the final order object to your database
    // NOTE: Shopify can (and does) deliver duplicate webhooks.
    // With a unique index on { merchant, id } we must gracefully ignore duplicates
    // to avoid duplicate emails / events.
    let createOrder;
    try {
      createOrder = await Order.insert(orderDetails);
      await Order.findOneAndUpdate(
        { _id: createOrder._id },
        { $set: { merchantName: merchantInfo.name } },
        { timestamps: false }
      );

    } catch (e) {
      const isDup =
        e &&
        (e.code === 11000 ||
          String(e.message || "").includes("E11000 duplicate key"));
      if (isDup) {
        console.warn(
          "⚠️ Duplicate orders/create webhook ignored (order already exists)",
          { merchant: String(mId), id: payload?.id }
        );
        return;
      }
      throw e;
    }

    // 🔹 --- Post-Save Actions ---
    const branding = await Branding.findOne({
      merchant: mId,
      type: "swipe",
      sub_type: "order"
    });
    // Send notifications
    if (protection && branding?.swipe_order_email_enabled !== false) {
      try {
        await Notifications.sendNotification({
          subject: `Your Order is Protected!`,
          to: [createOrder.customer.email],
          template: "ORDER_CREATE_CUSTOMER",
          store_logo: storeLogo,
          store_name: merchant_name,
          store_url: merchant_name?.toLowerCase().includes("lola")
            ? "https://lolaandtheboys.com/"
            : "",
          query_string: `https://swipe.ai/file-a-claim/?mid=${String(mId)}&oid=${createOrder.id}&mn=${merchant_name}&on=${createOrder.order_number}&em=${createOrder.customer.email}&cn=${createOrder.customer.name}`
        });
        console.log("✅ ORDER_CREATE_CUSTOMER Email Sent");
      } catch (e) {
        console.error("❌ Failed to send ORDER_CREATE_CUSTOMER email:", e.message);
      }
    }
    else {
      console.log("⚠️ Swipe order email disabled for merchant:", merchantInfo.name);
    }


    // Create an event log
    if (createOrder) {
      await Services.Event.insert({
        order: createOrder._id,
        merchant: mId,
        type: EVENT_TYPE.ACTION,
        sub_type: EVENT_SUBTYPE.ORDER_CREATED,
        action_on: ACTIVITY_LOG_LABEL.SYSTEM,
        title: EVENT_TITLE.ORDER_CREATED,
        ts: Math.floor(new Date().getTime() / 1000),
      });
    }

    // Handle billing — only if Billing service is available (not all callers have it)
    if (is_billing && protection && Services.Billing?.createUsageRecord) {
      try {
        const resp = await Services.Billing.createUsageRecord({
          billing_type,
          shop: shop_id,
          amount: Number(protection.price),
          merchant: mId,
          order: createOrder._id,
          charge_shopify_now: billing_type !== "shopify",
        });
        if (resp.capacityReached && !resp.createdRecord) {
          throwError(MSG.CAPACITY_REACHED);
        }
      } catch (billingErr) {
        console.error("❌ Billing createUsageRecord failed:", billingErr.message);
        // Don't throw — order is already saved, billing failure shouldn't undo the order
      }
    }

    // Track line items — only if LineItemTracking service is available
    if (Services.LineItemTracking?.processOrderLineItems) {
      try {
        await Services.LineItemTracking.processOrderLineItems({
          merchantId: mId,
          orderId: createOrder._id,
          shopifyOrderId: payload.id,
          lineItems: payload.line_items,
        });
      } catch (err) {
        Services.WebhookError.handle({
          webhook_error: err instanceof Error ? err.message : JSON.stringify(err),
          webhook_payload: payload,
          webhook_name: "LineItemTracking",
        });
      }
    }

  } catch (err) {
    // 🔹 Master error handler
    console.log("❌ Error in handleOrderCreate:", err);
    Services.WebhookError.handle({
      webhook_error: err instanceof Error ? err.message : JSON.stringify(err),
      webhook_payload: payload,
      webhook_name: "OrderCreateWebhook",
      shop_domain: shop_id || "Unknown Shop",
    });
  }

  // Return an empty promise to acknowledge the webhook receipt
  return Promise.resolve({});
};

Order.handleOrderFulfilled = async (shop_id, payload, protectedOrder) => {
  try {
    const merchantInfo = await Services.Merchant.get({ shop_id });
    if (!merchantInfo) throwError("Merchant Not Found");
    const { _id: mId } = merchantInfo;
    let order = await Order.get({ id: payload.id, merchant: mId });
    if (!order) {
      console.warn(`[OrderFulfilled] Order ${payload.id} not found in DB. Skipping — use backfill API to recover.`);
      return Promise.resolve({});
    }
    const fulfillment = payload.fulfillments[0];
    const trackingNumber = fulfillment?.tracking_number;
    const carrier = fulfillment?.tracking_company;
    if (trackingNumber) {
      let existingTrackerIds = order.tracking_ids || [];

      if (!existingTrackerIds.includes(trackingNumber)) {
        existingTrackerIds.push(trackingNumber);

        await Order.findOneAndUpdate(
          { id: payload.id, merchant: mId },
          {
            $set: {
              tracking_id: trackingNumber,
              tracking_ids: existingTrackerIds,
              tracking_status: "fulfilled",
              fulfillments: payload.fulfillments,
            },
          },
          { new: true }
        );
      }
    }

    await Order.findOneAndUpdate(
      { id: payload.id, merchant: mId },
      { $set: { fulfillments: payload.fulfillments } },
      { new: true }
    );
    let allLineItemIds = [];
    for (let fulfillment of payload.fulfillments) {
      let lineItemIds = fulfillment.line_items.map((lineItm) => lineItm.id);
      allLineItemIds = [...allLineItemIds, ...lineItemIds];
    }
    if (protectedOrder && !allLineItemIds.includes(protectedOrder.id)) {
      console.log("Not including Protected Product, attempting to fulfill it separately.");
      const session = await Services.ShopifySession.get({ shop: shop_id });
      if (session) {
        const allFulfillmentOrders = await shopify.api.rest.FulfillmentOrder.all({
          session,
          order_id: payload.id,
        });
        const allOpenOrders = allFulfillmentOrders.data.filter((all_full_itm) => all_full_itm.status == "open");
        let needToFulfilled = [];
        for (let openOrder of allOpenOrders) {
          for (let openOrderLineItem of openOrder.line_items) {
            if (openOrderLineItem.line_item_id == protectedOrder.id) {
              needToFulfilled = [{
                fulfillment_order_id: openOrderLineItem.fulfillment_order_id,
                fulfillment_order_line_items: [{
                  id: openOrderLineItem.id,
                  quantity: protectedOrder.quantity,
                }],
              }];
              break;
            }
          }
          if (needToFulfilled.length) break;
        }
        if (needToFulfilled.length) {
          const fulfillment = new shopify.api.rest.Fulfillment({ session });
          fulfillment.line_items_by_fulfillment_order = needToFulfilled;
          await fulfillment.save({ update: true });
          console.log("✅ Protected product fulfillment initiated successfully.");
        }
      }
    }
    return Promise.resolve({});
  } catch (error) {
    console.log(error);
    await Services.WebhookError.handle({
      webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
      webhook_payload: payload,
      webhook_name: "OrderFulfilledWebhook",
      shop_domain: shop_id || "Unknown Shop",
    });
    Logger.error(error.stack);
    return Promise.reject(error);
  }
};

const handleRefunds = async (shop, payload, eventType) => {
  try {
    const shopifyOrderId = payload.order_id || payload.order?.id;
    if (!shopifyOrderId) {
      console.warn("⚠️ Missing order ID in refund payload.");
      return;
    }

    const merchantInfo = await Services.Merchant.get({ shop_id: shop });
    if (!merchantInfo) {
      console.warn("⚠️ Merchant not found.");
      return;
    }

    const order = await Services.Order.get({
      id: shopifyOrderId,
      merchant: merchantInfo._id,
    });

    if (!order) {
      console.warn("⚠️ Order not found for refund event.");
      return;
    }

    /* -------------------------------------------------
       BASE UPDATE (NON-DESTRUCTIVE)
    ------------------------------------------------- */
    const updatedFields = {
      refunds: payload.refunds ?? order.refunds,
      returns: payload.returns ?? order.returns,
      return_status: eventType,
      updatedAt: new Date(),
    };

    /* -------------------------------------------------
       REFUND CREATE — OLD LOGIC RESTORED
    ------------------------------------------------- */
    if (
      eventType === "refund_create" &&
      Array.isArray(payload.refund_line_items) &&
      payload.refund_line_items.length > 0
    ) {
      const updatedLineItems = order.line_items.map((dbItem) => {
        const refundedItem = payload.refund_line_items.find(
          (rli) => String(rli.line_item_id) === String(dbItem.id)
        );

        if (!refundedItem) return dbItem;

        const refundedQty = Number(refundedItem.quantity || 0);
        const currentQty = Number(dbItem.quantity || 0);

        const remainingQty = Math.max(0, currentQty - refundedQty);

        return {
          ...dbItem,
          quantity: remainingQty, // UI consistency only
          refunded: true,
          refund_amount: String(
            refundedItem.subtotal ??
            refundedItem.subtotal_set?.shop_money?.amount ??
            "0.00"
          ),
          // ❗ DO NOT TOUCH final_price
          // ❗ DO NOT ZERO IT
        };
      });

      updatedFields.line_items = updatedLineItems;
      updatedFields.claim_resolve_with = "REFUND";
    }

    /* -------------------------------------------------
       CLAIM RESOLUTION — OLD BEHAVIOR
    ------------------------------------------------- */
    if (Array.isArray(payload.transactions)) {
      const refundTxns = payload.transactions.filter(
        (t) => t.kind?.toLowerCase() === "refund"
      );

      const totalRefundAmount = refundTxns.reduce(
        (sum, t) => sum + parseFloat(t.amount || 0),
        0
      );

      const claim = await Services.Claim.get({ order: order._id });
      if (claim) {
        await Services.Claim.findOneAndUpdate(
          { order: order._id },
          {
            $set: {
              status: "RESOLVED",
              refund_total: totalRefundAmount.toFixed(2),
              claim_total: totalRefundAmount.toFixed(2),
            },
          }
        );
      }
    }

    /* -------------------------------------------------
       RETURNS (APPROVE / CLOSE ETC.) — OLD SAFE LOGIC
    ------------------------------------------------- */
    if (
      eventType.startsWith("returns_") &&
      Array.isArray(payload.return_line_items)
    ) {
      const updatedLineItems = order.line_items.map((dbItem) => {
        const returnedItem = payload.return_line_items.find(
          (rli) => String(rli.line_item_id) === String(dbItem.id)
        );

        if (!returnedItem) return dbItem;

        const returnedQty = Number(returnedItem.quantity || 0);
        const currentQty = Number(dbItem.quantity || 0);

        return {
          ...dbItem,
          quantity: Math.max(0, currentQty - returnedQty),
          returned: true,
          // ❗ final_price untouched
        };
      });

      updatedFields.line_items = updatedLineItems;
      updatedFields.returns = payload.returns;
    }

    /* -------------------------------------------------
       FINAL UPDATE
    ------------------------------------------------- */
    await Services.Order.findOneAndUpdate(
      { id: shopifyOrderId, merchant: merchantInfo._id },
      { $set: updatedFields },
      { new: true }
    );

    console.log(
      `✅ SUCCESS: Order ${shopifyOrderId} updated (refund logic restored)`
    );
  } catch (error) {
    console.error("❌ ERROR in handleRefunds:", error);
    await Services.WebhookError.handle({
      webhook_error:
        error instanceof Error ? error.message : JSON.stringify(error),
      webhook_payload: payload,
      webhook_name: "handleRefunds",
      shop_domain: shop || "Unknown Shop",
    });
    throw error;
  }
};

Order.handleRefunds = handleRefunds;


Order.OrderList = async (req) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 25;
    let page = parseInt(req.query.page, 10) || 1;
    const isAdmin = req.user?.role === "admin";
    const isRestrictedAdmin =
      isAdmin && req.user?.admin_type === ADMIN_TYPE.SIMPLE_ADMIN;
    const assignedMerchantIds = (req.user?.merchants || []).map(String);

    // 1. Base Filter Build
    const baseFilter = {};

    // Merchant Logic
    if (req.query.merchant) {
      if (
        isRestrictedAdmin &&
        !assignedMerchantIds.includes(String(req.query.merchant))
      ) {
        throwError("You do not have access to this store.", 403);
      }
      baseFilter.merchant = new mongoose.Types.ObjectId(req.query.merchant);
    } else if (isRestrictedAdmin) {
      baseFilter.merchant = {
        $in: assignedMerchantIds.map((id) => new mongoose.Types.ObjectId(id)),
      };
    } else if (!isAdmin && req.merchant) {
      baseFilter.merchant = req.merchant._id;
    }

    // Boolean Logic (Safe)
    if (String(req.query.is_protected).toLowerCase() === "true") baseFilter.is_protected = true;
    if (String(req.query.is_protected).toLowerCase() === "false") baseFilter.is_protected = false;

    // Search
    if (req.query.search) {
      const s = req.query.search.trim();
      if (/^\d+$/.test(s)) baseFilter.order_number = Number(s);
      else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
        // Resolve every stored spelling through the case-insensitive email index.
        // Keep default collation on the final query so other filters are unchanged.
        // distinct() would collapse differently-cased addresses and lose matches.
        const emailMatches = await orderSchema
          .find({ "customer.email": s })
          .select({ _id: 0, "customer.email": 1 })
          .collation({ locale: "en", strength: 2 })
          .lean();
        baseFilter["customer.email"] = {
          $in: [...new Set(emailMatches.map((order) => order.customer.email))],
        };
      }
      else baseFilter.$or = [
        { "customer.email": { $regex: "^" + s, $options: "i" } },
        { "customer.name": { $regex: "^" + s, $options: "i" } }
      ];
    }

    // Date & Tags
    if (req.query.start_date && req.query.end_date) {
      const tz = "America/Chicago";
      const start = moment.tz(req.query.start_date, "M-DD-YYYY", tz).startOf("day").utc().toDate();
      const end = moment.tz(req.query.end_date, "M-DD-YYYY", tz).endOf("day").utc().toDate();
      baseFilter.createdAt = { $gte: start, $lte: end };
    }

    if (req.query.tags && typeof req.query.tags === "string" && req.query.tags.trim().length > 0) {
      baseFilter.tags = { $all: req.query.tags.split(",").map(t => t.trim()) };
    }

    if (req.query.status && req.query.status.trim()) baseFilter.tracking_status = req.query.status.trim();
    else if (req.query.tracking_status && req.query.tracking_status.trim()) baseFilter.tracking_status = req.query.tracking_status.trim();

    const subscriptionQuery = String(req.query.is_subscription).toLowerCase();
    if (subscriptionQuery === "true") {
      const subscriptionCondition = {
        $or: [
          { is_subscription: true },
          { "line_items.selling_plan_name": { $exists: true, $nin: ["", null] } },
        ],
      };

      if (baseFilter.$or) {
        const searchConditions = baseFilter.$or;
        delete baseFilter.$or;
        baseFilter.$and = [...(baseFilter.$and || []), { $or: searchConditions }, subscriptionCondition];
      } else {
        baseFilter.$and = [...(baseFilter.$and || []), subscriptionCondition];
      }
    }

    if (subscriptionQuery === "false") {
      baseFilter.is_subscription = false;
    }

    // 2. Count Total Records
    let totalRecords;
    const isCleanAdminView = isAdmin && Object.keys(baseFilter).length === 0;

    if (isCleanAdminView) {
      totalRecords = await orderSchema.estimatedDocumentCount();
    } else {
      totalRecords = await orderSchema.countDocuments(baseFilter);
    }

    // 🛑 CRITICAL FIX: Handle 0 Records Early
    if (totalRecords === 0) {
      return {
        message: MSG.DATA_NOT_FOUND,
        data: { totalRecords: 0, totalPages: 0, currentPage: 1, response: [], nextCursor: null }
      };
    }

    // 3. Safety Check: Page Overflow (Reset Logic)
    // Ye step 'skip' calculate karne se PEHLE hona chahiye
    const totalPages = Math.ceil(totalRecords / limit) || 1;

    // Agar user Page 60 maang raha hai, lekin total pages sirf 2 hain -> Page = 2 kar do
    if (page > totalPages && !req.query.lastId) {
      page = totalPages;
    }

    // 4. Pagination Logic
    const projection = {
      order_number: 1, "customer.email": 1, createdAt: 1, tracking_status: 1,
      tags: 1, is_protected: 1, merchantName: 1, merchant: 1,
      is_subscription: 1, subscription_plan: 1,
      "line_items.name": 1,
      "line_items.title": 1,
      "line_items.variant_title": 1,
      "line_items.image_url": 1,
      "line_items.selling_plan_name": 1,
      "line_items.subscription_plan": 1,
      "line_items.vendor": 1,
      "line_items.shopify_product_info": 1
    };

    let rawOrders = [];
    // Ab 'skip' calculate karein (Correct Page ke sath)
    let skip = (page - 1) * limit;

    // REVERSE LOGIC CONDITION
    if (skip > (totalRecords / 2) && !req.query.lastId) {

      const pagesFromEnd = totalPages - page;
      // 🛡️ Math.max ensure karega ke value kabhi -1425 na ho, kam se kam 0 rahe
      const reverseSkip = Math.max(0, pagesFromEnd * limit);

      let reverseLimit = limit;
      if (page === totalPages) {
        reverseLimit = totalRecords % limit || limit;
      }

      rawOrders = await orderSchema
        .find(baseFilter)
        .select(projection)
        .sort({ _id: 1 }) // Reverse Sort
        .skip(reverseSkip)
        .limit(reverseLimit)
        .lean();

      rawOrders.reverse(); // Newest First

    } else {
      // NORMAL LOGIC
      let query = orderSchema.find(baseFilter).select(projection).sort({ _id: -1 });

      if (req.query.lastId) {
        baseFilter._id = { $lt: new mongoose.Types.ObjectId(req.query.lastId) };
        query = orderSchema.find(baseFilter).select(projection).sort({ _id: -1 }).limit(limit);
      } else {
        query = query.skip(skip).limit(limit);
      }

      rawOrders = await query.lean();
    }

    const nextCursor = rawOrders.length > 0 ? rawOrders[rawOrders.length - 1]._id : null;

    return {
      message: rawOrders.length ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
      data: {
        totalRecords,
        totalPages,
        currentPage: page,
        response: rawOrders,
        nextCursor
      }
    };

  } catch (err) {
    console.error("OrderList Error:", err);
    throw err;
  }
};

Order.ProductList = async (req) => {
  try {
    const { orderId, merchant } = req;
    let orderInfo = await Services.Order.get({
      order_number: Number(orderId),
      merchant: merchant,
    });
    console.log("orderInfo", orderInfo);
    if (!orderInfo) {
      throwError("No data found for the provided information.");
    } else {
      const claim = await Services.Claim.get({ order: orderInfo._id });
      if (claim) {
        throwError(
          "The claim has been already created for this order. Swipe Team will reach out to you soon."
        );
      }
    }
    const merchantInfo = await Services.Merchant.get({ _id: merchant });
    const response = await GetFinalPrice(orderInfo._id);
    orderInfo = response.response;
    orderInfo.line_items = orderInfo.line_items.filter(
      (lineItem) => !([PRODUCT_TITLE, "Swipe Package Protection"].includes(lineItem.title))
    );
    const productDetails = orderInfo.line_items.map((item) => ({
      product_id: item.id,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      discounted_price: item.final_price,
      image: item.image_url,
    }));
    return {
      message: MSG.DATA_FOUND,
      data: {
        orderId: orderInfo._id,
        orderNumber: orderInfo.order_number,
        orderDate: moment(orderInfo.createdAt)
          .tz("America/Chicago")
          .format("DD-MMMM-YYYY"),

        customerEmail: orderInfo.customer.email,
        storeId: merchantInfo.shop_id,
        customerPhoneNumber: orderInfo.customer.phone,
        productDetails: productDetails,
      },
    };
  } catch (error) {
    throwError(error);
  }
};

function roundToTwo(num) {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}
Order.CalculateTotalDiscountedSwipeRevenue = async (
  merchantId,
  startDate,
  endDate,
  timezone = "America/Chicago"
) => {
  try {
    const matchStage = {
      merchant: new ObjectId(merchantId),
      is_protected: true,
      createdAt: {
        $gte: moment.tz(startDate, timezone).startOf("day").utc().toDate(),
        $lte: moment.tz(endDate, timezone).endOf("day").utc().toDate(),
      },

    };

    const orders = await Order.find(matchStage).lean();
    const orderDetails = [];

    let totalGrossSales = 0;
    let totalGrossReturns = 0;
    let totalDiscounts = 0;
    let totalNetSales = 0;

    for (const order of orders) {
      const swipeItem = order.line_items?.find(
        (li) => li.sku === "swipe" || li.title === "Swipe Package Protection"
      );
      if (!swipeItem) continue;

      const qty = swipeItem.quantity ?? 0;
      const swipePrice = parseFloat(swipeItem.price || 0) * qty;

      // Discounts
      const lineItemDiscount = parseFloat(swipeItem.total_discount || 0);
      const allocationFromLineItem =
        swipeItem.discount_allocations?.reduce(
          (sum, da) => sum + parseFloat(da.amount || 0),
          0
        ) || 0;

      let discountAllocated = lineItemDiscount + allocationFromLineItem;

      // Refunds
      let refundedAmount = 0;
      if (order.refunds?.length) {
        for (const refund of order.refunds) {
          if (refund.refund_line_items?.length) {
            for (const rli of refund.refund_line_items) {
              if (String(rli.line_item_id) === String(swipeItem.id)) {
                refundedAmount += parseFloat(
                  rli.subtotal_set?.shop_money?.amount ||
                  rli.subtotal ||
                  0
                );
              }
            }
          } else {
            // If refund exists but no line items → treat as full refund
            refundedAmount += swipePrice - discountAllocated;
          }
        }
      }

      // Shopify style metrics
      const grossSales = roundToTwo(swipePrice);
      const grossReturns = roundToTwo(-refundedAmount);
      const discounts = roundToTwo(discountAllocated);
      const netSales = roundToTwo(grossSales + grossReturns - discounts);

      // Totals
      totalGrossSales += grossSales;
      totalGrossReturns += grossReturns;
      totalDiscounts += discounts;
      totalNetSales += netSales;

      orderDetails.push({
        order_number: order.order_number,
        createdAt: order.createdAt,
        gross_sales: grossSales,
        gross_returns: grossReturns,
        discounts: discounts,
        net_sales: netSales,
      });
    }

    return {
      message: "Data found.",
      data: {
        total_gross_sales: roundToTwo(totalGrossSales),
        total_gross_returns: roundToTwo(totalGrossReturns),
        total_discounts: roundToTwo(totalDiscounts),
        total_net_sales: roundToTwo(totalNetSales),
        total_orders: orderDetails.length,
        orders: orderDetails,
        date_range_note: `Data calculated for orders created between ${moment
          .tz(startDate, timezone)
          .startOf("day")
          .toISOString()} and ${moment
            .tz(endDate, timezone)
            .endOf("day")
            .toISOString()} (${timezone} timezone)`,
      },
    };
  } catch (error) {
    console.error("❌ Error calculating swipe revenue:", error);
    return { message: "Error calculating revenue", error: error.message };
  }
};









module.exports = Order;
