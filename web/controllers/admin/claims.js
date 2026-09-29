const express = require("express");
const router = express.Router();
const Claim = Services.Claim;
const Event = Services.Event;
const { getMerchantTimezone } = require("../../utils/merchantTimezone");
const {
    calculateReorderGrossTotal,
} = require("../../utils/claimAdjustmentAmount");

const buildClaimAdjustmentKey = ({
    actionKey,
    claimId,
    orderId,
    type,
    amount,
    selectedItems = [],
}) => {
    if (!empty(actionKey)) {
        return `claim-action:${actionKey}`;
    }

    const normalizedItems = (selectedItems || [])
        .map((item) => ({
            id: String(item.id),
            quantity: Number(item.quantity || 0),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

    return `claim:${claimId}:order:${orderId}:type:${type}:amount:${Number(
        amount || 0
    ).toFixed(2)}:items:${JSON.stringify(normalizedItems)}`;
};


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
    type,
    order,
    claim,
    selectedItems,
    amount,
}) => {
    const customerEmail = order?.customer?.email;
    if (!customerEmail) return;

    const reorderDisplayId = claim?.reorder_details?.number
        ? `#${claim.reorder_details.number}`
        : claim?.reorder_id
            ? `#${claim.reorder_id}`
            : "";

    try {
        await Notifications.sendNotification({
            subject:
                type === "reorder"
                    ? "Your Swipe Reorder Has Been Created"
                    : "Your Swipe Refund Has Been Processed",
            to: [customerEmail],
            template:
                type === "reorder"
                    ? "CLAIM_REORDER_CUSTOMER"
                    : "CLAIM_REFUND_CUSTOMER",
            customer_name: order?.customer?.name || "Customer",
            order_id: getDisplayOrderId(order),
            reorder_id: reorderDisplayId,
            item_rows: buildResolutionItemRows(selectedItems, order?.line_items),
            total_amount: formatCurrency(amount),
        });
    } catch (emailError) {
        console.error(
            `[Claim Resolution Email] ${type} failed:`,
            emailError.message
        );
    }
};

const ClaimApproveOrReject = async (req, res, next) => {
    try {
        const { status, send_email } = req.body;
        const sendCustomerEmail = send_email !== false;
        let subStatus, subType, eventTitle;
        if (status === CLAIM_STATUS.APPROVED) {
            subStatus = CLAIM_SUB_STATUS.PROCESSED;
            subType = EVENT_SUBTYPE.CLAIM_APPROVED;
            eventTitle = EVENT_TITLE.CLAIM_APPROVED;
        }
        if (status === CLAIM_STATUS.CLOSED) {
            subStatus = CLAIM_SUB_STATUS.OTHER;
            subType = EVENT_SUBTYPE.CLAIM_CLOSED;
            eventTitle = EVENT_TITLE.CLAIM_CLOSED;
        }
        if (status === CLAIM_STATUS.REVIEWING) {
            subStatus = CLAIM_SUB_STATUS.IN_REVIEW;
            subType = EVENT_SUBTYPE.CLAIM_REVIEW;
            eventTitle = EVENT_TITLE.CLAIM_REVIEW;
        }

        const currentClaim = await Claim.get({ _id: req.params.id });
        const previous_status = currentClaim.status;

        const claim = await Claim.findOneAndUpdate(
            { _id: req.params.id },
            {
                $set: {
                    status,
                    sub_status: subStatus,
                    previous_status: previous_status,
                    resolved_date:
                        status === CLAIM_STATUS.CLOSED ? new Date() : null,
                },
            },
            { upsert: true, new: true }
        );
        const orderDetails = await Services.Order.get({ _id: claim.order });
        await Services.Event.insert({
            order: claim.order,
            claim: claim._id,
            merchant: claim.merchant,
            type: EVENT_TYPE.ACTION,
            sub_type: subType,
            who: req.user.display_name,
            action_on: ACTIVITY_LOG_LABEL.SYSTEM,
            title: eventTitle,
            ts: Math.floor(new Date().getTime() / 1000),
        });
        const merchant = await Services.Merchant.get({ _id: claim.merchant });
        if (status === CLAIM_STATUS.CLOSED) {
            // await Notifications.sendNotification({
            //     subject: `Update on Your Swipe Claim`,
            //     to: [merchant.email],
            //     template: "CLAIM_DENIED",
            //     merchant_name: merchant.name,
            //     order_id: orderDetails.id,
            //     claim_id: orderDetails.order_number,
            //     claim_link: `https://dashboard.swipe.ai/dashboard/claims/${claim._id}`,
            // });

            if (sendCustomerEmail) {
                await Notifications.sendNotification({
                    subject: `Update on Your Swipe Claim`,
                    to: [orderDetails.customer.email],
                    template: "CLAIM_DENIED_CUSTOMER",
                    customer_name: orderDetails.customer.name,
                    order_id: orderDetails.id,
                    order_number: orderDetails.order_number,
                });
            }
        } else if (status === CLAIM_STATUS.APPROVED) {
            const creationDate = new Date(claim.createdAt);
            const updateDate = new Date(claim.updatedAt);

            const timeDifference = updateDate - creationDate;

            const daysDifference = Math.floor(
                timeDifference / (1000 * 60 * 60 * 24)
            );
            await Notifications.sendNotification({
                subject: `New Claim Approved on ${merchant.name}`,
                to: ["junaid@freedommedia.com", "matt@freedommedia.com", "pk@freedommedia.com"],
                template: "CLAIM_CREATE_ADMIN",
                claim_link: `https://dashboard.swipe.ai/dashboard/claims/${claim._id}`,
                order_id: orderDetails.id,
                claim_id: orderDetails.order_number,
                merchant_name: merchant.name,
            });
            await Notifications.sendNotification({
                subject: `Update on Your Swipe Claim`,
                to: [orderDetails.customer.email],
                template: "CLAIM_APPROVED_CUSTOMER",
                order_id: orderDetails.id,
                customer_name: orderDetails.customer.name,
                days: daysDifference,
                order_number: orderDetails.order_number,
                status: status,
            });
        } else {
            // await Notifications.sendNotification({
            //     subject: `Update on Your Swipe Claim`,
            //      to:[ "junaid@freedommedia.com","swipe@swipe.ai", "angeli@swipe.ai"],
            //     template: `CLAIM_STATUS_MERCHANT`,
            //     merchant_name: merchant.name,
            //     claim_id: orderDetails.order_number,
            //     claim_status: status,
            //     claim_link: `https://dashboard.swipe.ai/dashboard/claims/${claim._id}`,
            // });
            await Notifications.sendNotification({
                subject: `Your Claim Is Under Review`,
                to: [orderDetails.customer.email],
                template: "CLAIM_STATUS_CUSTOMER",
                customer_name: orderDetails.customer.name,
                order_id: orderDetails.id,
                claim_status: claim.status,
                order_number: orderDetails.order_number,
            });
        }

        res.send({ message: MSG.CLAIM_UPDATE, data: claim });
    } catch (error) {
        return next(error);
    }
};

const ClaimDetails = async (req, res, next) => {
    try {
        const claimAccess = await Claim.get(
            { _id: req.params.id },
            { merchant: 1 }
        );
        if (!claimAccess) throwError(MSG.CLAIM_NOT_FOUND, 404);
        Auth.assertMerchantAccess(req.user, claimAccess.merchant);

        // Get the current claim details
        const response = await Claim.Details(req.params.id, req.user);

        // If claim exists, find previous and next claims with additional context for admin
        if (response.Claims && Object.keys(response.Claims).length > 0) {
            const claimId = req.params.id;

            // Build filtering condition based on query params
            let condition = {};
            const { merchant, status, startDate, endDate } = req.query;

            // If admin is filtering by merchant
            if (merchant) {
                condition.merchant = ObjectId(merchant);
            } else if (response.Claims.merchant && response.Claims.merchant._id) {
                // If no merchant filter is specified, use the merchant from the current claim
                condition.merchant = ObjectId(response.Claims.merchant._id);
            }

            // If admin is filtering by status
            if (status) {
                condition.status = status;
            }

            // If admin is filtering by date range
            if (startDate && endDate) {
                condition.createdAt = {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate)
                };
            }

            // Create sort object (default: newest first)
            const sortField = req.query.sort || 'createdAt';
            const sortOrder = parseInt(req.query.order || -1);
            const sortObj = {};
            sortObj[sortField] = sortOrder;

            // Get all claims matching the filter criteria
            const allClaims = await Claim.aggregate([
                { $match: condition },
                { $sort: sortObj },
                {
                    $lookup: {
                        from: "orders",
                        localField: "order",
                        foreignField: "_id",
                        as: "order_details"
                    }
                },
                {
                    $unwind: {
                        path: "$order_details",
                        preserveNullAndEmptyArrays: true
                    }
                },
                {
                    $lookup: {
                        from: "merchants",
                        localField: "merchant",
                        foreignField: "_id",
                        as: "merchant_details"
                    }
                },
                {
                    $unwind: {
                        path: "$merchant_details",
                        preserveNullAndEmptyArrays: true
                    }
                },
                {
                    $project: {
                        _id: 1,
                        status: 1,
                        sub_status: 1,
                        order_name: 1,
                        createdAt: 1,
                        order_name: "$order_details.name",
                        merchant_name: "$merchant_details.name",
                        merchant_id: "$merchant_details._id",
                        customer_email: "$order_details.customer.email",
                        customer_name: "$order_details.customer.name",
                        order_details: {
                            discount_applications: "$order_details.discount_applications",
                            total_discounts_set: "$order_details.total_discounts_set",
                            total_line_items_price_set: "$order_details.total_line_items_price_set",
                            total_shipping_price_set: "$order_details.total_shipping_price_set",
                            total_tax_set: "$order_details.total_tax_set",
                            total_price_set: "$order_details.total_price_set",
                            financial_status: "$order_details.financial_status",
                        },

                    }
                }
            ]);

            // Find the current claim's index
            const currentIndex = allClaims.findIndex(c => c._id.toString() === claimId);

            // Set previous and next claims with additional context for admin
            if (currentIndex > 0) {
                const prevClaim = allClaims[currentIndex - 1];
                response.Claims.previous_claim = {
                    id: prevClaim._id,
                    order_name: prevClaim.order_name,
                    status: prevClaim.status,
                    sub_status: prevClaim.sub_status,
                    merchant_name: prevClaim.merchant_name,
                    merchant_id: prevClaim.merchant_id,
                    customer_name: prevClaim.customer_name,
                    customer_email: prevClaim.customer_email,
                    created_at: prevClaim.createdAt
                };
            } else {
                response.Claims.previous_claim = null;
            }

            if (currentIndex < allClaims.length - 1) {
                const nextClaim = allClaims[currentIndex + 1];
                response.Claims.next_claim = {
                    id: nextClaim._id,
                    order_name: nextClaim.order_name,
                    status: nextClaim.status,
                    sub_status: nextClaim.sub_status,
                    merchant_name: nextClaim.merchant_name,
                    merchant_id: nextClaim.merchant_id,
                    customer_name: nextClaim.customer_name,
                    customer_email: nextClaim.customer_email,
                    created_at: nextClaim.createdAt
                };
            } else {
                response.Claims.next_claim = null;
            }
        }

        return res.send(response);
    } catch (error) {
        return next(error);
    }
};

