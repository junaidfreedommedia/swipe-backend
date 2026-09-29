const express = require("express");
const Order = require("../../services/Order");
const router = express.Router();
const shopify = require("./../../shopify");
const axiosService = require("./../../utils/axios");
const { getTrackingStatus } = require("./../../utils/easypost");
const { GetFinalPrice } = require("./../../utils/functions");
const { assertSwipeProtectedOrder } = require("../../utils/claimEligibility");
const mongoose = require("mongoose");

const FindOrder = async (req, res, next) => {
  try {
    const { orderId, email } = req.body;
    Func.emailValidation(email);
    if (!orderId || !email) throw new Error("Please Provide Email and OrderId");

    const orderInfo = await Services.Order.get(
      { order_number: Number(orderId), "customer.email": email },
      { merchant: 1, customer: 1, is_protected: 1 }
    );
    if (!orderInfo) throw new Error(MSG.ORDER_NOT_FOUND);
    assertSwipeProtectedOrder(orderInfo);

    const merchantInfo = await Services.Merchant.get(
      { _id: orderInfo.merchant },
      { name: 1 }
    );
    if (!merchantInfo) throw new Error(MSG.DATA_NOT_FOUND);

    res.send({
      success: true,
      message: MSG.DATA_FOUND,
      data: {
        merchantId: merchantInfo._id,
        merchantName: merchantInfo.name,
        order_id: orderInfo._id,
        order_number: orderId,
        customer_name: orderInfo.customer.name,
        customer_email: email,
      },
    });
  } catch (err) {
    next(err);
  }
};


const OrderDetails = async (req, res, next) => {
  try {
    const { orderId, email } = req.body;
    const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailPattern.test(email)) throw new Error(MSG.INVALID_EMAIL);
    Func.orderValidation(orderId);

    const orderInfo = await Services.Order.get(
      { order_number: Number(orderId), "customer.email": email },
      {
        merchant: 1,
        customer: 1,
        line_items: 1,
        createdAt: 1,
        shipping_address: 1,
        fulfillments: 1,
        billing_address: 1,
        order_number: 1,
        tracking_status: 1,
        is_protected: 1,
      }
    );
    if (!orderInfo) throw new Error(MSG.ORDER_NOT_FOUND);
    assertSwipeProtectedOrder(orderInfo);
    const existing = await Services.Claim.get({ order: orderInfo._id });
    if (existing) throw new Error("Claim already created for this order.");
    const merchantInfo = await Services.Merchant.get(
      { _id: orderInfo.merchant },
      { shop_id: 1 }
    );
   const items = orderInfo.line_items.filter(
  li =>
    li.quantity > 0 &&
    ![PRODUCT_TITLE, "Swipe Package Protection"].includes(li.title)
);

     const productDetails = items.map(i => {
  const unitPrice = parseFloat(i.final_price || i.price || i.final_sale_price || 0);
  return {
    product_id: i.id,
    name: i.name,
    price: (unitPrice * i.quantity).toFixed(2),
    image_url: i.image_url,
    quantity: i.quantity
  };
});

    console.log(productDetails);
    
    
    res.send({
      success: true,
      message: MSG.DATA_FOUND,
      data: {
        orderId: orderInfo._id,
        orderNumber:orderInfo.order_number,
        orderStatus: orderInfo.tracking_status,
        orderDate: Moment(orderInfo.createdAt).format("DD-MMMM-YYYY"),
        customerEmail: orderInfo.customer.email,
        storeId: merchantInfo?.shop_id,
        customerPhoneNumber: orderInfo.customer.phone,
        billing_address: orderInfo.billing_address,
        productDetails,
      },
    });
  } catch (err) {
    next(err);
  }
};

