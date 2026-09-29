const express = require("express");
const moment = require("moment-timezone");
const router = express.Router();
const Claim = Services.Claim;
const Event = Services.Event;

const parseClaimDateRange = (startDate, endDate, timezone) => {
  const formats = ["M-D-YYYY", "M-DD-YYYY", "MM-D-YYYY", "MM-DD-YYYY", "YYYY-MM-DD"];
  const dateCondition = {};

  if (startDate) {
    const parsedStart = Moment.tz(startDate, formats, true, timezone);
    if (parsedStart.isValid()) {
      dateCondition.$gte = parsedStart.startOf("day").toDate();
    }
  }

  if (endDate) {
    const parsedEnd = Moment.tz(endDate, formats, true, timezone);
    if (parsedEnd.isValid()) {
      dateCondition.$lte = parsedEnd.endOf("day").toDate();
    }
  }

  return dateCondition;
};

const List = async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const { start_date, end_date, search } = req.query;
    const { status } = req.body;
    const limit = parseInt(req.query.limit) || 25;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;

    let mainCondition = [];
    let timezone = req.merchant?.iana_timezone || "America/Chicago";

    if (req.merchant) {
      mainCondition.push({ merchant: ObjectId(req.merchant._id) });
    }

    const dateCondition = parseClaimDateRange(start_date, end_date, timezone);
    const submittedDateMatch =
      Object.keys(dateCondition).length > 0 ? { createdAt: dateCondition } : null;
    const resolvedDateMatch =
      Object.keys(dateCondition).length > 0 ? { resolved_date: dateCondition } : null;
    const deniedDateMatch =
      Object.keys(dateCondition).length > 0 ? { updatedAt: dateCondition } : null;

    if (status && Array.isArray(status) && status.length > 0) {
      mainCondition.push({
        status: { $in: status.map((s) => s.toUpperCase()) },
      });
    }

    let pipeline = [];

    if (mainCondition.length > 0) {
      pipeline.push({ $match: { $and: mainCondition } });
    }

    pipeline.push(
      {
        $lookup: {
          from: "orders",
          localField: "order",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                name: 1,
                refund_amount: 1,
                reorder_amount: 1,
                refund_shipping_total: 1,
                reorder_shipping_total: 1,
                "customer.email": 1,
                "customer.name": 1,
              },
            },
          ],
          as: "orders",
        },
      },
      { $unwind: { path: "$orders", preserveNullAndEmptyArrays: true } }
    );

    // Ye step aapki price logic ko maintain karta hai
    pipeline.push({
      $addFields: {
        total_val: { $convert: { input: "$swipe_by_refunded", to: "double", onError: 0, onNull: 0 } },
        ref_raw: { $convert: { input: "$refund_total", to: "double", onError: 0, onNull: 0 } },
        reo_raw: { $convert: { input: "$reorder_total", to: "double", onError: 0, onNull: 0 } }
      }
    });

    pipeline.push({
      $addFields: {
        refund_total_numeric: {
          $cond: [
            { $gt: [{ $add: ["$ref_raw", "$reo_raw"] }, 0] },
            { $multiply: ["$total_val", { $divide: ["$ref_raw", { $add: ["$ref_raw", "$reo_raw"] }] }] },
            { $cond: [{ $in: ["$refund_status", ["REFUND", "refund"]] }, "$total_val", 0] }
          ]
        },
        reorder_total_numeric: {
          $cond: [
            { $gt: [{ $add: ["$ref_raw", "$reo_raw"] }, 0] },
            { $multiply: ["$total_val", { $divide: ["$reo_raw", { $add: ["$ref_raw", "$reo_raw"] }] }] },
            { $cond: [{ $in: ["$refund_status", ["REPLACE", "reorder"]] }, "$total_val", 0] }
          ]
        }
      }
    });

    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { order_name: { $regex: search, $options: "i" } },
            { "orders.customer.email": { $regex: search, $options: "i" } },
            { "orders.customer.name": { $regex: search, $options: "i" } },
          ],
        },
      });
    }

    // Same period filter shared by metadata + stats so that
    // submitted/approved/denied counts stay consistent in the report.
    const periodMatch = (resolvedDateMatch || deniedDateMatch)
      ? {
          $match: {
            $or: [
              {
                $or: [
                  { refund_total_numeric: { $gt: 0 } },
                  { reorder_total_numeric: { $gt: 0 } }
                ],
                ...(resolvedDateMatch || {}),
              },
              {
                status: "CLOSED",
                ...(deniedDateMatch || {}),
              },
            ],
          },
        }
      : null;

    pipeline.push({
      $facet: {
        metadata: [
          ...(periodMatch ? [periodMatch] : (submittedDateMatch ? [{ $match: submittedDateMatch }] : [])),
          { $count: "totalRecords" },
        ],
        stats: [
          ...(periodMatch ? [periodMatch] : []),
          {
            $group: {
              _id: null,
              totalRefundValue: {
                $sum: {
                  $cond: [
                    { 
                      $and: [
                        { $gt: ["$refund_total_numeric", 0] },
                        { $in: ["$status", ["RESOLVED", "APPROVED"]] }
                      ]
                    },
                    "$refund_total_numeric",
                    0,
                  ],
                },
              },
              totalReorderValue: {
                $sum: {
                  $cond: [
                    { 
                      $and: [
                        { $gt: ["$reorder_total_numeric", 0] },
                        { $in: ["$status", ["RESOLVED", "APPROVED"]] }
                      ]
                    },
                    "$reorder_total_numeric",
                    0,
                  ],
                },
              },
              approvedClaims: {
                $sum: {
                  $cond: [
                    { $in: ["$status", ["RESOLVED", "APPROVED"]] },
                    1,
                    0
                  ]
                },
              },
              deniedClaims: {
                $sum: { $cond: [{ $eq: ["$status", "CLOSED"] }, 1, 0] },
              },
            },
          },
          {
            // Yahan dono ka TOTAL calculate ho raha hai
            $addFields: {
              swipeRefundTotal: { $add: ["$totalRefundValue", "$totalReorderValue"] }
            }
          }
        ],
        claimList: [
          ...(submittedDateMatch ? [{ $match: submittedDateMatch }] : []),
          {
            $project: {
              orderId: "$orders.name",
              "orders.customer.email": 1,
              createdAt: 1,
              status: 1,
              refund_status: {
                $switch: {
                  branches: [
                    { case: { $in: ["$refund_status", ["REFUND", "refund"]] }, then: "refund" },
                    { case: { $in: ["$refund_status", ["REPLACE", "reorder"]] }, then: "reorder" }
                  ],
                  default: { $cond: [{ $eq: ["$status", "RESOLVED"] }, "processed", "pending"] }
                }
              },
            },
          },
          { $sort: { createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
        ],
      },
    });

    const [result] = await Claim.aggregate(pipeline);

    const totalRecords = result.metadata[0]?.totalRecords || 0;
    const claimStats = result.stats[0] || {
      totalRefundValue: 0,
      totalReorderValue: 0,
      swipeRefundTotal: 0,
      approvedClaims: 0,
      deniedClaims: 0,
    };

    console.log(
      `[perf] POST /merchant/claims/list merchant=${req.merchant?._id || "unknown"} page=${page} limit=${limit} search=${search ? "yes" : "no"} statuses=${Array.isArray(status) ? status.length : 0} duration_ms=${Date.now() - startedAt} totalRecords=${totalRecords}`
    );

    return res.send({
      message: result.claimList.length ? "DATA_FOUND" : "DATA_NOT_FOUND",
      data: {
        totalRecords,
        totalRefundValue: Number(claimStats.totalRefundValue.toFixed(2)),
        totalReorderValue: Number(claimStats.totalReorderValue.toFixed(2)),
        swipeRefundTotal: Number(claimStats.swipeRefundTotal.toFixed(2)), // Ye apka Grand Total hai
        approvedClaims: claimStats.approvedClaims,
        deniedClaims: claimStats.deniedClaims,
        response: result.claimList,
      },
    });

  } catch (error) {
    console.log(
      `[perf] POST /merchant/claims/list failed merchant=${req.merchant?._id || "unknown"} duration_ms=${Date.now() - startedAt} error=${error?.message || error}`
    );
    return next(error);
  }
};