const AddClaimEvent = async (req, res, next) => {
    try {
        const response = await Services.Event.insert({
            order: req.body.order,
            merchant: req.body.merchant,
            claim: req.body.claim,
            type: EVENT_TYPE.COMMENT,
            content: req.body.content,
            sub_type: EVENT_SUBTYPE.TIMELINE_CREATED,
            who: req.user.display_name,
            action_on: ACTIVITY_LOG_LABEL.SYSTEM,
            title: EVENT_TITLE.CLAIM_CREATE,
            ts: Math.floor(new Date().getTime() / 1000),
        });
        res.send({ message: MSG.EVENT_SAVE, data: response });
    } catch (error) {
        return next(error);
    }
};

const ClaimReorderOrRefund = async (req, res, next) => {
    try {
        const {
            orderId,
            claimId,
            claim_total,
            refund_total,
            reorder_total,
            refund_status,
            action_key,
            selectedItems,
        } = req.body;
        const normalizedStatus = String(refund_status || "").toLowerCase();
        let actionAmount =
            normalizedStatus === "reorder"
                ? Number(reorder_total || claim_total || 0)
                : Number(refund_total || claim_total || 0);

        if (!["refund", "reorder"].includes(normalizedStatus)) {
            throwError("Invalid refund status.");
        }

        const claim = await Claim.get(
            { _id: claimId },
            {
                status: 1,
                resolved_date: 1,
                claim_total: 1,
                refund_total: 1,
                reorder_total: 1,
                swipe_by_refunded: 1,
                combined_refund_total: 1,
                processed_billing_actions: 1,
                reorder_id: 1,
                reorder_details: 1,
            }
        );

        if (!claim) throwError(MSG.CLAIM_NOT_FOUND);

        if (
            claim.status !== CLAIM_STATUS.APPROVED &&
            claim.status !== CLAIM_STATUS.RESOLVED
        ) {
            throwError("Claim cannot be actioned. Status is not APPROVED or RESOLVED.");
        }

        const order = await Services.Order.get(
            { _id: orderId },
            {
                total_price_set: 1,
                merchant: 1,
                name: 1,
                order_number: 1,
                id: 1,
                line_items: 1,
                "customer.email": 1,
                "customer.name": 1,
            }
        );

        if (!order) throwError("Order not found");

        // A replacement order receives a 100% Shopify discount so the
        // customer pays $0. Swipe's reorder liability is still the selected
        // products' gross merchandise value, before that replacement discount
        // and before discounts from the original order.
        if (normalizedStatus === "reorder") {
            actionAmount = calculateReorderGrossTotal(
                order.line_items,
                selectedItems
            );
        }

        if (!(actionAmount > 0)) {
            throwError("Adjustment amount must be greater than zero.");
        }

        const adjustmentKey = buildClaimAdjustmentKey({
            actionKey: action_key,
            claimId,
            orderId,
            type: normalizedStatus,
            amount: actionAmount,
            selectedItems,
        });

        const order_total_price = Number(order.total_price_set.shop_money.amount);

        const merchantInfo = await Services.Merchant.get({ _id: order.merchant });
        if (!merchantInfo) return res.send({ message: MSG.MERCHANT_NOT_EXIST });

        // ✅ OLD BEHAVIOR: cumulative totals
        if ((claim.processed_billing_actions || []).includes(adjustmentKey)) {
            return res.send({
                message: "Claim billing action already processed.",
                data: claim,
            });
        }

        const currentClaimTotal = Number(claim.claim_total || 0);
        const newClaimTotal = currentClaimTotal + actionAmount;

        const updateObj = {
            claim_total: newClaimTotal.toFixed(2),
            refund_status,
            processed_billing_actions: [
                ...(claim.processed_billing_actions || []),
                adjustmentKey,
            ],
        };

        if (!claim.resolved_date) {
            updateObj.resolved_date = new Date();
        }

        const incOperations = {};

        // ===================== REFUND =====================
        if (normalizedStatus === "refund") {
            const prevRefundTotal = Number(claim.refund_total || 0);
            const prevSwipeRefund = Number(claim.swipe_by_refunded || 0);
            const prevCombined = Number(claim.combined_refund_total || 0);

            const refundAmount = actionAmount;

            updateObj.refund_total = (prevRefundTotal + refundAmount).toFixed(2);
            updateObj.combined_refund_total = (prevCombined + refundAmount).toFixed(2);
            updateObj.swipe_by_refunded = Math.min(
                prevSwipeRefund + refundAmount,
                order_total_price
            ).toFixed(2);

       
        }

        // ===================== REORDER =====================
        else if (normalizedStatus === "reorder") {
            const prevReorderTotal = Number(claim.reorder_total || 0);
            const prevSwipeRefund = Number(claim.swipe_by_refunded || 0);
            const prevCombined = Number(claim.combined_refund_total || 0);

            const reorderAmount = actionAmount;

            updateObj.reorder_total = (prevReorderTotal + reorderAmount).toFixed(2);
            updateObj.combined_refund_total = (prevCombined + reorderAmount).toFixed(2);
            updateObj.swipe_by_refunded = Math.min(
                prevSwipeRefund + reorderAmount,
                order_total_price
            ).toFixed(2);

        }

        // ===================== BILLING =====================
        const description = replaceMulti(MSG.APP_CREDIT_MESSAGE, {
            "[CLAIM_ID]": claimId,
            "[ORDER_ID]": orderId,
            "[TYPE]": normalizedStatus,
            "[AMOUNT]": actionAmount,
        });

        const data = await Claim.findOneAndUpdate(
            {
                _id: claimId,
                processed_billing_actions: { $ne: adjustmentKey },
            },
            {
                $set: updateObj,
                $inc: incOperations,
            },
            { new: true }
        );

        if (!data) {
            const existingClaim = await Claim.get({ _id: claimId });
            return res.send({
                message: "Claim billing action already processed.",
                data: existingClaim,
            });
        }

        if (merchantInfo.is_billing) {
            await Services.UsageRecord.createLedgerEntry({
                merchant: order.merchant,
                order: orderId,
                amount: actionAmount,
                type: "credit",
                claim: claimId,
                credit_type: normalizedStatus || "refund",
                source_type:
                    normalizedStatus === "reorder"
                        ? "claim_reorder"
                        : "claim_refund",
                adjustment_key: adjustmentKey,
                action_key,
                metadata: {
                    selected_items: selectedItems || [],
                    claim_total: actionAmount,
                },
            });
        }

        if (normalizedStatus === "refund") {
            await sendClaimResolutionCustomerEmail({
                type: normalizedStatus,
                order,
                claim: data,
                selectedItems,
                amount: actionAmount,
            });
        }

        return res.send({ message: MSG.CLAIM_UPDATE, data });
    } catch (error) {
        return next(error);
    }
};


