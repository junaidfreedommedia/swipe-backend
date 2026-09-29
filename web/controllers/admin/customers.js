const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();
const Auth = global.Auth || require("../../middleware/auth");

const normalizeEmail = (email = "") =>
  Services.Customer.normalizeEmail(email);

const escapeRegex = (value = "") =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildCustomerList = async ({ page, limit, search, merchantId }) => {
  const skip = (page - 1) * limit;
  const customerMatch = {
    email: { $exists: true, $ne: null, $ne: "" },
  };
  const orderBackfillMatch = {};

  if (search?.trim()) {
    const searchRegex = new RegExp(search.trim(), "i");
    customerMatch.email = {
      $regex: searchRegex,
    };
    orderBackfillMatch["customer.email"] = {
      $regex: new RegExp(search.trim(), "i"),
    };
  }

  if (merchantId && mongoose.Types.ObjectId.isValid(merchantId)) {
    const objectId = new mongoose.Types.ObjectId(merchantId);
    customerMatch.merchant = objectId;
    orderBackfillMatch.merchant = objectId;
  }

  await Services.Customer.backfillFromOrders(orderBackfillMatch);

  const [customers, countResult] = await Promise.all([
    Models.Customer.aggregate([
      { $match: customerMatch },
      { $sort: { updatedAt: -1 } },
      {
        $group: {
          _id: "$email",
          customerRecordId: { $first: "$_id" },
          firstName: { $first: "$firstName" },
          lastName: { $first: "$lastName" },
          phone: { $first: "$phone" },
          currency: { $first: "$currency" },
          billing_address: { $first: "$billing_address" },
          customer_created_at: { $min: "$customer_created_at" },
          stores: { $addToSet: "$merchant" },
        },
      },
      { $sort: { customer_created_at: -1, _id: 1 } },
      { $skip: skip },
      { $limit: limit },
    ]),
    Models.Customer.aggregate([
      { $match: customerMatch },
      { $group: { _id: "$email" } },
      { $count: "total" },
    ]),
  ]);

  return {
    data: customers.map((item) => ({
        _id: item.customerRecordId,
        email: item._id,
        customer: {
          email: item._id,
          first_name: item.firstName || "",
          last_name: item.lastName || "",
          phone: item.phone || "",
          currency: item.currency || "",
        },
        billing_address: item.billing_address || null,
        createdAt: item.customer_created_at || null,
        totalStores: item.stores?.length || 0,
      })),
    total: countResult[0]?.total || 0,
  };
};

const ListCustomers = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 25, 1);
    const { search = "", merchantId = "" } = req.query;

    const response = await buildCustomerList({
      page,
      limit,
      search,
      merchantId,
    });

    return res.send({
      success: true,
      data: response.data,
      pagination: {
        total: response.total,
        page,
        limit,
        pages: Math.ceil(response.total / limit),
      },
      message: MSG.DATA_FOUND,
    });
  } catch (error) {
    return next(error);
  }
};

