const express = require("express");
const router = express.Router();
const Billing = Services.Billing;

const SendBilling = async (req, res, next) => {
    try {
        const response = await Billing.sendBillingRequest(req.body.shop_id);
        return res.send(response);
    } catch (error) {
        console.log(error);
        next(error);
    }
};

const MerchantBillingControl = async (req, res, next) => {
    try {
        const payload = {};

        if (Object.prototype.hasOwnProperty.call(req.body, "billing_type")) {
            payload.billing_type = String(req.body.billing_type || "")
                .trim()
                .toLowerCase();
        }

        if (Object.prototype.hasOwnProperty.call(req.body, "competition")) {
            payload.competition = req.body.competition;
        }

        if (Object.prototype.hasOwnProperty.call(req.body, "is_billing")) {
            if (typeof req.body.is_billing !== "boolean") {
                throwError("is_billing must be a boolean");
            }
            payload.is_billing = req.body.is_billing;
        }

        if (empty(payload)) {
            throwError("Invalid billing payload");
        }

        await Services.Merchant.updateOne(
            { _id: req.params.id },
            { $set: payload }
        );

        const response = await Services.Merchant.get({ _id: req.params.id });
        return res.send({
            message: MSG.DATA_UPDATED,
            data: response,
        });
    } catch (error) {
        console.log(error);
        next(error);
    }
};

router.post(
    "/send-billing",
    Func.validate(AdminRules.SendBilling),
    Auth.check,
    SendBilling
);
router.post("/merchant-billing/:id", Auth.check, MerchantBillingControl);

module.exports = router;