const TrackOrderDetails = async (req, res, next) => {
  try {
    const { email, order_number, shop_id } = req.body;
    Func.emailValidation(email);

    const merchant = await Services.Merchant.get({ shop_id }, { _id: 1 });
    if (!merchant) throw new Error(MSG.INVALID_SHOP_ID);

    const orderDetails = await Services.Order.get(
      { "customer.email": email, order_number: Number(order_number), merchant: merchant._id },
      { line_items: 1, shipping_address: 1, fulfillments: 1 }
    );
    if (!orderDetails) throw new Error(MSG.DATA_NOT_FOUND);

    const items = orderDetails.line_items.filter(li => ![PRODUCT_TITLE, "Swipe Package Protection"].includes(li.title));
    const productDetails = items.map(i => ({
      product_id: i.id,
      name: i.name,
      price: i.final_price ?? i.price,
      image: i.image_url,
    }));

    const priceResp = await GetFinalPrice(orderDetails._id);
    const updatedDetails = priceResp.response;
    const trackingDetails = await getTrackingStatus(updatedDetails);

    res.send({
      success: true,
      message: MSG.DATA_FOUND,
      data: {
        productDetails,
        address: updatedDetails.shipping_address,
        tracking_url: updatedDetails.fulfillments[0]?.tracking_url,
        tracking_company: updatedDetails.fulfillments[0]?.tracking_company,
        tracking_number: updatedDetails.fulfillments[0]?.tracking_number,
        shipment_status: updatedDetails.fulfillments[0]?.shipment_status || null,
        trackingDetails,
        orderDetails: updatedDetails,
      },
    });
  } catch (err) {
    next(err);
  }
};

const GetAllCustomers = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 25, 1);
    const skip = (page - 1) * limit;
    const { search, merchantId } = req.query;

    const matchFilter = {};
    if (search?.trim()) {
      matchFilter["customer.email"] = { $regex: new RegExp(search.trim(), "i") };
    }
    if (merchantId && mongoose.Types.ObjectId.isValid(merchantId)) {
      matchFilter.merchant = new mongoose.Types.ObjectId(merchantId);
    }
    const matchStage = { $match: matchFilter };
    const projectStage = { $project: { customer: 1, createdAt: 1, merchantName: 1, billing_address: 1 } };
    const groupStage = {
      $group: {
        _id: "$customer.email",
        orderIdForNavigation: { $first: "$_id" },
        customer: { $first: "$customer" },
        billingAddress: { $first: "$billing_address" },
        createdAt: { $min: "$createdAt" },
        lastOrderDate: { $max: "$createdAt" },
        totalOrders: { $sum: 1 },
        billingAddress: { $first: "$billing_address" },
      }
    };
    const sortStage = { $sort: { createdAt: -1 } };
    const projectOut = {
      $project: {
        _id: "$orderIdForNavigation",
        email: "$_id",
        customer: 1,
        createdAt: 1,
        lastOrderDate: 1,
        totalOrders: 1,
        billing_address: "$billingAddress",
      }
    };
    const dataPipeline = [
      matchStage, projectStage, groupStage, sortStage,
      { $skip: skip }, { $limit: limit }, projectOut
    ];
    const countPipeline = [
      matchStage, projectStage, groupStage,
      { $count: "totalUniqueCustomers" }
    ];
    const [customers, countResult] = await Promise.all([
      global.Models.Order.aggregate(dataPipeline, { allowDiskUse: true }),
      global.Models.Order.aggregate(countPipeline)
    ]);
    const total = countResult[0]?.totalUniqueCustomers || 0;
    return res.json({
      success: true,
      data: customers,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      },
      message: "Customers fetched successfully"
    });
  } catch (err) {
    next(err);
  }
};


router.get("/get-all-customers", GetAllCustomers);
router.post("/find-order", Func.validate(V1Rules.FindOrder), FindOrder);
router.post("/order-details", OrderDetails);
router.post(
  "/track",
  Func.validate(V1Rules.TrackOrderDetails),
  TrackOrderDetails
);

module.exports = router;
