const express = require("express");
const router = express.Router();
const shopify = require("./../../shopify");
const Order = Services.Order;
const axiosService = require("./../../utils/axios");
const { getTrackingStatus } = require("./../../utils/easypost");
const { GetFinalPrice } = require("./../../utils/functions");
const { enrichOrderLineItemsFromShopify } = require("./../../utils/shopifyLineItems");
const moment = require("moment-timezone"); 
const { normalizeTimezone } = require("../../utils/merchantTimezone");
const { buildOrderPriceSummary } = require("../../utils/orderPriceSummary");
const {
  calculateReorderGrossTotal,
} = require("../../utils/claimAdjustmentAmount");
const Auth = global.Auth || require("../../middleware/auth");

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatCurrency = (value = 0) => "$" + Number(value || 0).toFixed(2);

const getDisplayOrderId = (order) => {
  if (order?.name) return order.name;
  if (order?.order_number) return `#${order.order_number}`;
  if (order?.id) return `#${order.id}`;
  return "";
};

const buildShopifyOrderAddress = (address = {}) => {
  if (!address) return null;

  const allowedFields = [
    "first_name",
    "last_name",
    "name",
    "company",
    "address1",
    "address2",
    "city",
    "province",
    "province_code",
    "country",
    "country_code",
    "zip",
    "phone",
  ];

  const cleanedAddress = allowedFields.reduce((acc, field) => {
    if (address[field] !== undefined && address[field] !== null && address[field] !== "") {
      acc[field] = address[field];
    }
    return acc;
  }, {});

  return Object.keys(cleanedAddress).length ? cleanedAddress : null;
};

const buildResolutionItemRows = (selectedItems = [], orderLineItems = []) => {
    const lineItemMap = new Map(
        (orderLineItems || []).map((item) => [String(item.id), item])
    );

    return (selectedItems || [])
        .map((item) => {
            const lineItem = lineItemMap.get(
                String(item.id || item.item_id || item.line_item_id)
            );
            const title = escapeHtml(lineItem?.title || "Claim item");
            const quantity = Number(item.quantity || 0);
            const imageUrl = lineItem?.image_url || lineItem?.image?.src || lineItem?.variant_image?.src;
            const imageCell = imageUrl
                ? `<img src="${escapeHtml(imageUrl)}" alt="${title}" width="44" height="44" style="width:44px;height:44px;border-radius:8px;object-fit:cover;border:1px solid #E8E1D8;display:block;">`
                : `<div style="width:44px;height:44px;border-radius:8px;background:#F8F6F7;border:1px solid #E8E1D8;"></div>`;

            return `
                <tr>
                    <td style="padding:12px 16px;border-bottom:1px solid #E8E1D8;color:#40516F;font-size:15px;line-height:22px;">
                        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                                <td style="width:52px;vertical-align:middle;">${imageCell}</td>
                                <td style="vertical-align:middle;color:#40516F;font-size:15px;line-height:22px;">${title}</td>
                            </tr>
                        </table>
                    </td>
                    <td style="padding:12px 16px;border-bottom:1px solid #E8E1D8;color:#40516F;font-size:15px;line-height:22px;text-align:right;">${quantity}</td>
                </tr>
            `;
        })
        .join("");
};

const sendClaimResolutionCustomerEmail = async ({
  template,
  subject,
  customerEmail,
  customerName,
  orderDisplayId,
  reorderDisplayId,
  total,
  itemRows,
}) => {
  if (!customerEmail) return;

  try {
    await Notifications.sendNotification({
      subject,
      to: [customerEmail],
      template,
      customer_name: customerName || "Customer",
      order_id: orderDisplayId || "",
      reorder_id: reorderDisplayId || "",
      total_amount: formatCurrency(total),
      item_rows: itemRows || "",
    });
  } catch (emailError) {
    console.error(`[Claim Resolution Email] ${template} failed:`, emailError.message);
  }
};

const List = async (req, res, next) => {
    try {
        const response = await Order.OrderList(req);
        res.send(response);
    } catch (error) {
        return next(error);
    }
};

const merchantOrderList = async (req, res, next) => {
    try {
        const merchant_id = req.params.merchant;
        const response = await Order.getAll(
            { merchant: merchant_id },
            { _id: 1, order_number: 1, merchant: 1 }
        );
        return res.send({
            message: response ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: response,
        });
    } catch (error) {
        return next(error);
    }
};


// const orderRefund = async (req, res, next) => {
//   try {
//     const { shop_id, order_id, note, products, claimId, refund_amount } = req.body;

//     /* ---------------- 1. BASIC VALIDATION ---------------- */
//     if (!shop_id || !order_id || !claimId) throwError("Missing required fields.");
//     const refundAmount = Number(refund_amount || 0);

//     /* ---------------- 2. CLAIM & INITIALIZATION ---------------- */
//     let claim = await Services.Claim.get({ _id: claimId });
//     if (!claim) throwError("Claim not found.");

//     if (!Array.isArray(claim.claim_items) || claim.claim_items.length === 0) {
//       const orderSnapshot = await Services.Order.get({ id: order_id }, { line_items: 1 });
//       const snapshotItems = (orderSnapshot.line_items || [])
//         .filter(li => li.sku !== "swipe")
//         .map(li => ({
//           item_id: Number(li.id),
//           variant_id: li.variant_id ? Number(li.variant_id) : null,
//           quantity: Number(li.quantity || 1),
//           resolution: "pending",
//           resolved_at: null,
//         }));
//       await Services.Claim.updateOne({ _id: claimId }, { $set: { claim_items: snapshotItems } });
//     }