const CustomerProfile = async (req, res, next) => {
  try {
    const email = normalizeEmail(req.params.email);
    const emailRegex = new RegExp(`^${escapeRegex(email)}$`, "i");
    const orderPage = Math.max(parseInt(req.query.orderPage, 10) || 1, 1);
    const claimPage = Math.max(parseInt(req.query.claimPage, 10) || 1, 1);
    const orderLimit = Math.max(parseInt(req.query.orderLimit, 10) || 25, 1);
    const claimLimit = Math.max(parseInt(req.query.claimLimit, 10) || 25, 1);
    const status = req.query.status;

    if (!email) {
      throwError(MSG.INVALID_EMAIL);
    }

    await Services.Customer.backfillFromOrders({
      "customer.email": emailRegex,
    });

    const customerProfiles = await Services.Customer.getAll(
      { email },
      null,
      { lean: true, sort: { updatedAt: -1 } }
    );

    if (!customerProfiles.length) {
      throwError(MSG.CUSTOMER_NOT_FOUND);
    }

    const merchantIds = [
      ...new Set(customerProfiles.map((item) => String(item.merchant))),
    ];

    const merchants = await Services.Merchant.getAll(
      { _id: { $in: merchantIds } },
      { _id: 1, name: 1 },
      { lean: true }
    );
    const merchantMap = new Map(
      merchants.map((merchant) => [String(merchant._id), merchant.name])
    );

    const pickFirst = (...values) =>
      values.find((value) => {
        if (value === null || value === undefined) return false;
        if (typeof value === "string") return value.trim().length > 0;
        if (typeof value === "object") return Object.keys(value).length > 0;
        return true;
      }) || null;

    const profile = {
      email,
      first_name: pickFirst(...customerProfiles.map((item) => item.firstName)),
      last_name: pickFirst(...customerProfiles.map((item) => item.lastName)),
      phone: pickFirst(...customerProfiles.map((item) => item.phone)),
      billing_address: pickFirst(
        ...customerProfiles.map((item) => item.billing_address)
      ),
      customer_created_at: customerProfiles.reduce((acc, item) => {
        const current = item.customer_created_at || item.createdAt;
        if (!current) return acc;
        if (!acc) return current;
        return new Date(current) < new Date(acc) ? current : acc;
      }, null),
      stores: customerProfiles.map((item) => ({
        merchantId: item.merchant,
        merchantName: merchantMap.get(String(item.merchant)) || "-",
      })),
    };

    const ordersMatch = { "customer.email": emailRegex };
    const [orders, ordersTotal] = await Promise.all([
      Services.Order.aggregate([
        { $match: ordersMatch },
        { $sort: { createdAt: -1 } },
        { $skip: (orderPage - 1) * orderLimit },
        { $limit: orderLimit },
        {
          $project: {
            _id: 1,
            order_number: 1,
            email: "$customer.email",
            createdAt: 1,
            tracking_status: 1,
            tags: 1,
            merchant: 1,
            merchantName: 1,
            is_protected: 1,
          },
        },
      ]),
      Services.Order.count(ordersMatch),
    ]);

    const claimsMatch = {};
    if (status) claimsMatch.status = status;

    const claimsPipeline = [
      { $match: claimsMatch },
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
        $match: {
          "order.customer.email": emailRegex,
        },
      },
      { $sort: { createdAt: -1 } },
    ];

    const [claims, claimsTotalResult] = await Promise.all([
      Services.Claim.aggregate([
        ...claimsPipeline,
        { $skip: (claimPage - 1) * claimLimit },
        { $limit: claimLimit },
        {
          $project: {
            _id: 1,
            order_id: "$order.order_number",
            customer_email: "$order.customer.email",
            createdAt: 1,
            refund_status: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$refund_status", "REFUND"] },
                    { $eq: ["$refund_status", "refund"] },
                  ],
                },
                "refund",
                {
                  $cond: [
                    {
                      $or: [
                        { $eq: ["$refund_status", "REPLACE"] },
                        { $eq: ["$refund_status", "reorder"] },
                      ],
                    },
                    "reorder",
                    {
                      $cond: [
                        {
                          $or: [
                            { $eq: ["$refund_status", "BOTH"] },
                            { $eq: ["$refund_status", "reorder/refund"] },
                          ],
                        },
                        "reorder/refund",
                        { $toLower: "$refund_status" },
                      ],
                    },
                  ],
                },
              ],
            },
            status: 1,
            merchant_name: "$order.merchantName",
            merchant: "$order.merchant",
          },
        },
      ]),
      Services.Claim.aggregate([
        ...claimsPipeline,
        { $count: "total" },
      ]),
    ]);

    return res.send({
      success: true,
      message: MSG.DATA_FOUND,
      data: {
        profile,
        orders: {
          response: orders.map((order) => ({
            ...order,
            merchantName:
              order.merchantName ||
              merchantMap.get(String(order.merchant)) ||
              "-",
          })),
          totalRecords: ordersTotal,
          currentPage: orderPage,
        },
        claims: {
          response: claims.map((claim) => ({
            ...claim,
            merchant_name:
              claim.merchant_name ||
              merchantMap.get(String(claim.merchant)) ||
              "-",
          })),
          totalRecords: claimsTotalResult[0]?.total || 0,
          currentPage: claimPage,
        },
      },
    });
  } catch (error) {
    return next(error);
  }
};

router.get("/list", Auth.check, ListCustomers);
router.get("/profile/:email", Auth.check, CustomerProfile);

module.exports = router;