const OrderSearch = async (req, res, next) => {
    try {
        Auth.assertMerchantAccess(req.user, req.body.merchant);
        const result = await Claim.SearchOrder(req);
        res.send(result);
    } catch (error) {
        return next(error);
    }
};

const CreateClaim = async (req, res, next) => {
    try {
        const order = await Services.Order.get(
            { _id: req.body.oid },
            { merchant: 1 }
        );
        if (!order) throwError("Invalid Order", 404);
        Auth.assertMerchantAccess(req.user, order.merchant);
        if (String(order.merchant) !== String(req.body.mid)) {
            throwError("Order does not belong to the selected store.", 403);
        }

        const payload = {
            ...req.body,
            type: req.body.reason || req.body.type,
            preference: req.body.preference || req.body.type,
            created_by: req.user._id,
            created_role: req.user.role,
        };
        const response = await Claim.CreateClaim(payload);
        return res.send(response);
    } catch (error) {
        return next(error);
    }
};


const ClaimLists = async (req, res, next) => {
    try {
        let { merchant, start_date, end_date, search, status } = req.body;

        let mainCondition = [];
        let regexCondition = {};

        const timezone = await getMerchantTimezone(merchant);


        if (merchant) {
            Auth.assertMerchantAccess(req.user, merchant);
            mainCondition.push({ merchant: ObjectId(merchant) });
        }

        if (!Auth.isSuperAdmin(req.user)) {
            const assignedMerchants = Auth.getAssignedMerchantIds(req.user).map(
                (id) => ObjectId(id)
            );
            mainCondition.push({ merchant: { $in: assignedMerchants } });
        }

        if (status && Array.isArray(status) && status.length > 0) {
            mainCondition.push({
                status: { $in: status.map((s) => s.toUpperCase()) },
            });
        }

        if (start_date && end_date) {
            try {
                const startDateMoment = Moment.tz(start_date, "MM-DD-YYYY", timezone).startOf('day');
                const endDateMoment = Moment.tz(end_date, "MM-DD-YYYY", timezone).endOf('day');

                mainCondition.push({
                    createdAt: {
                        $gte: startDateMoment.toDate(),
                        $lte: endDateMoment.toDate(),
                    }
                });
            } catch (e) {
                console.error("Date Parsing Error:", e);
            }
        }
        if (search) {
            regexCondition = {
                $or: [
                    { "order.name": { $regex: search, $options: "i" } },
                    { "order.customer.email": { $regex: search, $options: "i" } },
                    { "order.customer.name": { $regex: search, $options: "i" } },
                ],
            };
        }


        let pipeline = [];

        if (mainCondition.length > 0) {
            pipeline.push({ $match: { $and: mainCondition } });
        }

        pipeline.push(
            {
                $lookup: {
                    from: "merchants",
                    localField: "merchant",
                    foreignField: "_id",
                    as: "merchant",
                },
            },
            { $unwind: { path: "$merchant", preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: "orders",
                    localField: "order",
                    foreignField: "_id",
                    as: "order",
                },
            },
            { $unwind: { path: "$order", preserveNullAndEmptyArrays: true } }
        );
        if (Object.keys(regexCondition).length > 0) {
            pipeline.push({ $match: regexCondition });
        }

        pipeline.push(
            {
                $addFields: {

                    originalCreatedAt: "$createdAt",

                    createdAt: {
                        $dateToString: {
                            format: "%b %d, %Y, %H:%M",
                            date: "$createdAt",
                            timezone: timezone
                        }
                    },
                }
            },

            { $sort: { originalCreatedAt: -1 } },

            {
                $project: {
                    _id: 1,
                    order_id: "$order.name",
                    merchant_id: "$merchant._id",
                    merchant_name: "$merchant.name",
                    customer_email: "$order.customer.email",
                    customer_name: "$order.customer.name",
                    createdAt: 1,
                    status: 1,
                    sub_status: 1,
                    previous_status: 1,

                    refund_status: {
                        $cond: [
                            { $in: ["$refund_status", ["REFUND", "refund"]] },
                            "refund",
                            {
                                $cond: [
                                    { $in: ["$refund_status", ["REPLACE", "reorder"]] },
                                    "reorder",
                                    {
                                        $cond: [
                                            { $eq: ["$status", "RESOLVED"] },
                                            "processed",
                                            "pending"
                                        ]
                                    }
                                ]
                            }
                        ]
                    },
                },
            }
        );

        const limit = parseInt(req.query.limit) || 25;
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;

        pipeline.push({
            $facet: {
                metadata: [{ $count: "totalRecords" }],
                response: [{ $skip: skip }, { $limit: limit }],
            },
        });

        const [result] = await Claim.aggregate(pipeline);
        const { metadata, response } = result;

        const totalRecords = metadata.length > 0 ? metadata[0].totalRecords : 0;

        return res.send({
            message: response.length ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: {
                totalRecords: totalRecords,
                response: response,
            },
        });
    } catch (error) {
        return next(error);
    }
};
const AddComment = async (req, res, next) => {
    try {
        const result = await Event.insertComment(req);
        res.send(result);
    } catch (error) {
        next(error);
    }
};