//     /* ---------------- 3. FRESH FETCH & NORMALIZATION ---------------- */
//     const freshClaimData = await Services.Claim.get({ _id: claimId });
//     const normalizedProducts = (Array.isArray(products) ? products : [])
//       .map((p) => {
//         const fId = String(p.line_item_id || p.id || p.item_id);
//         const dbItem = freshClaimData.claim_items.find(
//           ci => String(ci.item_id) === fId && ci.resolution === "pending"
//         );
//         return {
//           db_sub_id: dbItem ? dbItem._id : null, 
//           line_item_id: fId,
//           quantity: Number(p.quantity || 0),
//         };
//       })
//       .filter((p) => p.db_sub_id && p.quantity > 0); 

//     if (normalizedProducts.length === 0) throwError("No valid pending items matched for refund.");

//     /* ---------------- 4. SHOPIFY ACTUAL REFUND LOGIC ---------------- */
//     const session = await Services.ShopifySession.get({ shop: shop_id });
//     const order = await shopify.api.rest.Order.find({ session, id: order_id });

//     let refundLineItems = normalizedProducts.map(p => ({
//         line_item_id: Number(p.line_item_id),
//         quantity: p.quantity,
//         restock_type: "no_restock"
//     }));

//     // A. Shopify Calculate (Parent ID aur Tax/Discount calculate karne ke liye)
//     let calcRefund = new shopify.api.rest.Refund({ session });
//     calcRefund.order_id = Number(order_id); // 🔥 Path Fix

//     const calcResult = await calcRefund.calculate({
//         body: { refund: { currency: order.currency, refund_line_items: refundLineItems } }
//     });

//     // B. Final Refund save
//     let refund = new shopify.api.rest.Refund({ session });
//     refund.order_id = Number(order_id);
//     refund.currency = order.currency;
//     refund.notify = true;
//     refund.note = note || "Refunded via Claim System";
//     refund.refund_line_items = refundLineItems;

//     if (calcResult?.refund?.transactions) {
//         refund.transactions = calcResult.refund.transactions.map(t => ({
//             parent_id: t.parent_id,
//             amount: t.amount,
//             kind: "refund",
//             gateway: t.gateway
//         }));
//     } else {
//         throwError("Shopify calculation failed. Check if items are already refunded.");
//     }

//     // ✅ ACTUAL SAVE TO SHOPIFY
//     await refund.save({
//         update: true,
//         body: { refund: { order_id: Number(order_id) } }
//     });

//     /* ---------------- 5. DATABASE UPDATES (RESOLUTION) ---------------- */
//     for (const p of normalizedProducts) {
//         await Services.Claim.updateOne(
//             { _id: claimId, "claim_items._id": p.db_sub_id },
//             { $set: { "claim_items.$.resolution": "refund", "claim_items.$.resolved_at": new Date() } }
//         );
//     }

//     await Services.Claim.updateOne(
//         { _id: claimId },
//         { $set: { refunded_partial_amount: true }, $inc: { refund_total: refundAmount } }
//     );

//     // Auto-Resolve check
//     const finalClaim = await Services.Claim.get({ _id: claimId }, { claim_items: 1 });
//     const stillPending = (finalClaim?.claim_items || []).some(i => i.resolution === "pending");

//     if (!stillPending) {
//         await Services.Claim.updateOne({ _id: claimId }, { $set: { status: "RESOLVED", resolved_date: new Date() } });
//     }

//     return res.send({ message: "Success in Shopify and DB", data: order });

//   } catch (error) {
//     console.error("❌ REFUND ERROR:", error.message);
//     return next(error);
//   }
// };

