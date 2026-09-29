const express = require("express");
const router = express.Router();

const NewClaim = async (req, res, next) => {
    try {
        let result = await Services.Claim.CreateClaim(req.body);
        return res.send(result);
    } catch (error) {
        return next(error);
    }
};

const V2NewClaim = async (req, res, next) => {
    try {
        let result = await Services.Claim.V2CreateClaim(req.body);
        return res.send(result);
    } catch (error) {
        return next(error);
    }
};

const imageUploadForClaim = async (req, res, next) => {
    try {
        const content = req.files.file_content;
        const parts = req.files.file_content.name.split(".");
        const namePart = parts[0];
        const file_name = `${namePart}${createRandomString(10)}.jpg`;
        const environment = `claim/${process.env.S3_ENVIRONMENT}`;
        const data = await S3.uploadExport(file_name, content.data, environment);
        return res.send({
            message: MSG.FILE_UPLOADED,
            data: data.Location,
        });
    } catch (error) {
        return next(error);
    }
};

const formatAmount = (value) => {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
};

const buildClaimDetails = (claimInfo) => {
    const claim =
        typeof claimInfo?.toObject === "function"
            ? claimInfo.toObject()
            : claimInfo || {};

    return {
        id: claim._id || null,
        claim_id: claim._id || null,
        merchant: claim.merchant || null,
        order: claim.order || null,
        status: claim.status || null,
        sub_status: claim.sub_status || null,
        previous_status: claim.previous_status || null,
        reason: claim.reason || null,
        description: claim.description || null,
        refund_status: claim.refund_status || null,
        source: claim.source || null,
        address_verified: Boolean(claim.address_verified),
        product_id: claim.product_id || [],
        products: claim.products || [],
        claim_items: claim.claim_items || [],
        totals: {
            claim_total: formatAmount(claim.claim_total),
            original_shipping_total: formatAmount(claim.original_shipping_total),
            refund_total: formatAmount(claim.refund_total),
            refund_shipping_total: formatAmount(claim.refund_shipping_total),
            reorder_total: formatAmount(claim.reorder_total),
            reorder_shipping_total: formatAmount(claim.reorder_shipping_total),
            combined_refund_total: formatAmount(claim.combined_refund_total),
            swipe_by_refunded: formatAmount(claim.swipe_by_refunded),
            claim_total_amount:
                claim.claim_total_amount !== undefined
                    ? Number(claim.claim_total_amount)
                    : null,
        },
        counts: {
            refund_count: Number(claim.refund_count || 0),
            reorder_count: Number(claim.reorder_count || 0),
            customer_claim_no: Number(claim.customer_claim_no || 0),
            total_claim_no: Number(claim.total_claim_no || 0),
        },
        resolution: {
            resolved_date: claim.resolved_date || null,
            refunded_partial_amount: Boolean(claim.refunded_partial_amount),
            reorder_id: claim.reorder_id || null,
            reorder_details: claim.reorder_details || null,
        },
        snapshots: {
            order: claim.order_snapshot || null,
            merchant: claim.merchant_snapshot || null,
        },
        created_by: claim.created_by || null,
        created_role: claim.created_role || null,
        reviewers: claim.reviewers || [],
        created_at: claim.createdAt || null,
        updated_at: claim.updatedAt || null,
    };
};
const findDeliveredDate = (fulfillment) => {
    return (
        fulfillment?.delivered_at ||
        fulfillment?.delivery_date ||
        fulfillment?.deliveredAt ||
        fulfillment?.events?.find?.((event) =>
            String(event?.status || "").toLowerCase() === "delivered"
        )?.timestamp ||
        null
    );
};

