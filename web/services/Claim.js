const claimModels = Models.Claim;
const shopify = require("./../shopify.js");
const Claim = {};
const axiosService = require("./../../web/utils/axios.js");
const { GetFinalPrice } = require("./../../web/utils/functions");
const { getTrackingStatus } = require("./../utils/easypost.js");
const { buildOrderPriceSummary } = require("./../utils/orderPriceSummary.js");
const { assertSwipeProtectedOrder } = require("./../utils/claimEligibility.js");
const moment = require('moment-timezone');
const mongoose = require('mongoose');
const GoogleSheet = require("./GoogleSheet");
const sheetSyncTimers = new Map();

const hasSheetRelevantChanges = (info = {}) =>
    info?.$set?.status !== undefined ||
    info?.status !== undefined ||
    info?.$set?.claim_total !== undefined ||
    info?.claim_total !== undefined ||
    info?.$set?.combined_refund_total !== undefined ||
    info?.combined_refund_total !== undefined ||
    info?.$set?.swipe_by_refunded !== undefined ||
    info?.swipe_by_refunded !== undefined ||
    info?.$set?.refund_total !== undefined ||
    info?.refund_total !== undefined ||
    info?.$set?.reorder_total !== undefined ||
    info?.reorder_total !== undefined ||
    info?.$set?.refund_status !== undefined ||
    info?.refund_status !== undefined ||
    info?.$set?.description !== undefined ||
    info?.description !== undefined ||
    info?.$set?.resolved_date !== undefined ||
    info?.resolved_date !== undefined ||
    info?.$set?.order_snapshot !== undefined ||
    info?.order_snapshot !== undefined;

const scheduleGoogleSheetUpdate = (lookup) => {
    if (!lookup) return;

    const syncKey = String(lookup?._id || JSON.stringify(lookup));
    const existingTimer = sheetSyncTimers.get(syncKey);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(async () => {
        sheetSyncTimers.delete(syncKey);

        try {
            if (!(await GoogleSheet.isConfigured())) return;

            const claim = await claimModels.findOne(lookup);

            if (!claim) {
                Logger.warn(
                    `[GoogleSheet] Updated claim not found for Sheet sync. lookup=${JSON.stringify(lookup)}`
                );
                return;
            }

            const claimData = claim.toObject({
                getters: false,
                virtuals: false,
            });

            if (!claimData.order_snapshot?.created_at && claimData.order) {
                const order = await Models.Order.findById(
                    claimData.order,
                    { order_created_at: 1, createdAt: 1 }
                ).lean();

                claimData.order_snapshot = {
                    ...claimData.order_snapshot,
                    created_at:
                        order?.order_created_at || order?.createdAt || null,
                };
            }

            const result = await GoogleSheet.updateClaimRow(claimData);
            Logger.info(
                `[GoogleSheet] Claim row ${result.action || "synced"}. claim_id=${claim._id}`
            );
        } catch (error) {
            const message =
                error?.response?.data?.error?.message ||
                error?.message ||
                String(error);

            Logger.error(
                `[GoogleSheet] Claim update sync failed. error=${message}`
            );
        }
    }, 250);

    sheetSyncTimers.set(syncKey, timer);
};

Claim.insert = async (data) => {
    return new claimModels(data).save();
};

Claim.get = async (condition, projection, options) => {
    return claimModels.findOne(condition, projection, options);
};

Claim.getAll = async (condition, projection, options = { lean: true }) => {
    return claimModels.find(condition, projection, options);
};

Claim.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse) await claimModels.aggregate(pipeline).allowDiskUse(true);
    return claimModels.aggregate(pipeline);
};

Claim.updateOne = async (condition, info) => {
    const result = await claimModels.updateOne(condition, info);

    if (result.modifiedCount && hasSheetRelevantChanges(info)) {
        scheduleGoogleSheetUpdate(condition?._id ? { _id: condition._id } : condition);
    }

    return result;
};

Claim.findOneAndUpdate = async (condition, info, options) => {
    if (info?.$set?.reorder_id !== undefined) {
        const num = Number(info.$set.reorder_id);
        if (!Number.isFinite(num)) {
            delete info.$set.reorder_id; // ❌ block strings like LOLA-xxx
        } else {
            info.$set.reorder_id = num; // ✅ allow only numbers
        }
    }
    const claim = await claimModels.findOneAndUpdate(condition, info, options);

    if (claim && hasSheetRelevantChanges(info)) {
        scheduleGoogleSheetUpdate({ _id: claim._id });
    }

    return claim;
};


Claim.distinct = async (field, condition) => {
    return claimModels.distinct(field, condition);
};

Claim.count = async (condition) => {
    return claimModels.countDocuments(condition);
};


const normalizeClaimProductIds = (productId) => {
    const values = Array.isArray(productId) ? productId : productId ? [productId] : [];
    return [
        ...new Set(
            values
                .map((id) => String(id).trim())
                .filter(Boolean)
        ),
    ];
};

const isClaimableLineItem = (lineItem) =>
    String(lineItem?.title) !== "Swipe Package Protection" &&
    String(lineItem?.sku || "").toLowerCase() !== "swipe";