const orderRefund = async (req, res, next) => {
  try {
    const {
      shop_id,
      order_id,
      note,
      products,
      claimId,
      refund_amount,
    } = req.body;

    console.log("🟡 STARTING REFUND PROCESS FOR CLAIM:", claimId);

    /* ---------------- 1. BASIC VALIDATION ---------------- */
    if (!shop_id || !order_id || !claimId) throwError("Missing required fields.");
    const refundAmount = Number(refund_amount || 0);

    /* ---------------- 2. CLAIM & INITIALIZATION ---------------- */
    let claim = await Services.Claim.get({ _id: claimId });
    if (!claim) throwError("Claim not found.");

    if (!Array.isArray(claim.claim_items) || claim.claim_items.length === 0) {
      const orderSnapshot = await Services.Order.get({ id: order_id }, { line_items: 1 });
      const snapshotItems = (orderSnapshot.line_items || [])
        .filter(li => li.sku !== "swipe")
        .map(li => ({
          item_id: Number(li.id),
          variant_id: li.variant_id ? Number(li.variant_id) : null,
          quantity: Number(li.quantity || 1),
          resolution: "pending",
          resolved_at: null,
        }));
      await Services.Claim.updateOne({ _id: claimId }, { $set: { claim_items: snapshotItems } });
    }

    /* ---------------- 3. FRESH FETCH & NORMALIZATION (PRECISION SAFE) ---------------- */
    const freshClaimData = await Services.Claim.get({ _id: claimId });
    const normalizedProducts = (Array.isArray(products) ? products : [])
      .map((p) => {
        const fId = String(p.line_item_id || p.id || p.item_id);
        const dbItem = freshClaimData.claim_items.find(
          ci => String(ci.item_id) === fId && ci.resolution === "pending"
        );
        return {
          db_sub_id: dbItem ? dbItem._id : null, 
          line_item_id: fId,
          quantity: Number(p.quantity || 0),
        };
      })
      .filter((p) => p.db_sub_id && p.quantity > 0); 

    if (normalizedProducts.length === 0) throwError("No valid pending items matched for refund.");

    /* ---------------- 4. SHOPIFY ACTUAL REFUND LOGIC ---------------- */
    const session = await Services.ShopifySession.get({ shop: shop_id });
    const order = await shopify.api.rest.Order.find({ session, id: order_id });

    let refundLineItems = normalizedProducts.map(p => ({
        line_item_id: Number(p.line_item_id),
        quantity: p.quantity,
        restock_type: "no_restock"
    }));

    // A. Shopify Calculate (Path Fix)
    let calcRefund = new shopify.api.rest.Refund({ session });
    calcRefund.order_id = Number(order_id); 

    const calcResult = await calcRefund.calculate({
        body: { refund: { currency: order.currency, refund_line_items: refundLineItems } }
    });

    // B. Final Refund Setup
    let refund = new shopify.api.rest.Refund({ session });
    refund.order_id = Number(order_id);
    refund.currency = order.currency;
    refund.notify = true;
    refund.note = note || "Refunded via Swipe Claim System";
    refund.refund_line_items = refundLineItems;

    if (calcResult?.refund?.transactions) {
        refund.transactions = calcResult.refund.transactions.map(t => ({
            parent_id: t.parent_id,
            amount: t.amount,
            kind: "refund",
            gateway: t.gateway
        }));
    } else {
        throwError("Shopify calculation failed. Check if items are already refunded.");
    }

    // ✅ ACTUAL SAVE TO SHOPIFY
    await refund.save({
        update: true,
        body: { refund: { order_id: Number(order_id) } }
    });

    /* ---------------- 5. UPDATE SHOPIFY ORDER TAGS (NEW) ---------------- */
    // Order ke existing tags fetch karein aur naya tag add karein
    const existingTags = (order.tags || "").split(",").map(t => t.trim()).filter(Boolean);
    if (!existingTags.includes("Refunded_by_Swipe")) {
      order.tags = [...existingTags, "Refunded_by_Swipe"].join(", ");
      await order.save({
          update: true,
          body: { order: { id: Number(order_id), tags: order.tags } }
      });
      console.log("✅ Shopify Order Tag Updated.");
    }

    /* ---------------- 6. DATABASE UPDATES (RESOLUTION) ---------------- */
    for (const p of normalizedProducts) {
        await Services.Claim.updateOne(
            { _id: claimId, "claim_items._id": p.db_sub_id },
            { $set: { "claim_items.$.resolution": "refund", "claim_items.$.resolved_at": new Date() } }
        );
    }

    await Services.Claim.updateOne(
        { _id: claimId },
        { $set: { refunded_partial_amount: true } }
    );

    // Auto-Resolve check
    const finalClaim = await Services.Claim.get({ _id: claimId }, { claim_items: 1 });
    const stillPending = (finalClaim?.claim_items || []).some(i => i.resolution === "pending");

    if (!stillPending) {
        await Services.Claim.updateOne({ _id: claimId }, { $set: { status: "RESOLVED", resolved_date: new Date() } });
    }

    const localOrder = await Services.Order.get(
      { id: Number(order_id) },
      {
        name: 1,
        order_number: 1,
        id: 1,
        line_items: 1,
        "customer.email": 1,
        "customer.name": 1,
      }
    );

    await sendClaimResolutionCustomerEmail({
      template: "CLAIM_REFUND_CUSTOMER",
      subject: "Your Swipe Refund Has Been Processed",
      customerEmail: localOrder?.customer?.email || order.customer?.email,
      customerName: localOrder?.customer?.name || order.customer?.first_name || "Customer",
      orderDisplayId: getDisplayOrderId(localOrder || order),
      total: refundAmount,
      itemRows: buildResolutionItemRows(normalizedProducts, localOrder?.line_items || order.line_items),
    });

    return res.send({ message: "Success in Shopify and DB", data: order });

  } catch (error) {
    console.error("❌ REFUND ERROR:", error.message);
    return next(error);
  }
};
const reorder = async (req, res, next) => {
  try {
    const { shop_id, order_id, products, claimId } = req.body;

    /* ---------------- BASIC VALIDATION ---------------- */
    if (!shop_id) throwError("Shop ID is required.");
    if (!order_id) throwError("Order ID is required.");
    if (!claimId) throwError("Claim ID is required.");
    if (!Array.isArray(products) || products.length === 0) {
      throwError("No products provided for reorder.");
    }

    /* ---------------- LOAD CLAIM ---------------- */
    const claim = await Services.Claim.get({ _id: claimId });
    if (!claim) throwError("Claim not found.");

   /* ---------------- NORMALIZE & MAP DB IDs (REORDER FIX) ---------------- */
const freshClaimForReorder = await Services.Claim.get({ _id: claimId });

const normalizedReorderProducts = products.map((p) => {
    const fId = String(p.id || p.line_item_id || p.item_id);
    const dbItem = freshClaimForReorder.claim_items.find(
        (ci) => String(ci.item_id) === fId && ci.resolution === "pending"
    );

    return {
        db_sub_id: dbItem ? dbItem._id : null,
        item_id: fId,
        quantity: Number(p.quantity || 0),
    };
}).filter((p) => p.db_sub_id && p.quantity > 0);

    if (normalizedReorderProducts.length === 0) {
      throwError("No valid pending items selected for reorder.");
    }

    /* ---------------- SHOPIFY SESSION & ORDER ---------------- */
    const session = await Services.ShopifySession.get({ shop: shop_id });
    const orderInfo = await shopify.api.rest.Order.find({ session, id: order_id });

    // Sirf un items ko filter karein jo Shopify order mein hain aur normalized list mein hain
    const pendingLineItems = orderInfo.line_items.filter((li) =>
      normalizedReorderProducts.some((p) => p.item_id === String(li.id))
    );

    /* ---------------- INVENTORY CHECK ---------------- */
    for (const item of pendingLineItems) {
      const selected = normalizedReorderProducts.find((p) => p.item_id === String(item.id));
      
      if (selected.quantity > item.quantity) {
        throwError(`Quantity for ${item.title} exceeds original order quantity.`);
      }

      // ... (Existing Inventory check code remains the same) ...
      let variant;
      try {
        variant = await shopify.api.rest.Variant.find({ session, id: item.variant_id });
        if (variant.inventory_management === "shopify" && variant.inventory_policy !== "continue") {
          const inventoryResp = await shopify.api.rest.InventoryLevel.all({
            session,
            inventory_item_ids: String(variant.inventory_item_id),
          });
          const totalInventory = (inventoryResp?.data || []).reduce((sum, lvl) => sum + Number(lvl.available || 0), 0);
          if (totalInventory <= 0) throwError(`Variant for ${item.title} is out of stock`, 409);
        }
      } catch (e) { continue; }
    }

    /* ---------------- CREATE NEW SHOPIFY ORDER ---------------- */
    const newOrder = new shopify.api.rest.Order({ session });
    newOrder.line_items = pendingLineItems.map((item) => {
      const selected = normalizedReorderProducts.find((p) => p.item_id === String(item.id));
      return {
        variant_id: item.variant_id,
        quantity: selected.quantity,
      };
    });

    newOrder.customer = { id: orderInfo.customer?.id };
    newOrder.email = orderInfo.email || orderInfo.contact_email || orderInfo.customer?.email;
    newOrder.phone = orderInfo.phone || orderInfo.shipping_address?.phone || orderInfo.billing_address?.phone;
    const shippingAddress = buildShopifyOrderAddress(orderInfo.shipping_address);
    const billingAddress = buildShopifyOrderAddress(
      orderInfo.billing_address || orderInfo.shipping_address
    );
    if (shippingAddress) newOrder.shipping_address = shippingAddress;
    if (billingAddress) newOrder.billing_address = billingAddress;
    newOrder.currency = orderInfo.currency;
    newOrder.tags = "REORDER_BY_SWIPE";
    newOrder.financial_status = "paid";
    newOrder.discount_codes = [{ code: "100OFFSWIPEREORDER", amount: "100", type: "percentage" }];

    await newOrder.save({ update: true });

    /* ---------------- UPDATE DB CLAIM (FIXED & PRECISE) ---------------- */
    // 1️⃣ Update resolution for each selected item using its UNIQUE sub-document _id
    for (const p of normalizedReorderProducts) {
      await Services.Claim.updateOne(
        {
          _id: claimId,
          "claim_items._id": p.db_sub_id, // Precision safe ID match
        },
        {
          $set: {
            "claim_items.$.resolution": "reorder",
            "claim_items.$.resolved_at": new Date(),
          },
        }
      );
      console.log(`🟢 REORDER DB UPDATE SUCCESS [ID: ${p.item_id}]`);
    }

    // 2️⃣ Save Reorder Meta
    await Services.Claim.updateOne(
      { _id: claimId },
      {
        $set: {
          reorder_id: Number(newOrder.order_number),
          reorder_details: {
            id: Number(newOrder.id),
            number: Number(newOrder.order_number),
          },
        },
      }
    );

    /* ---------------- AUTO RESOLVE CHECK ---------------- */
    const claimAfter = await Services.Claim.get({ _id: claimId }, { claim_items: 1 });
    const hasPending = (claimAfter?.claim_items || []).some((i) => i.resolution === "pending");

    if (!hasPending) {
      await Services.Claim.updateOne(
        { _id: claimId },
        { $set: { status: "RESOLVED", resolved_date: new Date() } }
      );
    }

    const localOrder = await Services.Order.get(
      { id: Number(order_id) },
      {
        name: 1,
        order_number: 1,
        id: 1,
        line_items: 1,
        "customer.email": 1,
        "customer.name": 1,
      }
    );

    await sendClaimResolutionCustomerEmail({
      template: "CLAIM_REORDER_CUSTOMER",
      subject: "Your Swipe Reorder Has Been Created",
      customerEmail: localOrder?.customer?.email || orderInfo.customer?.email,
      customerName: localOrder?.customer?.name || orderInfo.customer?.first_name || "Customer",
      orderDisplayId: getDisplayOrderId(localOrder || orderInfo),
      reorderDisplayId: newOrder?.name || `#${newOrder.order_number || newOrder.id}`,
      total: calculateReorderGrossTotal(
        localOrder?.line_items || orderInfo.line_items,
        normalizedReorderProducts
      ),
      itemRows: buildResolutionItemRows(
        normalizedReorderProducts,
        localOrder?.line_items || orderInfo.line_items
      ),
    });

    return res.send({ data: newOrder });
  } catch (error) {
    return next(error);
  }
};