const buildDeliveryDetails = (orderInfo) => {
    const fulfillments = Array.isArray(orderInfo?.fulfillments)
        ? orderInfo.fulfillments
        : [];
    const deliveredFulfillment = fulfillments.find(
        (fulfillment) =>
            String(fulfillment?.shipment_status || "").toLowerCase() === "delivered" ||
            Boolean(findDeliveredDate(fulfillment))
    );
    const primaryFulfillment = deliveredFulfillment || fulfillments[0] || {};
    const orderTrackingStatus = orderInfo?.tracking_status || null;
    const shipmentStatus = primaryFulfillment?.shipment_status || null;
    const normalizedStatus = String(shipmentStatus || orderTrackingStatus || "").toLowerCase();
    const deliveredAt =
        findDeliveredDate(deliveredFulfillment) ||
        (normalizedStatus === "delivered" ? primaryFulfillment?.updated_at || null : null);

    return {
        delivery_status: normalizedStatus || null,
        is_delivered: normalizedStatus === "delivered",
        delivered_at: deliveredAt,
        order_tracking_status: orderTrackingStatus,
        shipment_status: shipmentStatus,
        fulfilled_at: primaryFulfillment?.created_at || null,
        fulfillment_updated_at: primaryFulfillment?.updated_at || null,
        tracking_company:
            primaryFulfillment?.tracking_company || orderInfo?.tracking_company || null,
        tracking_number:
            primaryFulfillment?.tracking_number ||
            primaryFulfillment?.tracking_numbers?.[0] ||
            orderInfo?.tracking_number ||
            orderInfo?.tracking_numbers?.[0] ||
            null,
        tracking_url:
            primaryFulfillment?.tracking_url ||
            primaryFulfillment?.tracking_urls?.[0] ||
            orderInfo?.tracking_url ||
            orderInfo?.tracking_urls?.[0] ||
            null,
    };
};

const getEventDate = (event) => {
    if (event?.createdAt) return event.createdAt;
    if (event?.ts) return new Date(Number(event.ts) * 1000);
    return null;
};

