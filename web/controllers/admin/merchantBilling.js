const express = require('express');
const router = express.Router();
router.use(Auth.check, Auth.requireSuperAdmin);
const handle = action => async (req, res, next) => {
    try { res.send({ data: await action(req), message: 'Billing updated.' }); }
    catch (error) { next(error); }
};
router.get('/:id', handle(req => Services.MerchantBilling.get(req.params.id)));
router.put('/:id', handle(req => Services.MerchantBilling.save(req.params.id, req.body, req.user._id)));
router.post('/:id/setup-link', handle(req => Services.MerchantBilling.setup(req.params.id, req.user._id)));
router.get('/:id/shopify-status', handle(req => Services.MerchantBilling.shopifyStatus(req.params.id)));
router.post('/:id/shopify-approval', handle(req => Services.MerchantBilling.shopifyApproval(req.params.id, req.user._id)));
router.post('/:id/preview', handle(req => Services.MerchantBilling.preview(req.params.id, req.body.period)));
router.post('/:id/bill', handle(req => Services.MerchantBilling.bill(req.params.id, req.body.period, req.body, req.user._id)));
router.post('/:id/record-payment', handle(req => Services.MerchantBilling.recordPayment(req.params.id, req.body.period, req.body, req.user._id)));
router.post('/:id/refresh', handle(req => Services.MerchantBilling.refresh(req.params.id, req.body.period)));
router.post('/:id/resume', handle(req => Services.MerchantBilling.resume(req.params.id, req.body.period, req.user._id)));
module.exports = router;