const refundReorderCalculation = async (req, res, next) => {
    try {
        const { products, order_id, claim_id, shop_id } = req.body;

        if (!Array.isArray(products) || products.length === 0) {
            return res.send({ message: "No products selected" });
        }

        const session = await Services.ShopifySession.get({ shop: shop_id });
        const orderInfo = await shopify.api.rest.Order.find({
            session: session,
            id: order_id,
        });

        let grandTotal;

        // Extract only the selected product IDs
        const selectedProductIds = products.map((p) => p.id);

        const discountedItems = orderInfo.line_items
            .filter((item) => selectedProductIds.includes(item.id))
            .map((item) => {
                const price = parseFloat(
                    item.price_set.presentment_money.amount || 0
                );
                const itemDiscount = parseFloat(
                    item.total_discount_set.presentment_money.amount || 0
                );
                const netPrice = price - itemDiscount;
                const selectedProduct = products.find((p) => p.id === item.id);
                const quantity = selectedProduct?.quantity || 1;

                return {
                    ...item,
                    price,
                    itemDiscount,
                    netPrice,
                    quantity,
                };
            });

        const subtotal = discountedItems.reduce(
            (sum, item) => sum + item.netPrice * item.quantity,
            0
        );

        //handle order level discount
        let totalOrderDiscount = 0;
        (orderInfo.discount_codes || []).forEach((code) => {
            const amount = parseFloat(code.amount || 0);
            totalOrderDiscount += amount;
        });

        const finalItems = discountedItems.map((item) => {
            const proportion = (item.netPrice * item.quantity) / subtotal;
            const proportionalDiscount = proportion * totalOrderDiscount;
            const finalPrice =
                item.netPrice * item.quantity - proportionalDiscount;

            return {
                ...item,
                proportionalDiscount: proportionalDiscount.toFixed(2),
                finalPrice: finalPrice.toFixed(2),
            };
        });

        const itemsTotal = finalItems.reduce(
            (sum, item) => sum + parseFloat(item.finalPrice),
            0
        );

        const shippingAmount = parseFloat(
            orderInfo.total_shipping_price_set.presentment_money.amount || 0
        );
        const taxAmount = parseFloat(orderInfo.total_tax || 0);
        const baseTotal = parseFloat(itemsTotal || 0);
        grandTotal = (baseTotal + shippingAmount + taxAmount).toFixed(2);

        console.log("Final Line Items:", finalItems);
        console.log("Subtotal:", subtotal.toFixed(2));
        console.log("Total Order Discount:", totalOrderDiscount.toFixed(2));
        console.log("Items Total:", itemsTotal.toFixed(2));
        console.log("Grand Total (with shipping & tax):", grandTotal);

        await Services.Claim.findOneAndUpdate(
            { _id: claim_id },
            { $set: { claim_total_amount: grandTotal } }
        );

        return res.send({ data: grandTotal });
    } catch (error) {
        return next(error);
    }
};