const ListComment = async (req, res, next) => {
    try {
        const result = await Event.getAllComment(req, [
            EVENT_TYPE.COMMENT,
            EVENT_TYPE.INTERNAL_COMMENT,
        ]);
        res.send(result);
    } catch (error) {
        next(error);
    }
};

router.get(
    "/:id",
    Func.validate(AdminRules.ParamsId),
    Auth.check,
    Auth.requireAdminPermission(ADMIN_PERMISSION.CLAIMS_VIEW),
    ClaimDetails
);
router.post(
    "/list",
    Auth.check,
    Auth.requireAdminPermission(ADMIN_PERMISSION.CLAIMS_VIEW),
    ClaimLists
);
router.post(
    "/event/add",
    Auth.check,
    Auth.requireSuperAdmin,
    AddClaimEvent
);
router.post(
    "/search/order",
    Auth.check,
    Auth.requireAdminPermission(ADMIN_PERMISSION.CLAIMS_CREATE),
    Func.validate(AdminRules.SearchOrder),
    OrderSearch
);
router.post(
    "/new/claims",
    Auth.check,
    Auth.requireAdminPermission(ADMIN_PERMISSION.CLAIMS_CREATE),
    Func.validate(AdminRules.NewClaim),
    CreateClaim
);
router.post(
    "/approve-or-reject/:id",
    Func.validate(AdminRules.ParamsId),
    Auth.check,
    Auth.requireSuperAdmin,
    ClaimApproveOrReject
);
router.put(
    "/approved",
    Auth.check,
    Auth.requireSuperAdmin,
    ClaimReorderOrRefund
);
router.get(
    "/comment/:claim",
    Auth.check,
    Auth.requireAdminPermission(ADMIN_PERMISSION.CLAIMS_VIEW),
    async (req, _res, next) => {
        try {
            const claim = await Claim.get({ _id: req.params.claim }, { merchant: 1 });
            if (!claim) throwError(MSG.CLAIM_NOT_FOUND, 404);
            Auth.assertMerchantAccess(req.user, claim.merchant);
            next();
        } catch (error) {
            next(error);
        }
    },
    ListComment
);
router.post("/comment", Auth.check, Auth.requireSuperAdmin, AddComment);

module.exports = router;


