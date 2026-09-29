const express = require("express");
const router = express.Router();
const Billing = Services.Billing;

const SendBilling = async (req, res, next) => {
    try{
        const response = await Billing.sendBillingRequest(req.body.shop_id);
        return res.send(response);
    }catch(error){
        console.log(error);
        next(error);
    }
}

const checkBillingStatus = async (req, res, next) => {
    try{
        const session = await Services.ShopifySession.get({ shop: req.body.shop_id });
        if(!session) throwError(MSG.MERCHANT_NOT_EXIST);
        const response = await Billing.checkBillingStatus(session);
        return res.send({ billing: response });
    }catch(error){
        console.log(error);
        next(error);
    }
}

router.post('/send-billing', Func.validate(AdminRules.SendBilling), Auth.check, SendBilling);
router.post('/check-billing-status', Func.validate(AdminRules.SendBilling), Auth.check, checkBillingStatus);

module.exports = router;