const orderDetails = async (req, res, next) => {
  try {
    let orderDetail = await Order.get({ _id: req.params.id });
    if (!orderDetail) {
      throwError("Invalid Details.");
    }
    Auth.assertMerchantAccess(req.user, orderDetail.merchant);

    const merchant = await Services.Merchant.get({
      _id: orderDetail.merchant,
    });

    const response = await GetFinalPrice(orderDetail?._id);
    let responseData = JSON.parse(JSON.stringify(response.response));
    responseData.merchant_name = merchant.name;
    responseData.iana_timezone = normalizeTimezone(merchant.iana_timezone);

    // Pricing is read from Swipe's local order snapshot. Shopify webhooks keep
    // that snapshot current; opening this page must not replace it with a live
    // Shopify order response.
    responseData.line_items = await enrichOrderLineItemsFromShopify(
      responseData,
      merchant?.shop_id
    );

    const priceSummary = buildOrderPriceSummary(orderDetail, responseData);
    responseData.price_summary = priceSummary;

    // Preserve the legacy keys for older dashboard clients, but keep every
    // amount aligned with the Shopify-style summary above.
    responseData.subtotal = priceSummary.subtotal_amount;
    responseData.total_discounts = priceSummary.discount_amount;
    responseData.total_tax = priceSummary.tax_amount;
    responseData.shipping_price = priceSummary.shipping_amount;
    responseData.display_total = priceSummary.total_amount;
    responseData.refunded = priceSummary.refunded_amount;
    responseData.net_price_after_refund = priceSummary.total_amount;
    responseData.paid = priceSummary.paid_amount;
    responseData.net_payment = priceSummary.net_payment;

    // Balance (authorized orders)
    if (orderDetail.authorization && orderDetail.authorization.total) {
      responseData.balance =
        parseFloat(orderDetail.authorization.total) - priceSummary.paid_amount;
    } else {
      responseData.balance = 0;
    }

    // --- Tracking, prev/next, events ---
    const trackingDetails = await getTrackingStatus(orderDetail);
    const { merchant: merchantFilter, status, startDate, endDate } = req.query;
    let condition = {};
    if (merchantFilter) {
      condition.merchant = ObjectId(merchantFilter);
    } else {
      condition.merchant = ObjectId(orderDetail.merchant);
    }
    if (status) {
      condition.status = status;
    }
    if (startDate && endDate) {
      condition.createdAt = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    const sortField = req.query.sort || "createdAt";
    const sortOrder = parseInt(req.query.order || -1);

    const prevOrder = await Order.get(
      {
        ...condition,
        [sortField]: {
          [sortOrder === 1 ? "$lt" : "$gt"]: orderDetail[sortField],
        },
      },
      null,
      { sort: { [sortField]: sortOrder === 1 ? -1 : 1 }, limit: 1 }
    );

    const nextOrder = await Order.get(
      {
        ...condition,
        [sortField]: {
          [sortOrder === 1 ? "$gt" : "$lt"]: orderDetail[sortField],
        },
      },
      null,
      { sort: { [sortField]: sortOrder === 1 ? 1 : -1 }, limit: 1 }
    );

    responseData.previous_order = null;
    responseData.next_order = null;

    if (prevOrder) {
      const prevMerchant = await Services.Merchant.get({
        _id: prevOrder.merchant,
      });
      responseData.previous_order = {
        id: prevOrder._id,
        name: prevOrder.name,
        order_number: prevOrder.order_number,
        total_price: prevOrder.total_price,
        merchant_name: prevMerchant?.name,
        merchant_id: prevOrder.merchant,
        customer_name: prevOrder.customer?.name,
        customer_email: prevOrder.customer?.email,
        tracking_status: prevOrder.tracking_status,
        created_at: prevOrder.createdAt,
      };
    }

    if (nextOrder) {
      const nextMerchant = await Services.Merchant.get({
        _id: nextOrder.merchant,
      });
      responseData.next_order = {
        id: nextOrder._id,
        name: nextOrder.name,
        order_number: nextOrder.order_number,
        total_price: nextOrder.total_price,
        merchant_name: nextMerchant?.name,
        merchant_id: nextOrder.merchant,
        customer_name: nextOrder.customer?.name,
        customer_email: nextOrder.customer?.email,
        tracking_status: nextOrder.tracking_status,
        created_at: nextOrder.createdAt,
      };
    }

    const events = await Services.Event.getAll(
      { order: ObjectId(req.params.id) },
      {
        _id: 1,
        ts: 1,
        type: 1,
        sub_type: 1,
        who: 1,
        content: 1,
        title: 1,
        action_on: 1,
        createdAt: 1,
      },
      { sort: { createdAt: -1 } }
    );
    responseData.events = events;

    const filedReturn = await Services.Return.get(
      { order: orderDetail._id, merchant: orderDetail.merchant },
      { _id: 1, return_number: 1, status: 1 }
    );
    responseData.return_filed = filedReturn
      ? {
          id: filedReturn._id,
          return_number: filedReturn.return_number,
          status: filedReturn.status,
        }
      : null;

    return res.send({
      message: MSG.DATA_FOUND,
      data: responseData,
      trackingDetails,
    });
  } catch (error) {
    return next(error);
  }
};



const CsvExport = async (req, res, next) => {
    try {
        let {
            merchant,
            start_date,
            end_date,
            is_protected,
            search,
            tracking_status,
        } = req.query;

        let mainCondition = [];
        let regexCondition = {};
        let timezone;

        if (merchant) {
            mainCondition.push({ merchant: ObjectId(merchant) });
            let merchantInfo = await Services.Merchant.get({
                _id: ObjectId(merchant),
            });
            timezone = merchantInfo.iana_timezone;
        }

        if (is_protected) {
            mainCondition.push({ is_protected: Boolean(is_protected) });
        }
        if (tracking_status) {
            mainCondition.push({ tracking_status: tracking_status });
        }

        console.log("start_date", start_date, "end_date", end_date);

        let pipeline = [
            {
                $addFields: {
                    order_number_str: { $toString: "$order_number" },
                },
            },
        ];

        if (search) {
            regexCondition = {
                $or: [
                    { order_number_str: { $regex: search, $options: "i" } },
                    { "customer.email": { $regex: search, $options: "i" } },
                ],
            };
        }

        if (Object.keys(regexCondition).length > 0) {
            pipeline.push({ $match: regexCondition });
        }

        if (mainCondition.length > 0) {
            pipeline.push({ $match: { $and: mainCondition } });
        }
const tz = "America/Chicago";
const startUtc = moment.tz(start_date, "M-DD-YYYY", tz).startOf("day").utc().toDate();
const endUtc   = moment.tz(end_date,   "M-DD-YYYY", tz).endOf("day").utc().toDate();
        if (start_date && end_date) {
            pipeline.push({
                $match: {
                    createdAt: { $gte: startUtc, $lte: endUtc },
                },
            });
        }

        // Create projection (keep this separate to use in count)
        const projection = {
            $project: {
                order_number: "$order_number",
                customer_name: "$customer.name",
                total_price: "$total_price",
                merchant: "$merchant",
                createdAt: "$createdAt",
                email: "$customer.email",
                store_name: "$merchant_details.shop_id",
                phone_number: {
                    $ifNull: [
                        "$shipping_address.phone",
                        "$billing_address.phone",
                    ],
                },
            },
        };

        // Get the total count of records first
        const totalCount = await Services.Order.aggregate([
            ...pipeline,
            { $project: { _id: 1 } },
            { $limit: 10001 },
        ]);
        const recordCount = totalCount.length;
        console.log(`Total records to export: ${recordCount}`);

        const DIRECT_EXPORT_LIMIT = 10000; // Maximum records for direct export

        if (recordCount <= DIRECT_EXPORT_LIMIT) {
            // For smaller exports, stream directly to HTTP response
            // Add the projection to the pipeline
            pipeline.push(
                {
                    $lookup: {
                        from: "merchants",
                        localField: "merchant",
                        foreignField: "_id",
                        as: "merchant_details",
                    },
                },
                {
                    $unwind: {
                        path: "$merchant_details",
                        preserveNullAndEmptyArrays: true,
                    },
                }
            );
            pipeline.push({ $sort: { createdAt: -1 } });
            pipeline.push(projection);

            // Get the orders
            const orders = await Services.Order.aggregate(pipeline);

            // Set up CSV response headers
            const filename = `order_export_${Date.now()}.csv`;
            res.setHeader("Content-Type", "text/csv");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${filename}"`
            );

            // Create CSV stream piped directly to response
            const csvStream = FastCsv.format({ headers: true });
            csvStream.pipe(res);

            // Write each order to the CSV stream
            orders.forEach((order) => {
                csvStream.write({
                    order_number: order.order_number,
                    customer_name: order.customer_name,
                    total_price: order.total_price,
                    merchant: order.merchant,
                    createdAt: Moment(order.createdAt).format("MM-DD-YYYY"),
                    email: order.email,
                    phone_number: order.phone_number,
                    store_name: order.store_name,
                });
            });

            // End the CSV stream
            csvStream.end();
        } else {
            // For larger exports, process in the background and send email notification
            setTimeout(async () => {
                const userEmail = req.user?.email || "admin@example.com";
                const userName = req.user?.display_name || "User";

                console.log(
                    `Starting background export process for ${recordCount} records`
                );
                console.log(
                    `Will send notification to: ${userEmail} (${userName})`
                );

                await processLargeExport({
                    merchant,
                    start_date,
                    end_date,
                    search,
                    is_protected,
                    tracking_status,
                    email: userEmail,
                    userName: userName,
                });
            }, 100); // Start async processing

            return res.send({
                message:
                    "Your export is being processed. You will receive an email with the download link once it's ready.",
            });
        }
    } catch (error) {
        return next(error);
    }
};

