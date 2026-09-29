const express = require("express");
const router = express.Router();
const Order = Services.Order;
const shopify = require("./../../shopify");
const axiosService = require("./../../utils/axios");
const { getTrackingStatus } = require("./../../utils/easypost");
const { GetFinalPrice } = require("./../../utils/functions");
const { enrichOrderLineItemsFromShopify } = require("./../../utils/shopifyLineItems");
const { ObjectId } = require("mongodb");
const { normalizeTimezone } = require("../../utils/merchantTimezone");
const { buildOrderPriceSummary } = require("../../utils/orderPriceSummary");

const List = async (req, res, next) => {
    try {
        const response = await Order.OrderList(req);
        res.send(response);
    } catch (error) {
        return next(error);
    }
};

const orderDetails = async (req, res, next) => {
  try {
    const merchantId = req.merchant._id; 
    const orderId = req.params.id; 

    const orderFilter = { _id: orderId, merchant: merchantId };
    const orderDetail = await Order.get(orderFilter); 

    if (!orderDetail) {
    //     console.warn(`SECURITY DENY: Attempt to access unauthorized order ${orderId} by Merchant ${merchantId}`);
    //   return res.status(403).json({ message: "Unauthorized access or Invalid Order ID." });
      throw new Error("Order not found or access denied.");
    }

    const merchant = await Services.Merchant.get({ _id: orderDetail.merchant });
    const priceInfo = await GetFinalPrice(orderDetail._id);
    let responseData = JSON.parse(JSON.stringify(priceInfo.response));
    responseData.merchant_name = merchant?.name;
    responseData.iana_timezone = normalizeTimezone(merchant?.iana_timezone);

    // Pricing is sourced from the local order document. Shopify webhooks own
    // synchronization; a page read must not silently swap in live amounts.
    responseData.line_items = await enrichOrderLineItemsFromShopify(
      responseData,
      merchant?.shop_id
    );

    const priceSummary = buildOrderPriceSummary(orderDetail, responseData);
    responseData.price_summary = priceSummary;

    responseData.subtotal = priceSummary.subtotal_amount;
    responseData.total_discounts = priceSummary.discount_amount;
    responseData.total_tax = priceSummary.tax_amount;
    responseData.shipping_price = priceSummary.shipping_amount;
    responseData.display_total = priceSummary.total_amount;
    responseData.refunded = priceSummary.refunded_amount;
    responseData.net_price_after_refund = priceSummary.total_amount;
    responseData.paid = priceSummary.paid_amount;
    responseData.net_payment = priceSummary.net_payment;
    responseData.balance = orderDetail.authorization?.total
      ? parseFloat(orderDetail.authorization.total) - priceSummary.paid_amount
      : 0;

    const trackingDetails = await getTrackingStatus(orderDetail);

    const { status, startDate, endDate, sort, order } = req.query;
    let condition = { merchant: merchantId };
    if (status) condition.status = status;
    if (startDate && endDate) condition.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };

    const sortField = sort || "createdAt";
    const sortOrder = parseInt(order, 10) === 1 ? 1 : -1;

    const [prevOrder, nextOrder] = await Promise.all([
      Order.get(
        { ...condition, [sortField]: { [sortOrder === 1 ? "$lt" : "$gt"]: orderDetail[sortField] } },
        null,
        { sort: { [sortField]: sortOrder === 1 ? -1 : 1 }, limit: 1 }
      ),
      Order.get(
        { ...condition, [sortField]: { [sortOrder === 1 ? "$gt" : "$lt"]: orderDetail[sortField] } },
        null,
        { sort: { [sortField]: sortOrder === 1 ? 1 : -1 }, limit: 1 }
      ),
    ]);

    responseData.previous_order = prevOrder
      ? {
          id: prevOrder._id,
          order_number: prevOrder.order_number,
          total_price: prevOrder.total_price,
          customer_name: prevOrder.customer?.name,
          customer_email: prevOrder.customer?.email,
          tracking_status: prevOrder.tracking_status,
          created_at: prevOrder.createdAt,
        }
      : null;

    responseData.next_order = nextOrder
      ? {
          id: nextOrder._id,
          order_number: nextOrder.order_number,
          total_price: nextOrder.total_price,
          customer_name: nextOrder.customer?.name,
          customer_email: nextOrder.customer?.email,
          tracking_status: nextOrder.tracking_status,
          created_at: nextOrder.createdAt,
        }
      : null;

    const events = await Services.Event.getAll(
      { order: req.params.id },
      { _id: 1, ts: 1, type: 1, sub_type: 1, who: 1, content: 1, title: 1, action_on: 1, createdAt: 1 },
      { sort: { createdAt: -1 } }
    );
    responseData.events = events;

    responseData.comments = Array.isArray(responseData.comments) ? responseData.comments : [];
    responseData.internal_comments = Array.isArray(responseData.internal_comments) ? responseData.internal_comments : [];

    return res.json({ message: MSG.DATA_FOUND, data: responseData, trackingDetails });
  } catch (err) {
    next(err);
  }
};





