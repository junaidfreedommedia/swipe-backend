const getStripe = require('./merchantBillingStripe');

module.exports = function merchantBillingWebhook(deps = {}) {
    return async (req, res) => {
        const secret = deps.secret || process.env.STRIPE_MERCHANT_BILLING_WEBHOOK_SECRET;
        if (!secret) return res.status(503).send({ message: 'Merchant billing webhook is not configured.' });
        let event;
        try {
            const stripe = deps.stripe || getStripe();
            event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
        } catch (_error) {
            return res.status(400).send({ message: 'Invalid Stripe webhook signature.' });
        }
        try {
            await (deps.service || global.Services.MerchantBilling).webhook(event);
            return res.send({ received: true });
        } catch (error) {
            (deps.logger || global.Logger || console).error(`Merchant billing webhook ${event.id}: ${error.message}`);
            return res.status(503).send({ message: 'Billing event will be retried.' });
        }
    };
};