// 🧠 Background job to process export in chunks and send an email
const processLargeExport = async ({
    merchant,
    start_date,
    end_date,
    search,
    is_protected,
    tracking_status,
    email,
    userName,
}) => {
    let mainCondition = [];
    let regexCondition = {};

    if (merchant) {
        mainCondition.push({ merchant: ObjectId(merchant) });
    }

    if (is_protected) {
        mainCondition.push({ is_protected: Boolean(is_protected) });
    }

    if (tracking_status) {
        mainCondition.push({ tracking_status: tracking_status });
    }

    console.log("start_date", start_date, "end_date", end_date);

    let pipeline = [
        {
            $addFields: {
                order_number_str: { $toString: "$order_number" },
            },
        },
    ];

    if (search) {
        regexCondition = {
            $or: [
                { order_number_str: { $regex: search, $options: "i" } },
                { "customer.email": { $regex: search, $options: "i" } },
            ],
        };
    }

    if (Object.keys(regexCondition).length > 0) {
        pipeline.push({ $match: regexCondition });
    }

    if (mainCondition.length > 0) {
        pipeline.push({ $match: { $and: mainCondition } });
    }

    if (start_date && end_date) {
        pipeline.push({
            $match: {
                createdAt: {
                    $gte: Moment(start_date).startOf("day").toDate(),
                    $lte: Moment(end_date).endOf("day").toDate(),
                },
            },
        });
    }

    // Aggregation pipeline for the lookup and projection
    pipeline.push(
        {
            $lookup: {
                from: "merchants",
                localField: "merchant",
                foreignField: "_id",
                as: "merchant_details",
            },
        },
        {
            $unwind: {
                path: "$merchant_details",
                preserveNullAndEmptyArrays: true,
            },
        },
        { $sort: { createdAt: -1 } },
        {
            $project: {
                order_number: "$order_number",
                customer_name: "$customer.name",
                total_price: "$total_price",
                merchant: "$merchant",
                createdAt: "$createdAt",
                email: "$customer.email",
                store_name: "$merchant_details.shop_id",
                phone_number: {
                    $ifNull: [
                        "$shipping_address.phone",
                        "$billing_address.phone",
                    ],
                },
            },
        }
    );

    // Aggregate orders and break them into chunks if necessary
    let skip = 0;
    const limit = 10000;
    let allOrders = [];

    while (true) {
        const ordersChunk = await Services.Order.aggregate([
            ...pipeline,
            { $skip: skip },
            { $limit: limit },
        ]);

        if (ordersChunk.length === 0) break;

        allOrders = allOrders.concat(ordersChunk);
        skip += limit;
    }

    // Generate a unique filename with timestamp
    const fileName = `order_export_${Date.now()}.csv`;

    // Create CSV content in memory
    let csvContent = "";
    const csvStream = FastCsv.format({ headers: true });

    // Capture the CSV data instead of writing to file
    csvStream.on("data", (data) => {
        csvContent += data;
    });

    // Process each order and write to CSV
    allOrders.forEach((order) => {
        csvStream.write({
            order_number: order.order_number,
            customer_name: order.customer_name,
            total_price: order.total_price,
            merchant: order.merchant,
            createdAt: Moment(order.createdAt).format("MM-DD-YYYY"),
            email: order.email,
            phone_number: order.phone_number,
            store_name: order.store_name,
        });
    });

    // End the CSV stream and wait for it to finish
    csvStream.end();
    await new Promise((resolve) => csvStream.on("end", resolve));

    // Get the current environment
    const environment = process.env.NODE_ENV || "dev";

    // Upload the CSV to S3
    const s3Response = await S3.uploadExport(fileName, csvContent, environment);

    // Send email notification with S3 download link
    if (email) {
        console.log(`Sending export notification email to: ${email}`);
        await Notifications.sendNotification({
            subject: `Your Order Export is Ready`,
            to: [email], // Use the provided email address
            template: "ORDER_EXPORT",
            tracking_url: s3Response.Location, // Use the S3 URL for direct download
            customer_name: userName || "User",
        });
        console.log(`Export notification email sent successfully to: ${email}`);
    }

    // Return the S3 URL for immediate use if needed
    return {
        success: true,
        fileUrl: s3Response.Location,
        fileName: fileName,
    };
};

