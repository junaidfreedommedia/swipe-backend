const express = require("express");
const router = express.Router();
const ShippingNotification = Services.ShippingNotification;

const upsertShipping = async (req, res, next) => {
    try {
        const shippingInfo = await ShippingNotification.upsertList(req.params.id, req.body);
        res.send(shippingInfo);
    } catch (error) {
        return next(error);
    }
};

const shippingList = async (req, res, next) => {
    try {
        const shippingInfo = await ShippingNotification.list(req.params.id);
        res.send(shippingInfo);
    } catch (error) {
        return next(error);
    }
};

router.post("/upsert/:id", Auth.check, upsertShipping);
router.get("/list/:id", Auth.check, shippingList);

module.exports = router;