const buildClaimItemsSnapshot = (lineItems = [], productId, requireSelection = false) => {
    const selectedIds = normalizeClaimProductIds(productId);
    if (requireSelection && !selectedIds.length) {
        throwError("Please select at least one product.");
    }

    const selectedIdSet = new Set(selectedIds);
    const claimableItems = (lineItems || []).filter(isClaimableLineItem);
    const selectedItems = selectedIds.length
        ? claimableItems.filter((lineItem) => selectedIdSet.has(String(lineItem.id)))
        : claimableItems;

    if (selectedIds.length) {
        const matchedIds = new Set(selectedItems.map((lineItem) => String(lineItem.id)));
        const missingIds = selectedIds.filter((id) => !matchedIds.has(id));
        if (missingIds.length) {
            throwError(`Selected claim product not found on this order: ${missingIds.join(", ")}`);
        }
    }

    return {
        productIds: selectedItems.map((lineItem) => Number(lineItem.id)),
        claimItemsSnapshot: selectedItems.map((lineItem) => ({
            item_id: Number(lineItem.id),
            variant_id: lineItem.variant_id ? Number(lineItem.variant_id) : null,
            quantity: Number(lineItem.quantity || 1),
            resolution: "pending",
            resolved_at: null,
        })),
    };
};

Claim.Details = async (claimId, user) => {
  try {
    const claimDetails = await Services.Claim.get({ _id: ObjectId(claimId) });
    if (!claimDetails) throwError("Invalid Details CLaim Details.");

    let order = await Services.Order.get({ _id: claimDetails.order });
    if (!order) throwError("Invalid Details Order Details.");

    // ---------------- Across Discount: Recalc before building response ----------------
    // IMPORTANT: if you do GetFinalPrice, re-fetch order so DB-updated line_items come back.
    let hasAcrossDiscount = false;
    try {
      hasAcrossDiscount =
        Array.isArray(order.discount_applications) &&
        order.discount_applications.some((d) => d.allocation_method === "across");

      // keep same behavior you had earlier: recalc for across (safe)
      if (hasAcrossDiscount) {
        await GetFinalPrice(order._id);
        order = await Services.Order.get({ _id: order._id }); // CRITICAL
      }
    } catch (e) {
      console.error("GetFinalPrice (Claim Details) failed:", e);
    }

    // ---------------- Merchant Auth (unchanged) ----------------
    const claimMerchantId = order.merchant.toString();
    const userMerchantId = user.merchant ? user.merchant.toString() : null;

    if (user.role !== USER_ROLE.ADMIN) {
      if (claimMerchantId !== userMerchantId) {
        throwError("Unauthorized access to this claim.");
      }
    }

    // ---------------- Delayed reorder_details update (unchanged) ----------------
    if (
      claimDetails?.reorder_details &&
      !claimDetails.reorder_details?.order &&
      claimDetails.reorder_details?.id
    ) {
      try {
        const order_details = await Services.Order.get(
          {
            id: claimDetails.reorder_details.id,
            merchant: claimDetails.merchant,
          },
          { _id: 1 }
        );

        await Services.Claim.findOneAndUpdate(
          { _id: claimDetails._id },
          { $set: { "reorder_details.order": order_details._id } }
        );
      } catch (err) {
        console.warn("⏳ Delayed reorder_details update failed:", err.message);
      }
    }

    // ---------------- Shopify + tracking setup (unchanged) ----------------
    const merchant = await Services.Merchant.get({ _id: order.merchant });
    const session = await Services.ShopifySession.get({ shop: merchant.shop_id });
    const client = new shopify.api.clients.Graphql({ session });

    // Admin-only tracking projection (unchanged)
    let projection = {};
    if (user.role === USER_ROLE.ADMIN) {
      projection["tracking_urls"] = "$orders.fulfillments.tracking_urls";
      projection["tracking_numbers"] = "$orders.fulfillments.tracking_numbers";
      projection["tracking_company"] = "$orders.fulfillments.tracking_company";
    }

    // ---------------- Aggregation (KEEP OLD SHAPE + order_details) ----------------
    let claimDetail;
    try {
      claimDetail = await Services.Claim.aggregate([
        { $match: { _id: ObjectId(claimId) } },
        {
          $lookup: {
            from: "orders",
            localField: "order",
            foreignField: "_id",
            as: "orders",

          },
        },
        { $unwind: "$orders" },
        {
          $addFields: {
            original_line_items: "$orders.line_items",
          },
        },
        {
          $addFields: {
            product_id: { $ifNull: ["$product_id", []] },
          },
        },
       {
  $addFields: {
    claim_products: {
      $map: {
        input: "$claim_items",
        as: "ci",
        in: {
          $let: {
            vars: {
              li: {
                $arrayElemAt: [
                  {
                    $filter: {
                      input: "$orders.line_items",
                      as: "oli",
                      cond: { $eq: ["$$oli.id", "$$ci.item_id"] },
                    },
                  },
                  0,
                ],
              },
            },
            in: {
              $cond: [
                { $ifNull: ["$$li", false] },
                {
                  $mergeObjects: [
                    "$$li",
                    {
                      resolution: "$$ci.resolution",
                      resolved_at: "$$ci.resolved_at",
                      claim_quantity: "$$ci.quantity",
                    },
                  ],
                },
                null,
              ],
            },
          },
        },
      },
    },
  },
},{
  $addFields: {
    claim_products: {
      $filter: {
        input: "$claim_products",
        as: "cp",
        cond: { $ne: ["$$cp", null] },
      },
    },
  },
}
,

        {
          $addFields: {
            "orders.line_items": {
              $cond: {
                if: { $eq: [{ $size: "$product_id" }, 0] },
                then: [],
                else: {
                  $filter: {
                    input: "$original_line_items",
                    as: "item",
                    cond: {
                      $and: [
                        { $not: { $in: ["$$item.id", "$product_id"] } },
                        { $ne: ["$$item.title", PRODUCT_TITLE] },
                        { $ne: ["$$item.title", "Swipe Package Protection"] },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        {
          $addFields: {
            swipe_product: {
              $filter: {
                input: "$original_line_items",
                as: "item",
                cond: { $eq: ["$$item.title", "Swipe Package Protection"] },
              },
            },
          },
        },
        {
          $lookup: {
            from: "events",
            localField: "order",
            foreignField: "order",
            as: "events",
          },
        },
        {
          $lookup: {
            from: "merchants",
            localField: "merchant",
            foreignField: "_id",
            as: "merchant",
          },
        },
        { $unwind: "$merchant" },
        {
          $project: {
            claim_products: 1,
            swipe_product: 1,
            order_details: "$orders",
            claim_items: 1, // ✅ REQUIRED by frontend for Order Price Info
            reorder_details: 1,
            orders: {
              name: "$orders.name",
              customer_email: "$orders.customer.email",
              customer_name: "$orders.customer.name",
              order_createdAt: "$orders.createdAt",
              line_items: "$orders.line_items",
              total_tax: "$orders.total_tax",
              total_shipping_price_set:
                "$orders.total_shipping_price_set.presentment_money.amount",
              address: "$orders.billing_address",
              id: "$orders.id",
              _id: "$orders._id",
            },
            merchant: {
              name: "$merchant.name",
              domain: "$merchant.domain",
              _id: "$merchant._id",
              shop_id: "$merchant.shop_id",
            },
            claim_createdAt: "$createdAt",
            claim_total_amount: "$claim_total_amount",
            reason: 1,
            last_update: "$updatedAt",
            status: 1,
            sub_status: 1,
            refunded_partial_amount: 1,
            previous_status: 1,
            resolved_date: 1,
            refund_status: 1,
            product_id: 1,
            products: 1,
            description: 1,
            ip_address: 1,
            reorder_id: 1,
            swipe_by_refunded: 1,
            combined_refund_total: 1,
            total: {
              refund_total: "$refund_total",
              reorder_total: "$reorder_total",
              claim_total: "$claim_total",
            },
            customer_claim_no: 1,
            total_claim_no: 1,
            "events.ts": 1,
            "events.type": 1,
            "events.sub_type": 1,
            "events.who": 1,
            "events.content": 1,
            ...projection,
          },
        },
      ]);
    } catch (e) {
      console.error("Aggregation failed:", e);
      throwError("Claim aggregation failed");
    }

    let claim = claimDetail?.[0];
    if (!claim) return { message: MSG.DATA_NOT_FOUND, Claims: {} };

    // ✅ Guarantee frontend gets the recalculated order snapshot
    // (order_details from aggregation might be stale if GetFinalPrice updated after aggregation in some flows)
    claim.order_details = {
      ...JSON.parse(JSON.stringify(order)),
      // Claims use the same persisted order pricing shown on Order Details.
      price_summary: buildOrderPriceSummary(order, order),
    };

    // ---------------- Fulfillment location + tracking mapping (UNCHANGED) ----------------
    if (order.fulfillments && order.fulfillments.length > 0) {
      for (const fulfillment of order.fulfillments) {
        const gqlLocationId = `gid://shopify/Location/${fulfillment.location_id}`;

        // 1) location name
        let locationName = null;
        let fulfillment_created_at = null;
        try {
          const checkExists = await client.request(
            `
              query getLocation($id: ID!) {
                location(id: $id) { name }
              }
            `,
            { variables: { id: gqlLocationId } }
          );
          locationName = checkExists?.data?.location?.name || null;
          fulfillment_created_at = fulfillment.created_at;
        } catch (err) {
          console.error("Error fetching location:", err);
        }

        // 2) tracking
        let tracking = {
          date: null,
          carrier: null,
          status: null,
          trackingNumber: null,
        };
        try {
          const trackingInfo = await getTrackingStatus(order);
          if (trackingInfo) {
            const lastEvent = trackingInfo?.events?.at(-1);
            tracking = {
              date: lastEvent?.timestamp || null,
              carrier: trackingInfo?.carrier || null,
              status: trackingInfo?.status || null,
              trackingNumber: trackingInfo?.trackingNumber || null,
            };
          }
        } catch (err) {
          console.error("Error getting tracking status:", err);
        }

        // 3) patch line items
        for (const fulfilledItem of fulfillment.line_items || []) {
          const updateItemLocationAndTracking = (itemsArray) => {
            const item = (itemsArray || []).find((i) => i.id === fulfilledItem.id);
            if (!item) return;

            item.location_name = locationName;
            item.fulfillment_created_at = fulfillment_created_at;

            if (fulfilledItem.title === "Swipe Package Protection") {
              item.tracking = {
                status: "Shipping not required",
                date: null,
                carrier: null,
                trackingNumber: null,
              };
            } else {
              item.tracking = tracking;
            }
          };

          updateItemLocationAndTracking(claim.claim_products);
          updateItemLocationAndTracking(claim.orders?.line_items);
          updateItemLocationAndTracking(claim.swipe_product);
        }
      }
    }

    // ---------------- Grouping (UNCHANGED) ----------------
    function groupLineItemsByLocation(items = []) {
      const groups = [];
      for (const item of items || []) {
        const { location_name = null, fulfillment_created_at = null, tracking = {}, ...rest } =
          item || {};
        let existingGroup = groups.find((g) => g.location_name === location_name);
        if (!existingGroup) {
          existingGroup = { location_name, fulfillment_created_at, tracking, items: [] };
          groups.push(existingGroup);
        }
        existingGroup.items.push(rest);
      }
      return groups;
    }

    claim.claim_products = groupLineItemsByLocation(claim.claim_products);
    claim.orders.line_items = groupLineItemsByLocation(claim.orders.line_items);
    claim.swipe_product = groupLineItemsByLocation(claim.swipe_product);

    // ---------------- ACROSS discount visual normalization (NEW, SAFE) ----------------
    // Make frontend strike-through work: price stays original, final_price becomes discounted per-unit,
    // and discount_allocations reflects Shopify style.
    if (hasAcrossDiscount) {
      const orderItemMap = new Map(
        (order.line_items || []).map((li) => [String(li.id), li])
      );

      const patchGroupItems = (groups = []) =>
        (groups || []).map((group) => {
          if (!group || !Array.isArray(group.items)) return group;

          return {
            ...group,
            items: group.items.map((item) => {
              const oItem = orderItemMap.get(String(item.id));
              if (!oItem) return item;

              const unitPrice = Number(oItem.price || 0);
              const qty = Number(oItem.quantity || 1);
              const totalDiscount = Number(oItem.total_discount || 0);
              const discountedUnit = qty > 0 ? unitPrice - totalDiscount / qty : unitPrice;

              // Only patch if there is discount
              if (totalDiscount > 0 && discountedUnit < unitPrice) {
                return {
                  ...item,
                  price: unitPrice.toFixed(2),
                  final_price: discountedUnit.toFixed(2),
                  total_discount: totalDiscount.toFixed(2),
                  discount_allocations:
                    oItem.discount_allocations && oItem.discount_allocations.length
                      ? oItem.discount_allocations
                      : [
                          {
                            amount: totalDiscount.toFixed(2),
                            discount_application_index: 0,
                          },
                        ],
                };
              }

              return item;
            }),
          };
        });

      claim.claim_products = patchGroupItems(claim.claim_products);
      claim.orders.line_items = patchGroupItems(claim.orders.line_items);
      claim.swipe_product = patchGroupItems(claim.swipe_product);
    }
    const hasEachEntitledDiscount =
  Array.isArray(order.discount_applications) &&
  order.discount_applications.some(
    (d) =>
      d.allocation_method === "each" &&
      d.target_selection === "entitled"
  );

if (hasEachEntitledDiscount && !hasAcrossDiscount) {
  const orderItemMap = new Map(
    (order.line_items || []).map((li) => [String(li.id), li])
  );

  const normalizeEachDiscount = (groups = []) =>
    (groups || []).map((group) => {
      if (!group?.items) return group;

      return {
        ...group,
        items: group.items.map((item) => {
          const oItem = orderItemMap.get(String(item.id));
          if (!oItem) return item;

          const unitPrice = Number(oItem.price || 0);
          const qty = Number(oItem.quantity || 1);
          const totalDiscount = Number(oItem.total_discount || 0);

          if (totalDiscount <= 0) return item;

          const discountedUnit =
            qty > 0 ? unitPrice - totalDiscount / qty : unitPrice;

          return {
            ...item,
            price: unitPrice.toFixed(2),          // original
            final_price: discountedUnit.toFixed(2), // discounted
            total_discount: totalDiscount.toFixed(2),
            discount_allocations:
              oItem.discount_allocations?.length
                ? oItem.discount_allocations
                : [
                    {
                      amount: totalDiscount.toFixed(2),
                      discount_application_index: 0,
                    },
                  ],
          };
        }),
      };
    });

  claim.claim_products = normalizeEachDiscount(claim.claim_products);
  claim.orders.line_items = normalizeEachDiscount(claim.orders.line_items);
  claim.swipe_product = normalizeEachDiscount(claim.swipe_product);
}

    // ---------------- Add update_quantity (UNCHANGED) ----------------
    try {
      if (Array.isArray(claim?.claim_products) && Array.isArray(claim?.products)) {
        claim.claim_products = claim.claim_products.map((group) => {
          const updatedItems = (group.items || []).map((item) => {
            const matchedProduct = claim.products.find((p) => p.id === item.id);
            return {
              ...item,
              update_quantity: matchedProduct?.quantity ?? item.quantity,
            };
          });

          return { ...group, items: updatedItems };
        });
      }
    } catch (error) {
      console.error("Failed to add update_quantity to claim_products:", error);
    }

    // ---------------- Tracking arrays flatten (UNCHANGED) ----------------
    claim.tracking_urls = claim?.tracking_urls?.flat?.() || claim?.tracking_urls;
    claim.tracking_company = claim?.tracking_company
      ? [...new Set(claim.tracking_company)]
      : claim.tracking_company;
    claim.tracking_numbers = claim?.tracking_numbers?.flat?.() || claim?.tracking_numbers;

    // ---------------- Discount apps for UI labels (UNCHANGED) ----------------
    claim.discount = order.discount_applications || [];

    // ---------------- Claim counts ----------------
    // Run for every viewer so admin/non-merchant requests also get customer_claim_no populated.
    await updateCustomerClaimNo(claim, claimId);
    if (!user.merchant) {
      await updateTotalClaimNo(claim, claimId);
      const customerClaim = await Services.CustomerClaim.get({
        customer: claim.orders.customer_email,
      });
      claim.customerClaim = customerClaim;
    }

    return { message: MSG.DATA_FOUND, Claims: claim };
  } catch (error) {
    throwError(error);
  }
};

const updateCustomerClaimNo = async (claim, claimId) => {
    try {
        let customerClaim = claim.customer_claim_no;
        let condition = {};
        if (!customerClaim) {
            if (claim.merchant._id) {
                condition.merchant = claim.merchant._id;
            }
            const merchantClaimInfo = await Claim.aggregate([
                { $match: condition },
                {
                    $lookup: {
                        from: "orders",
                        localField: "order",
                        foreignField: "_id",
                        as: "order",
                    },
                },
                { $unwind: "$order" },
                {
                    $project: {
                        _id: { $toString: "$_id" },
                        order_id: "$order._id",
                        order_name: "$order.name",
                        order_number: "$order.number",
                        order_createdAt: "$order.createdAt",
                        customer_email: "$order.customer.email",
                        createdAt: 1,
                    },
                },
                { $match: { customer_email: claim.orders.customer_email } },
                { $sort: { createdAt: 1 } },
            ]);

            const index = merchantClaimInfo.findIndex(
                (claim) => claim._id == claimId
            );
            if (index >= 0) {
                customerClaim = index + 1;
                await Claim.updateOne(
                    { _id: claimId },
                    { $set: { customer_claim_no: customerClaim } }
                );
            }
        }
        claim.customer_claim_no = customerClaim;
    } catch (error) {
        throwError(error);
    }
};

const updateTotalClaimNo = async (claim, claimId) => {
    try {
        let allCustomerClaim = claim.total_claim_no;

        if (!allCustomerClaim) {
            const merchantClaimInfo = await Claim.aggregate([
                {
                    $lookup: {
                        from: "orders",
                        localField: "order",
                        foreignField: "_id",
                        as: "order",
                    },
                },
                { $unwind: "$order" },
                {
                    $project: {
                        _id: { $toString: "$_id" },
                        order_id: "$order._id",
                        order_name: "$order.name",
                        order_number: "$order.number",
                        order_createdAt: "$order.createdAt",
                        customer_email: "$order.customer.email",
                        createdAt: 1,
                    },
                },
                { $match: { customer_email: claim.orders.customer_email } },
                { $sort: { createdAt: 1 } },
            ]);

            const index = merchantClaimInfo.findIndex(
                (claim) => claim._id == claimId
            );
            if (index >= 0) {
                allCustomerClaim = index + 1;
                await Claim.updateOne(
                    { _id: claimId },
                    { $set: { total_claim_no: allCustomerClaim } }
                );
            }
            claim.total_claim_no = allCustomerClaim;
        }
    } catch (error) {
        throwError(error);
    }
};

Claim.SearchOrder = async (req) => {
    try {
        const { search, merchant } = req.body;
        let keywork = search;

        let orders = await Services.Order.aggregate([
            {
                $match: {
                    $or: [
                        { order_number: Number(keywork) },
                        { "customer.email": keywork },
                        { name: keywork },
                    ],
                    merchant: ObjectId(merchant),
                },
            },
            {
                $addFields: {
                    swipe: {
                        $filter: {
                            input: "$line_items",
                            as: "item",
                            cond: {
                                $or: [
                                    { $eq: ["$$item.title", PRODUCT_TITLE] },
                                    {
                                        $eq: [
                                            "$$item.title",
                                            "Swipe Package Protection",
                                        ],
                                    },
                                ],
                            },
                        },
                    },
                },
            },
            {
                $lookup: {
                    from: "claims",
                    localField: "_id",
                    foreignField: "order",
                    as: "claims",
                },
            },
            {
                $project: {
                    _id: 1,
                    merchant: 1,
                    name: 1,
                    customer_email: "$customer.email",
                    total_price: 1,
                    line_items: 1,
                    order_number: 1,
                    swipe: 1,
                    claims: 1,
                },
            },
        ]);
        let OrdersearchList = [];
        for (let order of orders) {
            order.swipe = order.swipe.length !== 0;
            if (order.claims.length > 0) order.claims = order.claims[0]._id;
            delete order.line_items;
            OrdersearchList.push(order);
        }
        return {
            message: orders.length === 0 ? MSG.DATA_NOT_FOUND : MSG.DATA_FOUND,
            data: OrdersearchList,
        };
    } catch (error) {
        throwError(error);
    }
};

Claim.CreateClaim = async (payload) => {
  try {
    const {
      mid: merchant,
      oid: orderId,
      type,
      preference,
      description,
      ip_address,
      created_by,
      created_role,
    } = payload;

    // 🔒 STEP 1: Fetch order FIRST
    const order = await Services.Order.get({ _id: orderId });
    if (!order) throwError("Invalid Order");
    assertSwipeProtectedOrder(order);

    const { productIds, claimItemsSnapshot } = buildClaimItemsSnapshot(
      order.line_items,
      payload.product_id,
      payload.product_id !== undefined && payload.product_id !== null
    );

    // 🔒 STEP 2: Detect ACROSS discount
    const hasAcrossDiscount = Array.isArray(order.discount_applications)
      ? order.discount_applications.some(
          (d) => d.allocation_method === "across"
        )
      : false;

    /**
     * 🔑 CRITICAL LOGIC
     * - EACH discount → old behavior (GetFinalPrice handles it)
     * - ACROSS discount → also recalc ONCE before claim
     *
     * This ensures order.line_items[].final_price is ALWAYS correct
     * before claim snapshot is taken.
     */
const checkClaim = await Services.Claim.get({ order: orderId });
if (checkClaim) throwError(MSG.CLAIM_IS_CREATED);

await GetFinalPrice(orderId);


    // 🔒 STEP 4: Build claim object (UNCHANGED LOGIC)
    const claimObject = {
      merchant,
      product_id: productIds,
      description,
      ip_address,
      refund_status: preference?.toUpperCase(),
      reason: type,
      claim_items: claimItemsSnapshot,
      order: orderId,
      status: CLAIM_STATUS.REVIEWING,
      sub_status: CLAIM_SUB_STATUS.IN_REVIEW,
    };

    if (created_by && created_role) {
      claimObject.created_by = created_by;
      claimObject.created_role = created_role;
    }

    // 🔒 STEP 5: Create claim
    const claim = await Services.Claim.insert(claimObject);

    // 🔒 STEP 6: Post-create side effects (UNCHANGED)
    await customerCount(claim);

    await Services.Order.findOneAndUpdate(
      { _id: orderId },
      { $set: { is_claim_created: true } }
    );

    await Services.Event.insert({
      order: orderId,
      claim: claim._id,
      merchant,
      type: EVENT_TYPE.ACTION,
      sub_type: EVENT_SUBTYPE.CLAIM_CREATED,
      action_on: ACTIVITY_LOG_LABEL.SYSTEM,
      title: EVENT_TITLE.CLAIM_CREATE,
      ts: Math.floor(Date.now() / 1000),
    });

    return { data: claim, message: MSG.CLAIM_CREATED };
  } catch (error) {
    throwError(error);
  }
};


const customerCount = async (claim) => {
    try {
        const order = await Services.Order.get(
            { _id: claim.order },
            { "customer.email": 1 }
        );
        const claimInfo = await Claim.aggregate([
            {
                $lookup: {
                    from: "orders",
                    localField: "order",
                    foreignField: "_id",
                    as: "order",
                },
            },
            { $unwind: "$order" },
            {
                $lookup: {
                    from: "merchants",
                    localField: "merchant",
                    foreignField: "_id",
                    as: "merchants",
                },
            },
            { $unwind: "$merchants" },
            {
                $project: {
                    _id: { $toString: "$_id" },
                    customer_email: "$order.customer.email",
                    merchant_name: "$merchants.name",
                    merchant_id: "$merchants._id",
                },
            },
            { $match: { customer_email: order.customer.email } },
            {
                $group: {
                    _id: {
                        merchant_name: "$merchant_name",
                        merchant_id: "$merchant_id",
                    },
                    count: { $sum: 1 },
                },
            },
        ]);

        const customerClaim = await Services.CustomerClaim.findOneAndUpdate(
            { customer: order.customer.email },
            {
                $set: {
                    merchants: claimInfo.map((merchant) => ({
                        id: merchant._id.merchant_id,
                        name: merchant._id.merchant_name,
                        count: merchant.count,
                    })),
                },
            },
            {
                upsert: true,
                new: true,
            }
        );

        customerClaim.total_count = customerClaim.merchants.reduce(
            (total, merchant) => total + merchant.count,
            0
        );

        await customerClaim.save();
    } catch (error) {
        throwError(error);
    }
};

Claim.V2CreateClaim = async (payload) => {
    try {
        let { oid: orderId, reason, type, description, product_id, ip_address } = payload;
        reason = reason?.toUpperCase();
        type = type?.toUpperCase();
        const orderDetails = await Services.Order.get({ _id: orderId });
        if (!orderDetails) throwError("Invalid Order");
        assertSwipeProtectedOrder(orderDetails);
        const checkClaim = await Services.Claim.get({ order: orderId });
        if (checkClaim) throwError(MSG.CLAIM_IS_CREATED);

        const { productIds, claimItemsSnapshot } = buildClaimItemsSnapshot(
            orderDetails.line_items,
            product_id,
            true
        );
        if (!productIds.length) throwError("Please select at least one product.");

        const merchantInfo = await Services.Merchant.get({
            _id: orderDetails.merchant,
        });
        let claimObject = {
            merchant: merchantInfo._id,
            product_id: productIds,
            description,
            ip_address,
            reason: reason,
            refund_status: type,
            order: orderId,
            status: CLAIM_STATUS.REVIEWING,
             claim_items: claimItemsSnapshot,
            sub_status: CLAIM_SUB_STATUS.IN_REVIEW,
        };
        const claim = await Services.Claim.insert(claimObject);
        await customerCount(claim);
        await Services.Order.findOneAndUpdate(
            { _id: orderId },
            { $set: { is_claim_created: true } }
        );
        await Services.Event.insert({
            order: orderId,
            claim: claim._id,
            merchant: merchantInfo._id,
            type: EVENT_TYPE.ACTION,
            sub_type: EVENT_SUBTYPE.CLAIM_CREATED,
            action_on: ACTIVITY_LOG_LABEL.SYSTEM,
            title: EVENT_TITLE.CLAIM_CREATE,
            ts: Math.floor(new Date().getTime() / 1000),
        });

        await Notifications.sendNotification({
            subject: `New Claim Created on ${merchantInfo.name}`,
            to: [
                "pk@freedommedia.com",
                "junaid@freedommedia.com",
                "matt@freedommedia.com",
               
            ],
            template: "CLAIM_CREATE",
            merchant_name: merchantInfo.name,
            claim_link: `https://dashboard.swipe.ai/dashboard/claims/${claim._id}`,
            order_number: orderDetails.order_number,
        });



        await Notifications.sendNotification({
            subject: "Your Swipe Claim Has Been Received",
            to: [orderDetails.customer.email],
            template: "CLAIM_CREATE_CUSTOMER",
            order_id: orderDetails.id,
            claim_id: orderDetails.order_number || orderDetails.order_name?.replace('#', ''),
            customer_name: orderDetails.customer.name,
            order_number: orderDetails.order_number,
        });



        return { data: claim, message: MSG.CLAIM_CREATED };
    } catch (error) {
        throwError(error);
    }
};

Claim.AllClaimCount = async (condition = {}) => {
    try {
        const claimsInfo = await Services.Claim.getAll(
            {
                status: {
                    $in: [
                        CLAIM_STATUS.REVIEWING,
                        CLAIM_STATUS.APPROVED,
                        CLAIM_STATUS.CLOSED,
                        CLAIM_STATUS.RESOLVED,
                    ],
                },
                ...condition,
            },
            { status: 1 }
        );

        let claims = await Services.Claim.getAll({
            status: CLAIM_STATUS.REVIEWING,
        });
        claims = claims.length;
        console.log("claims", claims);
        const response = { in_review: 0, approved: 0, closed: 0, resolved: 0 };
        response["total"] = claimsInfo.length;
        for (let { status } of claimsInfo) {
            response[CLAIM_STATUS_OBJECT[status]] += 1;
        }
        return response;
    } catch (error) {
        throwError(error);
    }
};


Claim.StatisticList = async (params = {}) => {
    try {
        const formatCurrency = (value) => {
            if (value === undefined || value === null || isNaN(value)) return "$0.00";
            return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        };
        const formatNumber = (value) => {
            if (value === undefined || value === null || isNaN(value)) return "0";
            return Number(value).toLocaleString('en-US');
        };
        const { merchant_id, start_date, end_date, timezone } = params;
        if (!start_date || !end_date) {
            throw new Error("Start and end dates are required.");
        }
        const startDateMoment = moment.tz(start_date, "YYYY-MM-DD", timezone).startOf("day");
        const endDateMoment = moment.tz(end_date, "YYYY-MM-DD", timezone).endOf("day");
        let totalStatsCondition = { merchant: ObjectId(merchant_id) };
        let graphCondition = { merchant: ObjectId(merchant_id) };

        totalStatsCondition.createdAt = { $gte: startDateMoment.utc().toDate(), $lte: endDateMoment.clone().endOf('day').utc().toDate() };
        graphCondition.createdAt = { $gte: startDateMoment.utc().toDate(), $lte: endDateMoment.clone().endOf('day').utc().toDate() };

        const [claimsDataTotal, ordersDataTotal, resolvedRevenueData, claimsDataDaily, dailyOrders] = await Promise.all([
            global.Models.Claim.aggregate([
                { $match: totalStatsCondition },
                {
                    $group: {
                        _id: null,
                        in_review: { $sum: { $cond: [{ $eq: ["$status", "REVIEWING"] }, 1, 0] } },
                        approved: { $sum: { $cond: [{ $eq: ["$status", "APPROVED"] }, 1, 0] } },
                        closed: { $sum: { $cond: [{ $eq: ["$status", "CLOSED"] }, 1, 0] } },
                        resolved: { $sum: { $cond: [{ $eq: ["$status", "RESOLVED"] }, 1, 0] } },
                        total_claim: { $sum: 1 },
                    }
                }
            ]),
            global.Models.Order.aggregate([
                { $match: totalStatsCondition },
                {
                    $group: {
                        _id: null,
                        protected_order: { $sum: { $cond: ["$protection_item", 1, 0] } },
                        not_protected: { $sum: { $cond: ["$protection_item", 0, 1] } },
                        total_order: { $sum: 1 },
                        total_order_amount: { $sum: { $toDouble: { $ifNull: ["$total_price", "0"] } } },
                        total_swipe_protected: { $sum: { $toDouble: { $ifNull: ["$protection_amount", "0"] } } },
                        total_price: { $sum: { $cond: [{ $eq: ["$is_protected", true] }, { $toDouble: "$total_price" }, 0] } }
                    }
                }
            ]),
            global.Models.Claim.aggregate([
                { $match: { ...totalStatsCondition, status: { $in: ["RESOLVED", "APPROVED"] } } },
                {
                    $addFields: {
                        total_val: { $convert: { input: "$swipe_by_refunded", to: "double", onError: 0, onNull: 0 } },
                        ref_raw: { $convert: { input: "$refund_total", to: "double", onError: 0, onNull: 0 } },
                        reo_raw: { $convert: { input: "$reorder_total", to: "double", onError: 0, onNull: 0 } }
                    }
                },
                {
                    $addFields: {
                        refund_val: {
                            $cond: [
                                { $gt: [{ $add: ["$ref_raw", "$reo_raw"] }, 0] },
                                { $multiply: ["$total_val", { $divide: ["$ref_raw", { $add: ["$ref_raw", "$reo_raw"] }] }] },
                                { $cond: [{ $in: ["$refund_status", ["REFUND", "refund"]] }, "$total_val", 0] }
                            ]
                        },
                        reorder_val: {
                            $cond: [
                                { $gt: [{ $add: ["$ref_raw", "$reo_raw"] }, 0] },
                                { $multiply: ["$total_val", { $divide: ["$reo_raw", { $add: ["$ref_raw", "$reo_raw"] }] }] },
                                { $cond: [{ $in: ["$refund_status", ["REPLACE", "reorder"]] }, "$total_val", 0] }
                            ]
                        }
                    }
                },
                {
                    $group: {
                        _id: null,
                        saved_revenue: { 
                            $sum: { 
                                $add: [
                                    { $cond: [{ $in: ["$status", ["RESOLVED", "APPROVED"]] }, "$refund_val", 0] },
                                    { $cond: [{ $in: ["$status", ["RESOLVED", "APPROVED"]] }, "$reorder_val", 0] }
                                ]
                            } 
                        },
                    }
                }
            ]),
            global.Models.Claim.aggregate([
                { $match: graphCondition },
                {
                    $addFields: {
                        total_val: { $convert: { input: "$swipe_by_refunded", to: "double", onError: 0, onNull: 0 } },
                        ref_raw: { $convert: { input: "$refund_total", to: "double", onError: 0, onNull: 0 } },
                        reo_raw: { $convert: { input: "$reorder_total", to: "double", onError: 0, onNull: 0 } }
                    }
                },
                {
                    $addFields: {
                        refund_val: {
                            $cond: [
                                { $gt: [{ $add: ["$ref_raw", "$reo_raw"] }, 0] },
                                { $multiply: ["$total_val", { $divide: ["$ref_raw", { $add: ["$ref_raw", "$reo_raw"] }] }] },
                                { $cond: [{ $in: ["$refund_status", ["REFUND", "refund"]] }, "$total_val", 0] }
                            ]
                        },
                        reorder_val: {
                            $cond: [
                                { $gt: [{ $add: ["$ref_raw", "$reo_raw"] }, 0] },
                                { $multiply: ["$total_val", { $divide: ["$reo_raw", { $add: ["$ref_raw", "$reo_raw"] }] }] },
                                { $cond: [{ $in: ["$refund_status", ["REPLACE", "reorder"]] }, "$total_val", 0] }
                            ]
                        }
                    }
                },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: timezone } },
                        resolved_revenue_daily: { 
                            $sum: { 
                                $cond: [
                                    { $in: ["$status", ["RESOLVED", "APPROVED"]] },
                                    { $add: ["$refund_val", "$reorder_val"] },
                                    0
                                ]
                            } 
                        },
                    }
                },
                { $sort: { _id: 1 } }
            ]),
            global.Models.Order.aggregate([
                { $match: graphCondition },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: timezone } },
                        total_swipe_protected_daily: { $sum: { $toDouble: { $ifNull: ["$protection_amount", "0"] } } },
                        total_order_daily: { $sum: 1 },
                        protected_order_daily: { $sum: { $cond: ["$protection_item", 1, 0] } },
                        total_price: { $sum: { $toDouble: { $ifNull: ["$total_price", "0"] } } },
                    }
                },
                { $sort: { _id: 1 } }
            ]),
        ]);

        const totalClaims = claimsDataTotal[0] || {};
        const totalOrders = ordersDataTotal[0] || {};
        const savedRevenueResult = resolvedRevenueData[0] || { saved_revenue: 0 };
        const dailyClaims = claimsDataDaily || [];

        const totalStats = {
            ...totalClaims,
            ...totalOrders,
            protected_order_percentage: (totalOrders.total_order > 0) ? `${((totalOrders.protected_order * 100) / totalOrders.total_order).toFixed(2)}%` : "0.00%",
            saved_revenue: savedRevenueResult.saved_revenue,
            reviews_written: 0,
            csat: 0,
            atfr: 0,
        };

        const dailyStatsMap = new Map();
        let currentDate = startDateMoment.clone().startOf('day');
        while (currentDate.isSameOrBefore(endDateMoment, 'day')) {
            const dateStr = currentDate.format("YYYY-MM-DD");
            dailyStatsMap.set(dateStr, {
                date: dateStr,
                resolved_revenue_daily: 0,
                total_swipe_protected_daily: 0,
                total_order_daily: 0,
                protected_order_daily: 0,
                total_price: 0
            });
            currentDate.add(1, 'day');
        }

        dailyClaims.forEach(item => {
            const existing = dailyStatsMap.get(item._id) || {};
            dailyStatsMap.set(item._id, { ...existing, resolved_revenue_daily: item.resolved_revenue_daily });
        });

        dailyOrders.forEach(item => {
            const existing = dailyStatsMap.get(item._id) || {};
            dailyStatsMap.set(item._id, { ...existing, ...item });
        });

        const dailyStatsResponse = Array.from(dailyStatsMap.values()).map(item => ({
            date: item.date,
            protected_revenue: formatCurrency(item.total_swipe_protected_daily),
            resolved_revenue: formatCurrency(item.resolved_revenue_daily),
            protected_order_percentage: (item.total_order_daily > 0) ? `${((item.protected_order_daily * 100) / item.total_order_daily).toFixed(2)}%` : "0.00%",
            total_price: formatCurrency(item.total_price)
        }));

        const finalResponse = {
            total_stats: {
                in_review: formatNumber(totalStats.in_review),
                approved: formatNumber(totalStats.approved),
                closed: formatNumber(totalStats.closed),
                resolved: formatNumber(totalStats.resolved),
                total_claim: formatNumber(totalStats.total_claim),
                protected_order: formatNumber(totalStats.protected_order),
                not_protected: formatNumber(totalStats.not_protected),
                total_order: formatNumber(totalStats.total_order),
                total_order_amount: formatCurrency(totalStats.total_order_amount),
                total_swipe_protected: formatCurrency(totalStats.total_swipe_protected),
                saved_revenue: formatCurrency(totalStats.saved_revenue),
                protected_order_percentage: totalStats.protected_order_percentage,
                reviews_written: formatNumber(totalStats.reviews_written),
                csat: formatNumber(totalStats.csat),
                atfr: formatNumber(totalStats.atfr),
                total_price: formatCurrency(totalStats.total_price)
            },
            daily_stats: dailyStatsResponse
        };

        return {
            message: "Data found.",
            data: finalResponse,
        };

    } catch (error) {
        throw error;
    }
};
Claim.ClaimGraphisList = async (merchant_id, timezone) => {
    try {
        const startOfMonth = Moment.utc().startOf("month");
        const claim = await Services.Claim.aggregate([
            {
                $match: { merchant: merchant_id },
            },
            {
                $group: {
                    _id: {
                        year: {
                            $year: { date: "$createdAt", timezone: timezone },
                        },
                        month: {
                            $month: { date: "$createdAt", timezone: timezone },
                        },
                    },
                    count: { $sum: 1 },
                },
            },
            {
                $project: {
                    _id: 0,
                    month: { $toString: "$_id.month" },
                    year: { $toString: "$_id.year" },
                    count: 1,
                },
            },
            {
                $sort: {
                    year: 1,
                    month: 1,
                },
            },
        ]);
        const claimMap = new Map();
        claim.forEach((item) => {
            claimMap.set(`${item.year}-${item.month}`, item.count);
        });
        const claimList = [];
        for (let i = 5; i >= 0; i--) {
            const monthDate = startOfMonth.clone().subtract(i, "months");
            const year = monthDate.year().toString();
            const month = (monthDate.month() + 1).toString();
            const key = `${year}-${month}`;
            const count = claimMap.get(key) || 0;

            claimList.push({ year, month, count });
        }
        return { data: claimList, message: MSG.DATA_FOUND };
    } catch (error) {
        throwError(error);
    }
};

module.exports = Claim;