const productList = async (req, res, next) => {
    try {
        const { orderId, merchant } = req.body;
        const response = await Order.ProductList({
            orderId,
            merchant: ObjectId(merchant),
        });
        return res.send(response);
    } catch (err) {
        return next(err);
    }
};

const AddComment = async (req, res, next) => {
    try {
        const result = await Services.Event.insertOrderComment(req);
        res.send(result);
    } catch (error) {
        next(error);
    }
};
// const AddInternalComment = async (req, res, next) => {
//     try {
//         const { order, content, merchant } = req.body;
//         const newComment = await Services.Event.insert({
//             order,
//             content,
//             merchant,
//             created_by: req.user._id,
//             type: EVENT_TYPE.INTERNAL_COMMENT,
//             title: EVENT_TITLE.ORDER_COMMENT_ADDED,
//             who: req.user.display_name,
//             action_on: ACTIVITY_LOG_LABEL.ORDER,
//             ts: Math.floor(new Date().getTime() / 1000),
//         });
//         return res.send({
//             message: MSG.COMMENT_ADDED,
//             data: newComment,
//         });
//     } catch (error) {
//         next(error);
//     }
// };

const ListComment = async (req, res, next) => {
    try {
        const result = await Services.Event.getAllOrderComment(req, [
            EVENT_TYPE.COMMENT,
            EVENT_TYPE.INTERNAL_COMMENT,
        ]);
        res.send(result);
    } catch (error) {
        next(error);
    }
};

