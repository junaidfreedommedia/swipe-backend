const express = require("express");
const router = express.Router();
const Claim = Services.Claim;
const Event = Services.Event;

const ClaimApproveOrReject = async (req, res, next) => {
    try {
        const { status } = req.body;
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
            await Notifications.sendNotification({
                subject: `Update on Your Swipe Claim`,
                to: [merchant.email],
                template: "CLAIM_DENIED",
                merchant_name: merchant.name,
                order_id: orderDetails.id,
                claim_id: claim._id,
                claim_link: `https://dashboard.swipe.ai/dashboard/claims/${claim._id}`,
            });

            await Notifications.sendNotification({
                subject: `Update on Your Swipe Claim`,
                to: [orderDetails.customer.email],
                template: "CLAIM_DENIED_CUSTOMER",
                customer_name: orderDetails.customer.name,
                order_id: orderDetails.id,
            });
        } else if (status === CLAIM_STATUS.APPROVED) {
            const creationDate = new Date(claim.createdAt);
            const updateDate = new Date(claim.updatedAt);

            const timeDifference = updateDate - creationDate;

            const daysDifference = Math.floor(
                timeDifference / (1000 * 60 * 60 * 24)
            );
            await Notifications.sendNotification({
                subject: `Update on Your Swipe Claim`,
                to: [merchant.email],
                template: "CLAIM_APPROVED",
                claim_link: `https://dashboard.swipe.ai/dashboard/claims/${claim._id}`,
                order_id: orderDetails.id,
                claim_id: claim._id,
                merchant_name: merchant.name,
            });
            await Notifications.sendNotification({
                subject: `Update on Your Swipe Claim`,
                to: [orderDetails.customer.email],
                template: "CLAIM_APPROVED_CUSTOMER",
                order_id: orderDetails.id,
                customer_name: orderDetails.customer.name,
                days: daysDifference,
            });
        } else {
            await Notifications.sendNotification({
                subject: `Your ${orderDetails.customer.name} Claim is ${status}`,
                to: [merchant.email],
                template: `CLAIM_STATUS_MERCHANT`,
                merchant_name: merchant.name,
                claim_id: claim._id,
                claim_status: status,
                claim_link: `https://dashboard.swipe.ai/dashboard/claims/${claim._id}`,
            });
            await Notifications.sendNotification({
                subject: `Update on Your Swipe Claim`,
                to: [orderDetails.customer.email],
                template: "CLAIM_STATUS_CUSTOMER",
                customer_name: orderDetails.customer.name,
                order_id: orderDetails.id,
                claim_status: claim.status,
            });
        }

        res.send({ message: MSG.CLAIM_UPDATE, data: claim });
    } catch (error) {
        return next(error);
    }
};

const ClaimDetails = async (req, res, next) => {
    try {
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
                        customer_name: "$order_details.customer.name"
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
            refund_count,
            reorder_count,
            reorder_id,
            reorder_total,
            refund_status,
        } = req.body;
        let claim = await Claim.get(
            { _id: claimId },
            { status: 1, resolved_date: 1 }
        );
        if (!claim || claim.status !== CLAIM_STATUS.APPROVED)
            throwError(MSG.CLAIM_NOT_APPROVED);
        const { total_price, merchant } = await Services.Order.get(
            { _id: orderId },
            { total_price: 1, merchant: 1, name: 1 }
        );
        const merchantInfo = await Services.Merchant.get({ _id: merchant });
        if (!merchantInfo) return res.send({ message: MSG.MERCHANT_NOT_EXIST });
        if (Number(total_price) < Number(claim_total))
            throwError(MSG.TOTAL_CLAIM_AMOUNT_ERROR);

        let updateObj = {
            claim_total,
            refund_status,
            status: CLAIM_STATUS.RESOLVED,
        };
        if (!claim.resolved_date) updateObj["resolved_date"] = new Date();
        //if (refund_status) {
        updateObj["refund_total"] = refund_total;
        updateObj["refund_count"] = refund_count;
        //} else {
        updateObj["reorder_count"] = reorder_count;
        updateObj["reorder_total"] = reorder_total;
        updateObj["reorder_id"] = reorder_id;
        //}
        const description = replaceMulti(MSG.APP_CREDIT_MESSAGE, {
            "[CLAIM_ID]": claimId,
            "[ORDER_ID]": orderId,
            "[TYPE]": refund_status,
            "[AMOUNT]": claim_total,
        });
        if (merchantInfo.is_billing) {
            if (merchantInfo.billing_type == "shopify") {
                await Services.Billing.appCreditCreate(
                    merchantInfo.shop_id,
                    claim_total,
                    description
                );
            }
            await Services.UsageRecord.insert({
                merchant,
                order: orderId,
                amount: claim_total,
                type: "credit",
                claim: claimId,
                credit_type: refund_status ? refund_status : "refund",
            });
        }
        const data = await Claim.findOneAndUpdate(
            { _id: claimId },
            { $set: updateObj }
        );
        return res.send({ message: MSG.CLAIM_UPDATE, data });
    } catch (error) {
        return next(error);
    }
};

