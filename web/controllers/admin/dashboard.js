const express = require("express");
const router = express.Router();

const ActivityList = async (req, res, next) => {
    try {
        let merchantId = req.params.merchantId,
            condition = {};
        if (merchantId) condition = { merchant: merchantId };
        const eventList = await Services.Event.getAll(
            condition,
            { __v: 0, updatedAt: 0, content: 0 },
            { sort: { _id: -1 }, limit: 10, lean: true }
        );
        const claimList = await Services.Claim.getAll(
            condition,
            { __v: 0, updatedAt: 0 },
            { sort: { _id: -1 }, limit: 10, lean: true }
        );
        return res.send({
            events: eventList,
            claims: claimList,
            message: MSG.DATA_FOUND,
        });
    } catch (error) {
        return next(error);
    }
};

const AllActivityList = async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 25;
        const skip = (page - 1) * limit;
        let merchantId = req.params.merchantId,
            condition = {};
        if (merchantId) condition = { merchant: merchantId };
        // Fetch event and claim lists in parallel
        const [eventList, claimList, totalEvents, totalClaims] =
            await Promise.all([
                Services.Event.getAll(
                    condition,
                    { __v: 0, updatedAt: 0, content: 0 },
                    { sort: { _id: -1 }, skip, limit, lean: true }
                ),
                Services.Claim.getAll(
                    condition,
                    { __v: 0, updatedAt: 0 },
                    { sort: { _id: -1 }, skip, limit, lean: true }
                ),
                Services.Event.count(condition),
                Services.Claim.count(condition),
            ]);
        return res.send({
            totalEvents,
            totalClaims,
            events: eventList,
            claims: claimList,
            message: MSG.DATA_FOUND,
        });
    } catch (error) {
        return next(error);
    }
};

const RevenueStatistic = async (req, res, next) => {
    try {
        const { start_date, end_date } = req.query;
        const merchantInfo = await Services.Merchant.get(
            { _id: req.params.id },
            { iana_timezone: 1 }
        );
        const response = await Services.UsageRecord.RevenueStatisticList(
            ObjectId(req.params.id),
            start_date,
            end_date,
            merchantInfo.iana_timezone
        );
        res.send(response);
    } catch (error) {
        return next(error);
    }
};

const Statistic = async (req, res, next) => {
    try {
        const { start_date, end_date } = req.query;
        const merchantInfo = await Services.Merchant.get(
            { _id: req.params.id },
            { iana_timezone: 1 }
        );
        const response = await Services.Claim.StatisticList({
            merchant_id: merchantInfo._id,
            start_date,
            end_date,
            timezone: merchantInfo.iana_timezone,
        });
        return res.send(response);
    } catch (error) {
        return next(error);
    }
};

const ProtectFromFraud = async (req, res, next) => {
    try {
        const merchantId = req.params.id;

        const claimCustomerCounts = await Services.Claim.aggregate([
            { $match: { merchant: ObjectId(merchantId) } },
            {
                $lookup: {
                    from: "orders",
                    localField: "order",
                    foreignField: "_id",
                    as: "order",
                },
            },
            { $unwind: "$order" },
            { $group: { _id: "$order.customer.email", count: { $sum: 1 } } },
            { $project: { email: "$_id", count: 1 } },
        ]);

        return res.send({
            claimCustomerCounts: claimCustomerCounts,
            message: MSG.DATA_FOUND,
        });
    } catch (error) {
        return next(error);
    }
};

const AccountManagerList = async (req, res, next) => {
    try {
        const accountManager = await Services.User.getAll({
            role: "account-manager",
        });
        return res.send({
            message: accountManager ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: accountManager,
        });
    } catch (error) {
        return next(error);
    }
};

const AccountManagerAssign = async (req, res, next) => {
    try {
        const { manager } = req.body;
        const accountManager = await Services.Merchant.findOneAndUpdate(
            { _id: req.params.id },
            {
                $set: { account_manager: ObjectId(manager) },
            },
            { new: true, upsert: true }
        );
        return res.send({
            message: MSG.DATA_UPDATED,
            data: accountManager,
        });
    } catch (error) {
        return next(error);
    }
};

const CustomerEmailCommunication = async (req, res, next) => {
    try {
        const {
            customer_email,
            customer_name,
            merchant_email,
            cc_email,
            subject,
            message,
        } = req.body;

        Func.emailValidation(customer_email);
        Func.emailValidation(merchant_email);
        if (Array.isArray(cc_email) && cc_email.length > 0) {
            cc_email.forEach((email) => {
                Func.emailValidation(email);
            });
        }
        await Notifications.sendNotification({
            subject: subject,
            to: [customer_email],
            template: "CUSTOMER_EMAIL_COMMUNICATION",
            message: message,
            customer_name: customer_name,
            email: customer_email,
            cc: cc_email,
        });
        return res.send({
            message: MSG.EMAIL_SENT_SUCCESSFULLY,
        });
    } catch (error) {
        return next(error);
    }
};

router.get("/activity/:merchantId?", Auth.check, ActivityList);
router.get("/all-activity/:merchantId?", Auth.check, AllActivityList);
router.get("/statistic/revenue/:id", Auth.check, RevenueStatistic);
router.get("/claim/statistic/:id", Auth.check, Statistic);
router.get("/claim/protect/:id", Auth.check, ProtectFromFraud);
router.get("/account-manager/list", Auth.check, AccountManagerList);
router.post("/account-manager/assign/:id", Auth.check, AccountManagerAssign);
router.post(
    "/email-send",
    Func.validate(AdminRules.CustomerEmailCommunication),
    Auth.check,
    CustomerEmailCommunication
);

module.exports = router;