const Details = async (req, res, next) => {
    try {
        // Get the current claim details
        const response = await Claim.Details(req.params.id, req.user);
        
        // If claim exists, find previous and next claims
        if (response.Claims && Object.keys(response.Claims).length > 0) {
            const claimId = req.params.id;
            let merchantId;
            
            // Get merchant ID either from req.merchant or from the claim itself
            if (req.merchant && req.merchant._id) {
                merchantId = req.merchant._id;
            } else if (response.Claims.merchant && response.Claims.merchant._id) {
                merchantId = response.Claims.merchant._id;
            } else {
                // If no merchant ID available, we can't proceed with finding prev/next
                return res.send(response);
            }
            
            // Get all claims for this merchant sorted by creation date (newest first)
            const allClaims = await Claim.aggregate([
                { $match: { merchant: ObjectId(merchantId) } },
                { $sort: { createdAt: -1 } },
                { $project: { _id: 1 } }
            ]);
            
            // Find the current claim's index
            const currentIndex = allClaims.findIndex(c => c._id.toString() === claimId);
            
            // Set previous and next claim IDs
            if (currentIndex > 0) {
                response.Claims.previous_claim = {
                    id: allClaims[currentIndex - 1]._id
                };
            } else {
                response.Claims.previous_claim = null;
            }
            
            if (currentIndex < allClaims.length - 1) {
                response.Claims.next_claim = {
                    id: allClaims[currentIndex + 1]._id
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

const OrderSearch = async (req, res, next) => {
    try {
        req.body.merchant = req.merchant._id;
        const response = await Claim.SearchOrder(req);
        res.send(response);
    } catch (error) {
        return next(error);
    }
};

const LimitedClaimList = async (req, res, next) => {
    const startedAt = Date.now();
    try {
        const { start = 0, limit = 10 } = req.query;
        if (!req.merchant || !req.merchant._id) {
            throwError(MSG.INVALID_MERCHANT_ID);
        }
        const merchantId = ObjectId(req.merchant._id);
        const claimList = await Claim.aggregate([
            { $match: { merchant: merchantId } },
            { $sort: { createdAt: -1 } },
            { $skip: parseInt(start) },
            { $limit: parseInt(limit) },
        ]);
        console.log(
            `[perf] GET /merchant/claims/limitedlist merchant=${req.merchant?._id || "unknown"} start=${start} limit=${limit} duration_ms=${Date.now() - startedAt} returned=${claimList.length}`
        );
        return res.send({
            message: claimList.length ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: claimList,
        });
    } catch (error) {
        console.log(
            `[perf] GET /merchant/claims/limitedlist failed merchant=${req.merchant?._id || "unknown"} duration_ms=${Date.now() - startedAt} error=${error?.message || error}`
        );
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
            EVENT_TYPE.COMMENT
        ]);
        res.send(result);
    } catch (error) {
        next(error);
    }
};

router.get("/limitedlist", Auth.check, LimitedClaimList);
router.post("/list", Auth.check, Auth.checkPermission, List);
router.get("/:id", Auth.check, Auth.checkPermission, Details);
router.post(
    "/order",
    Auth.check,
    Auth.checkPermission,
    Func.validate(MerchantRules.SearchOrder),
    OrderSearch
);
router.get("/comment/:claim", Auth.check, ListComment);
router.post("/comment", Auth.check, AddComment);

module.exports = router;