const OrderSearch = async (req, res, next) => {
    try {
        const result = await Claim.SearchOrder(req);
        res.send(result);
    } catch (error) {
        return next(error);
    }
};

const CreateClaim = async (req, res, next) => {
    try {
        req.body.created_by = req.user._id;
        req.body.created_role = req.user.role;
        const response = await Claim.CreateClaim(req.body);
        return res.send(response);
    } catch (error) {
        return next(error);
    }
};

const ClaimLists = async (req, res, next) => {
  try {
    let { merchant, start_date, end_date, search, status } = req.body;
    let mainCondition = [];
    let dateCondition = { date: {} };
    let regexCondition = {};

    if (merchant) {
      mainCondition.push({ merchant: ObjectId(merchant) });
    }
    if (status && Array.isArray(status) && status.length > 0) {
      mainCondition.push({
        status: { $in: status.map((s) => s.toUpperCase()) },
      });
    }

    if (start_date && end_date) {
      dateCondition.date.$gte = Moment(start_date).format("MM-DD-YYYY");
      dateCondition.date.$lte = Moment(end_date).format("MM-DD-YYYY");
    }

    if (search) {
      regexCondition = {
        $or: [
          { order_name: { $regex: search, $options: "i" } },
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

    pipeline.push({
      $addFields: {
        date: { $dateToString: { format: "%m-%d-%Y", date: "$createdAt" } },
        time: { $dateToString: { format: "%b %d, %Y, %H:%M", date: "$createdAt" } },
      },
    });

    if (dateCondition) {
      pipeline.push({
        $match: empty(dateCondition.date) ? {} : dateCondition,
      });
    }

    pipeline.push({
      $project: {
        _id: 1,
        order_id: "$order.name",
        merchant_id: "$merchant._id",
        merchant_name: "$merchant.name",
        customer_email: "$order.customer.email",
        customer_name: "$order.customer.name",
        createdAt: "$time",
        status: 1,
        sub_status: 1,
        previous_status: 1,
        refund_status: {
          $cond: {
            if: { $eq: ["$refund_count", 1] },
            then: "refund",
            else: {
              $cond: {
                if: { $eq: ["$reorder_count", 1] },
                then: "reorder",
                else: {
                  $cond: {
                    if: { $eq: ["$status", "CLOSED"] },
                    then: "closed",
                    else: "processing",
                  },
                },
              },
            },
          },
        },
      },
    });

    // Pagination
    const limit = parseInt(req.query.limit) || 25;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;

    // ----------- QUERY 1: COUNT -----------
    const countPipeline = [...pipeline, { $count: "totalRecords" }];
    const countResult = await Claim.aggregate(countPipeline);
    const totalRecords =
      countResult.length > 0 ? countResult[0].totalRecords : 0;

    // ----------- QUERY 2: DATA (Paginated) -----------
    const dataPipeline = [
      ...pipeline,
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];
    const response = await Claim.aggregate(dataPipeline);

    return res.send({
      message: response.length ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
      data: {
        totalRecords,
        response,
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
    ClaimDetails
);
router.post("/list", Auth.check, ClaimLists);
router.post("/event/add", Auth.check, AddClaimEvent);
router.post(
    "/search/order",
    Func.validate(AdminRules.SearchOrder),
    Auth.check,
    OrderSearch
);
router.post(
    "/new/claims",
    Auth.check,
    Func.validate(AdminRules.NewClaim),
    CreateClaim
);
router.post(
    "/approve-or-reject/:id",
    Func.validate(AdminRules.ParamsId),
    Auth.check,
    ClaimApproveOrReject
);
router.put("/approved", Auth.check, ClaimReorderOrRefund);
router.get("/comment/:claim", Auth.check, ListComment);
router.post("/comment", Auth.check, AddComment);

module.exports = router;