const buildClaimStatusHistory = (claimInfo, events = []) => {
    const claim =
        typeof claimInfo?.toObject === "function"
            ? claimInfo.toObject()
            : claimInfo || {};
    const findEventDate = (subType) => {
        const event = events.find((item) => item.sub_type === subType);
        return getEventDate(event);
    };

    const createdAt = findEventDate("CLAIM_CREATED") || claim.createdAt || null;
    const reviewedAt = findEventDate("CLAIM_REVIEW") || createdAt;
    const approvedAt = findEventDate("CLAIM_APPROVED") || null;
    const closedAt = findEventDate("CLAIM_CLOSED") || null;
    const resolvedAt = claim.resolved_date || null;
    const history = events.map((event) => ({
        sub_type: event.sub_type || null,
        title: event.title || null,
        date: getEventDate(event),
    }));

    if (resolvedAt && !history.some((event) => event.sub_type === "CLAIM_RESOLVED")) {
        history.push({
            sub_type: "CLAIM_RESOLVED",
            title: "Claim resolved",
            date: resolvedAt,
        });
    }

    return {
        claim_created_at: createdAt,
        claim_reviewed_at: reviewedAt,
        claim_approved_at: approvedAt,
        claim_closed_at: closedAt,
        claim_resolved_at: resolvedAt,
        history,
    };
};
const TrackClaimDetails = async (req, res, next) => {
    try {
        const { email, order_number } = req.body;
        Func.emailValidation(email);
        
        // 1. Order aur Claim ki maloomat hasil karna
        const orderInfo = await Services.Order.get({
            order_number: Number(order_number),
            "customer.email": email,
        });
        if (!orderInfo) {
            throw new Error("No data found for the provided information.");
        }
        
        // **Claim Model se data nikalte waqt Claim object ki `product_id` aur `products` dono arrays aati hain**
        const claimInfo = await Services.Claim.get({ order: orderInfo._id });
        
        if (!claimInfo) {
            throw new Error("No claim found for this order."); 
        }

        const claimEvents = await Services.Event.aggregate([
            { $match: { claim: claimInfo._id, type: "ACTION" } },
            { $sort: { ts: 1, createdAt: 1 } },
            { $project: { _id: 0, title: 1, sub_type: 1, ts: 1, createdAt: 1 } },
        ]);
        const claimStatusHistory = buildClaimStatusHistory(claimInfo, claimEvents);

        const merchantInfo = await Services.Merchant.get(
            { _id: orderInfo.merchant },
            { shop_id: 1 }
        );
        
        // 2. Claim Type ka pata lagana
        const refundTotal = Number(claimInfo?.refund_total || 0);
        const reorderTotal = Number(claimInfo?.reorder_total || 0);
        
        let claimType = "None";
        if (refundTotal > 0 && reorderTotal > 0) {
            claimType = "Refund & Reorder";
        } else if (refundTotal > 0) {
            claimType = "Refund";
        } else if (reorderTotal > 0) {
            claimType = "Reorder";
        }

        // 3. 🚨 CLAIMED PRODUCT IDs ka map banana (Aggregation logic ke mutabiq: li.id se match)
        // Aggregation pipeline mein `product_id` field ko use kiya gaya hai, jo ke Line Item IDs ki array lagti hai.
        // Aur `products` field se claimed quantity aur total value aayegi.
        
        const claimedLineItemIds = (claimInfo.product_id || []).map(String); 
        
        // Claimed products ka map banayenge, jahan key `p.id` (Line Item ID) ya `p.product_id` hogi.
        const claimedProductsDataMap = {};
        
        // Claim ke `products` array se claimed quantity aur total value ko store karen
        // Yahan assumption hai ke `claimInfo.products` mein `id` ya `product_id` wohi field hai jo Line Item ID se match ho.
        (claimInfo.products || []).forEach(p => {
             // Hum `p.id` (jo ke Line Item ID ho sakta hai) ko key bana rahe hain.
            claimedProductsDataMap[String(p.id)] = { 
                claimed_quantity: Number(p.quantity || 0),
                claimed_total_value: Number(p.claim_total || 0), 
            };
            // Fallback: Agar p.product_id bhi available ho
            if (p.product_id) {
                 claimedProductsDataMap[String(p.product_id)] = { 
                    claimed_quantity: Number(p.quantity || 0),
                    claimed_total_value: Number(p.claim_total || 0), 
                };
            }
        });
        
        // Agar `claimInfo.product_id` array mein IDs hain, toh un IDs ko bhi map mein shamil karen
        claimedLineItemIds.forEach(id => {
            // Agar `claimInfo.products` mein data nahi tha, tab bhi hum `product_id` array ko use kar saken.
             if (!claimedProductsDataMap[id]) {
                 // Agar product details claimInfo.products se na milay, toh 
                 // hum quantity/price Order Info se use karen ge (yaani sirf filtering ke liye)
                claimedProductsDataMap[id] = { claimed_quantity: 0, claimed_total_value: 0 };
             }
        });

        let totalProductsAmount = 0; 
        
      const productDetails = (orderInfo.line_items || [])
    // ❌ Swipe product remove
    .filter(li => li.title !== "Swipe Package Protection")

    // ❌ quantity 0 / removed products remove
    .filter(li => Number(li.quantity) > 0)

    // ✅ ONLY claimed products (SOURCE OF TRUTH = claim.product_id[])
    .filter(li => claimedProductsDataMap[String(li.id)])

    .map(i => {
        const claimedData = claimedProductsDataMap[String(i.id)];
        if (!claimedData) return null;

        const unitPrice = Number(i.final_price || i.final_sale_price || 0);
        const quantity = claimedData.claimed_quantity || Number(i.quantity || 0);
        const lineTotal =
            claimedData.claimed_total_value || unitPrice * quantity;

        totalProductsAmount += lineTotal;

        return {
            product_id: i.id,
            claimed_product_ref_id: i.product_id || i.variant_id || null,
            name: i.name || i.title || "",
            image_url: i.image_url || "",
            claimed_quantity: quantity,
            unit_price: unitPrice.toFixed(2),
            claimed_total_value: lineTotal.toFixed(2),
        };
    })
    .filter(Boolean);

            
        // 5. Address ki maloomat
        const shippingAddress = orderInfo.shipping_address || {};
        const deliveryDetails = buildDeliveryDetails(orderInfo);

        // 6. Mukammal Response bhejna
        const responseData = {
                // ... (Bunyadi aur Claim ki tafseelat)
                orderId: orderInfo._id,
                orderNumber: orderInfo.order_number,
                email: orderInfo.customer?.email || null, 
                orderDate: Moment(orderInfo.order_created_at || orderInfo.createdAt).format("DD-MMMM-YYYY"),
                storeId: merchantInfo?.shop_id || null,
                total_order_paid: Number(orderInfo.total_price_set?.shop_money?.amount || orderInfo.final_total_price || 0).toFixed(2),
                
                total_claim_amount: Number(claimInfo?.claim_total || 0).toFixed(2),
                claim_status: claimInfo?.status || null,
                claim_sub_status: claimInfo?.sub_status || null,
                claim_type: claimType, 
                claim_status_history: claimStatusHistory,
                
                refund_amount: refundTotal.toFixed(2),
                reorder_amount: reorderTotal.toFixed(2),
                refund_status: claimInfo?.refund_status || null,
                delivery_status: deliveryDetails.delivery_status,
                is_delivered: deliveryDetails.is_delivered,
                delivered_at: deliveryDetails.delivered_at,
                delivery_details: deliveryDetails,
                
                reason: claimInfo?.reason,
                description: claimInfo?.description,

                shippingAddress: {
                    address1: shippingAddress.address1 || null,
                    address2: shippingAddress.address2 || null,
                    city: shippingAddress.city || null,
                    province: shippingAddress.province || null,
                    country: shippingAddress.country || null,
                    zip: shippingAddress.zip || null,
                    name: shippingAddress.name || null,
                },
                
                // Claimed Products ka Data
                total_products_amount: totalProductsAmount.toFixed(2), 
                productDetails,
                claim_details: buildClaimDetails(claimInfo),
        };

        return res.send({
            message: MSG.DATA_FOUND,
            data: responseData,
        });

    } catch (error) {
        console.error("TrackClaimDetails Error:", error);
        return next(error);
    }
};