const UpdateOrderTags = async (req, res, next) => {
    try {
        const { orderId, tags } = req.body;

        const order = await Order.get({ _id: orderId });
        if (!order) {
            throwError(MSG.INVALID_ORDER_ID);
        }

        const result = await Order.updateOne(
            { _id: orderId },
            { $set: { tags: tags } },
            { new: true }
        );

        return res.send({
            message: MSG.ADD_ORDER_TAGS,
            data: result,
        });
    } catch (error) {
        next(error);
    }
};
router.post(
  "/check-multiple-variants",
  Auth.check,
  async (req, res, next) => {
    try {
      const { variantIds, claimId } = req.body;

      const normalizeVariantId = (v) => {
        if (v === null || v === undefined) return null;
        const str = String(v);
        // Support Shopify GraphQL gid format just in case
        const gidMatch = str.match(/(\d+)$/);
        if (str.includes("gid://")) return gidMatch ? Number(gidMatch[1]) : null;
        const n = Number(str);
        return Number.isFinite(n) ? n : null;
      };

      if (!Array.isArray(variantIds) || variantIds.length === 0) {
        throwError("variantIds array is required");
      }
      if (!claimId) {
        throwError("claimId is required");
      }

      // 1) CLAIM
      const claim = await Services.Claim.get({ _id: claimId });
      if (!claim) throwError("Claim not found");

      // 2) MERCHANT from CLAIM
      const merchant = await Services.Merchant.get({ _id: claim.merchant });
      if (!merchant || !merchant.shop_id) {
        throwError("Merchant shop not found");
      }

      // 3) SHOPIFY SESSION
      const session = await Services.ShopifySession.get({
        shop: merchant.shop_id,
      });
      if (!session) throwError("Shopify session not found");

      const results = [];

      for (const rawVariantId of [...new Set(variantIds)]) {
        const variantId = normalizeVariantId(rawVariantId);

        if (!variantId) {
          results.push({
            variant_id: rawVariantId,
            variant_exists: false,
            available: false,
            total_inventory: 0,
            tracked: false,
          });
          continue;
        }

        try {
          // 4) VARIANT
          const variant = await shopify.api.rest.Variant.find({
            session,
            id: variantId,
          });

          if (!variant) {
            results.push({
              variant_id: variantId,
              variant_exists: false,
              available: false,
              total_inventory: 0,
              tracked: false,
            });
            continue;
          }

          const tracked = variant.inventory_management === "shopify";

          // If not tracked, Shopify doesn’t enforce inventory.
          // We mark it "Not tracked" on UI.
       // ✅ NOT TRACKED PRODUCTS
if (!tracked) {
  const canSell = variant.inventory_policy === "continue";

  results.push({
    variant_id: variantId,
    variant_exists: true,
    available: canSell,
    total_inventory: 0,
    tracked: false,
    policy: variant.inventory_policy,
  });

  continue;
}

          if (!variant.inventory_item_id) {
            results.push({
              variant_id: variantId,
              variant_exists: true,
              available: false,
              total_inventory: 0,
              tracked: true,
            });
            continue;
          }

          // 5) INVENTORY LEVELS (multi-location safe)
          const inventoryResp = await shopify.api.rest.InventoryLevel.all({
            session,
            inventory_item_ids: String(variant.inventory_item_id),
          });

          const levels = Array.isArray(inventoryResp?.data)
            ? inventoryResp.data
            : [];

          const totalInventory = levels.reduce(
            (sum, level) => sum + Number(level.available || 0),
            0
          );

          results.push({
            variant_id: variantId,
            variant_exists: true,
            available: totalInventory > 0,
            total_inventory: totalInventory,
            tracked: true,
          });
        } catch (err) {
          console.error(
            "❌ Variant inventory check failed:",
            variantId,
            err?.response?.body || err.message
          );

          results.push({
            variant_id: variantId,
            variant_exists: false,
            available: false,
            total_inventory: 0,
            tracked: false,
          });
        }
      }

      return res.send({
        message: "Variant availability checked",
        data: results,
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get("/list", Auth.check, List);
router.get(
    "/order-list/:merchant",
    Auth.check,
    Auth.requireMerchantAccess("params", "merchant"),
    merchantOrderList
);
router.post("/refund", orderRefund);
router.post("/reorder", reorder);
router.post(
    "/refund-reorder-calculation",
    Auth.check,
    refundReorderCalculation
);
router.get("/export", Auth.check, CsvExport);
router.get("/:id", Auth.check, orderDetails);
router.post(
    "/product-list",
    Auth.check,
    Auth.requireAdminPermissionIfAdmin(ADMIN_PERMISSION.CLAIMS_CREATE),
    Auth.requireMerchantAccess("body", "merchant"),
    productList
);
router.get("/comment/:order", Auth.check, ListComment);
router.post("/comment", Auth.check, AddComment);
// router.post("/internal-comment", Auth.check, AddInternalComment);
router.put("/update-tags", Auth.check, UpdateOrderTags);

module.exports = router;