const CsvExport = async (req, res, next) => {
    try {
        let { start_date, end_date, is_protected, search, tracking_status } =
            req.query;

        let mainCondition = [];
        let regexCondition = {};
        let timezone;

        if (req.merchant) {
            timezone = req.merchant.iana_timezone;
            mainCondition.push({ merchant: req.merchant._id });
        }
        if (is_protected) {
            mainCondition.push({ is_protected: Boolean(is_protected) });
        }
        if (tracking_status) {
            mainCondition.push({ tracking_status: tracking_status });
        }

        let pipeline = [];
        pipeline.push({
            $addFields: {
                order_number_str: { $toString: "$order_number" },
            },
        });
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
            const startDate = Moment.tz(start_date, "MM-DD-YYYY", timezone)
                .startOf("day")
                .toDate();
            const endDate = Moment.tz(end_date, "MM-DD-YYYY", timezone)
                .endOf("day")
                .toDate();
            pipeline.push({
                $match: {
                    createdAt: {
                        $gte: startDate,
                        $lte: endDate,
                    },
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

        const DIRECT_EXPORT_LIMIT = 10000;
        if (recordCount <= DIRECT_EXPORT_LIMIT) {
            // If records are <= 10,000, stream CSV directly to the response
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
            const orders = await Services.Order.aggregate(pipeline);

            const filename = "order.csv";
            res.setHeader("Content-Type", "text/csv");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename=${filename}`
            );

            const csvStream = FastCsv.format({ headers: true });
            csvStream.pipe(res);

            orders.forEach((order) => {
                csvStream.write({
                    order_number: order.order_number,
                    customer_name: order.customer_name,
                    total_price: order.total_price,
                    merchant: order.merchant,
                    createdAt: Moment(order.createdAt)
                        .tz(timezone)
                        .format("MM-DD-YYYY"),
                    email: order.email,
                    phone_number: order.phone_number,
                    store_name: order.store_name,
                });
            });

            csvStream.end();
        } else {
            // For larger exports, process in the background and send email notification
            const merchant = req.merchant;
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
    let timezone;

    if (merchant) {
        timezone = merchant.iana_timezone;
        mainCondition.push({ merchant: merchant._id });
    }
    if (is_protected) {
        mainCondition.push({ is_protected: Boolean(is_protected) });
    }
    if (tracking_status) {
        mainCondition.push({ tracking_status: tracking_status });
    }

    let pipeline = [];
    pipeline.push({
        $addFields: {
            order_number_str: { $toString: "$order_number" },
        },
    });
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
        const startDate = Moment.tz(start_date, "MM-DD-YYYY", timezone)
            .startOf("day")
            .toDate();
        const endDate = Moment.tz(end_date, "MM-DD-YYYY", timezone)
            .endOf("day")
            .toDate();
        pipeline.push({
            $match: {
                createdAt: {
                    $gte: startDate,
                    $lte: endDate,
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
        // { $limit: 50000 }, // Max record limit before background job
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

    allOrders.forEach((order) => {
        csvStream.write({
            order_number: order.order_number,
            customer_name: order.customer_name,
            total_price: order.total_price,
            merchant: order.merchant,
            createdAt: Moment(order.createdAt)
                .tz(timezone)
                .format("MM-DD-YYYY"),
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

const getDownload = async (req, res, next) => {
    const { filename } = req.params;
    const filePath = Path.join(__dirname, "../../export", filename);
    console.log("filepath", filePath); // Make sure to point to the correct directory

    // Check if the file exists
    if (Fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        return res.status(404).send("File not found.");
    }
};

const productList = async (req, res, next) => {
    try {
        const merchant = req.merchant._id;
        const { orderId } = req.body;

        const response = await Order.ProductList({ orderId, merchant });
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

const ListComment = async (req, res, next) => {
    try {
        const result = await Services.Event.getAllOrderComment(req, [
            EVENT_TYPE.COMMENT,
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

router.get("/list", Auth.check, List);
router.get("/export", Auth.check, CsvExport);
router.get("/:id", Auth.check, orderDetails);
router.post("/product-list", Auth.check, productList);
router.get("/comment/:order", Auth.check, ListComment);
router.post("/comment", Auth.check, AddComment);
router.put("/update-tags", Auth.check, UpdateOrderTags);

module.exports = router;