const TrackClaimDetailsForDashboard = async (req, res, next) => {
    try {
        const { email, order_number, shop_id } = req.body;
        const merchant = await Services.Merchant.get({ shop_id: shop_id });
        console.log("merchant", merchant);
        if (!merchant) {
            throw new Error(
                "Please check your URL — you may have entered an incorrect shop ID."
            );
        }
        const order = await Services.Order.get({
            order_number: Number(order_number),
            "customer.email": email,
        });
        if (!order) {
            throw new Error("No data found for the provided information.");
        }

        const result = await Services.Order.aggregate([
            {
                $match: {
                    order_number: Number(order_number),
                    "customer.email": email,
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
            { $unwind: "$claims" },
            {
                $project: {
                    order_number: 1,
                    claim_status: "$claims.status",
                    total_claim_amount: "$claims.claim_total",
                    refund_or_reorder: "$claims.is_refund",
                    claim_sub_status: "$claims.sub_status",
                    claim_refund_total: "$claims.refund_total",
                    claim_reorder_total: "$claims.reorder_total",
                    email: "$$ROOT.customer.email",
                },
            },
        ]);
        return res.send({
            message: result.length ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: result[0],
        });
    } catch (error) {
        return next(error);
    }
};

router.post("/", Func.validate(V1Rules.NewClaim), NewClaim);
router.post("/v2-claim-create", Func.validate(V1Rules.V2NewClaim), V2NewClaim);
router.post("/upload", imageUploadForClaim);
router.post(
    "/track",
    Func.validate(V1Rules.TrackClaimDetails),
    TrackClaimDetails
);
router.post(
    "/v2/track",
    Func.validate(V1Rules.TrackClaimDetailsDashboard),
    TrackClaimDetailsForDashboard
);

module.exports = router;
