const shopify = require('./../shopify');
const { GraphqlQueryError } = require("@shopify/shopify-api");
const BILLING_CONFIG = Config.get('BILLING_CONFIG');
const PLAN = Object.keys(BILLING_CONFIG)[0];
const Billing = {};

const HAS_PAYMENTS_QUERY = `
query appSubscription {
    currentAppInstallation {
        activeSubscriptions {
            id
            name
            lineItems {
                id
                plan {
                    pricingDetails {
                        __typename
                        ... on AppUsagePricing {
                            terms
                            balanceUsed {
                                amount
                            }
                            cappedAmount {
                                amount
                            }
                        }
                    }
                }
            }
        }
    }
}`;

const CREATE_USAGE_RECORD = `
mutation appUsageRecordCreate($subscriptionLineItemId: ID!, $amount: Decimal!, $description: String!){
    appUsageRecordCreate(
        subscriptionLineItemId: $subscriptionLineItemId,
        description: $description,
        price: { amount: $amount, currencyCode: USD }
    ) {
        userErrors {
            field
            message
        }
        appUsageRecord {
            id
        }
    }
}`;

const createShopifyUsageCharge = async ({ session, amount, description }) => {
    const chargeAmount = Number(amount || 0);
    const chargeDescription = description || BILLING_CONFIG[PLAN].usageTerms;
    const client = new shopify.api.clients.Graphql({ session });
    const subscriptionLineItem = await getAppSubscription(session);

    if (!subscriptionLineItem?.id) {
        throwError(
            `Subscription line item ID is missing — cannot create usage record. ` +
            `getAppSubscription returned: ${JSON.stringify(subscriptionLineItem)}`
        );
    }

    const balanceUsed = Number(subscriptionLineItem.balanceUsed) || 0;
    const cappedAmount = Number(subscriptionLineItem.cappedAmount) || 0;
    const totalAmountUsed = balanceUsed + chargeAmount;

    if (totalAmountUsed > cappedAmount) {
        return {
            capacityReached: true,
            balanceUsed,
            cappedAmount,
        };
    }

    const response = await client.request(CREATE_USAGE_RECORD, {
        variables: {
            amount: chargeAmount,
            subscriptionLineItemId: subscriptionLineItem.id,
            description: chargeDescription,
        },
    });

    const userErrors = response?.data?.appUsageRecordCreate?.userErrors || [];
    if (userErrors.length) {
        throwError(userErrors.map((entry) => entry.message).join(", "));
    }

    return {
        capacityReached: false,
        usageChargeId: response?.data?.appUsageRecordCreate?.appUsageRecord?.id,
        balanceUsed: totalAmountUsed,
        cappedAmount: subscriptionLineItem.cappedAmount,
    };
};

async function getAppSubscription(session) {
    let errMsg = null;
    try {
        const BILLING_CONFIG = Config.get('BILLING_CONFIG');
        const client = new shopify.api.clients.Graphql({ session });
        let subscriptionLineItem = null;

        const planName = Object.keys(BILLING_CONFIG)[0];
        const planDescription = BILLING_CONFIG[planName].usageTerms;

        const response = await client.request(HAS_PAYMENTS_QUERY);
        const activeSubs = response?.data?.currentAppInstallation?.activeSubscriptions || [];

        if (!activeSubs.length) {
            throwError(
                `No active Shopify subscription found for shop "${session.shop}". ` +
                `Merchant must approve the billing request before charges can be created.`
            );
        }

        const availableSubs = activeSubs.map((s) => s.name).join(", ");

        for (let subscription of activeSubs) {
            if (subscription.name === planName) {
                for (let lineItem of subscription.lineItems) {
                    if (lineItem.plan.pricingDetails.terms === planDescription) {
                        subscriptionLineItem = {
                            id: lineItem.id,
                            balanceUsed: parseFloat(
                                lineItem.plan.pricingDetails.balanceUsed.amount
                            ),
                            cappedAmount: parseFloat(
                                lineItem.plan.pricingDetails.cappedAmount.amount
                            ),
                        };
                    }
                }
            }
        }

        if (!subscriptionLineItem) {
            throwError(
                `Active Shopify subscription does not match expected plan "${planName}" ` +
                `with usage terms "${planDescription}". Found subscriptions: [${availableSubs}]. ` +
                `Either the merchant approved an older plan version, or BILLING_CONFIG was changed after approval.`
            );
        }

        return subscriptionLineItem;
    } catch (error) {
        if (error instanceof GraphqlQueryError) {
            errMsg = new Error(
                `${error.message}\n${JSON.stringify(error.response, null, 2)}`
            );
        }
        throwError(errMsg || error);
    }
}

Billing.checkBillingStatus = async (session, options = {}) => {
    const { throwOnError = false } = options;
    try {
        const hasPayment = await shopify.api.billing.check({
            session,
            plans: PLAN,
            isTest: Config.get('IS_TEST_BILLING'),
        });
        console.log(
            `[Billing.checkBillingStatus] shop=${session?.shop} ` +
            `plan=${PLAN} isTest=${Config.get('IS_TEST_BILLING')} ` +
            `hasPayment=${hasPayment}`
        );
        return hasPayment;
    } catch (error) {
        console.error(
            `[Billing.checkBillingStatus] FAILED for shop=${session?.shop}: ` +
            `${error.message}`
        );
        console.error(error.stack);
        if (throwOnError) {
            throwError(
                `Failed to verify billing status: ${error.message}`
            );
        }
        return false;
    }
}

Billing.sendBillingRequest = async (shop_id) => {
    try {
        const session = await Services.ShopifySession.get({ shop: shop_id });
        if (!session) throwError(MSG.MERCHANT_NOT_EXIST);
        const plans = Object.keys(Config.get('BILLING_CONFIG'));
        const billingStatus = await Billing.checkBillingStatus(session);
        if (billingStatus) return { message: 'Billing Already Approved', alreadyApproved: true };
        const merchant = await Services.Merchant.get({ shop_id });
        const billingResponse = await shopify.api.billing.request({
            session: session,
            plan: plans[0],
            isTest: Config.get('IS_TEST_BILLING'),
        });
        if (!empty(billingResponse)) {
            await Notifications.sendNotification({
                subject: `Billing Approval Request From Swipe`,
                to: [merchant.customer_email],
                template: "BILLING_REQUEST",
                billing_approval_link: billingResponse,
                merchant_name: merchant.name
            });
        }
        return { url: billingResponse, message: `Shopify billing request has been sent on ${merchant.customer_email}` };
    } catch (error) {
        throwError(error);
    }
}

Billing.createUsageRecord = async (recordInfo) => {
    let {
        shop,
        amount,
        merchant,
        order,
        billing_type,
        record_date = new Date(),
        generated = 'default',
        adjustment_key,
        action_key,
        metadata,
        source_type = 'order_usage',
        charge_shopify_now = true,
        persist_ledger = true,
    } = recordInfo;
    let err, res = {
        capacityReached: false,
        createdRecord: false,
    };
    try {

        if (!merchant || !shop || !amount || !billing_type) return res;
        if (billing_type == 'shopify' && charge_shopify_now) {
            const session = await Services.ShopifySession.get({ shop });
            const hasPayment = await Billing.checkBillingStatus(session);
            if (!hasPayment) throwError(MSG.BILLING_NOT_APPROVED);
            const chargeResponse = await createShopifyUsageCharge({
                session,
                amount,
                description: metadata?.description,
            });
            if (chargeResponse.capacityReached) {
                return { ...res, capacityReached: true };
            }
            res.balanceUsed = chargeResponse.balanceUsed;
            res.usageChargeId = chargeResponse.usageChargeId;
        }
        res.createdRecord = true;
        // Guard: UsageRecord may not be available in all execution contexts (e.g. worker)
        if (persist_ledger && Services.UsageRecord?.insert) {
            const ledgerKey =
                adjustment_key ||
                (order ? `order-usage:${merchant}:${order}` : undefined);
            const ledgerResponse = await Services.UsageRecord.createLedgerEntry({
                merchant,
                order,
                amount,
                record_date,
                generated,
                type: 'usages',
                source_type,
                adjustment_key: ledgerKey,
                action_key,
                metadata,
            });
            if (ledgerResponse.duplicate) {
                res.createdRecord = false;
                res.duplicateRecord = true;
            }
        }
        return res;
    } catch (error) {
        if (error instanceof GraphqlQueryError) {
            err = new Error(`${error.message}\n${JSON.stringify(error.response, null, 2)}`);
        }
        throwError(err || error);
    }
}

Billing.createUsagesForMerchant = async (merchant) => {
    try {
        let merchantOrderDetails = await Services.Order.aggregate([
            { $match: { merchant: ObjectId(merchant), is_invoiced: false, is_claim_created: false } },
            {
                $addFields: {
                    "swipe": {
                        $filter: {
                            input: "$line_items",
                            as: "item",
                            cond: {
                                $or: [
                                    { $eq: ["$$item.title", PRODUCT_TITLE] },
                                    { $eq: ["$$item.title", 'Swipe Package Protection'] },
                                ],
                            }
                        }
                    }
                }
            },
            {
                $unwind: "$swipe"
            },
            {
                $lookup: {
                    from: "merchants",
                    localField: "merchant",
                    foreignField: "_id",
                    as: "merchant"
                }
            },
            {
                $unwind: "$merchant"
            },
            {
                $group: {
                    _id: "$merchant._id",
                    merchant_name: { $first: "$merchant.name" },
                    shop_id: { $first: "$merchant.shop_id" },
                    shop_owner: { $first: "$merchant.shop_owner" },
                    merchant_address1: { $first: "$merchant.address1" },
                    province_code: { $first: "$merchant.province_code" },
                    merchant_city: { $first: "$merchant.city" },
                    merchant_country: { $first: "$merchant.country" },
                    merchant_zip: { $first: "$merchant.zip" },
                    discount: { $first: "$merchant.discount" },
                    fees_collection: { $sum: { $toDouble: "$swipe.price" } },
                    billing_type: { $first: "$merchant.billing_type" }
                }
            },
        ]);
        merchantOrderDetails = merchantOrderDetails[0];
        if (!empty(merchantOrderDetails)) {
            await Billing.createUsageRecord({
                merchant,
                shop: merchantOrderDetails.shop_id,
                amount: merchantOrderDetails.fees_collection,
                billing_type: merchantOrderDetails.billing_type || "external",
                charge_shopify_now: false,
            });
        }
    } catch (error) {
        console.log(error)
        throwError(error);
    }
}

Billing.appCreditCreate = async (shop_id, amount, description) => {
    try {
        const session = await Services.ShopifySession.get({ shop: shop_id });
        const application_credit = new shopify.api.rest.ApplicationCredit({ session });
        application_credit.description = description;
        application_credit.amount = amount;
        application_credit.test = Config.get('IS_TEST_BILLING');
        await application_credit.save({
            update: true,
        });
        return 'Credit record created';
    } catch (error) {
        console.log(error);
        return 'Error has occurred in create credit record';
    }
}

Billing.chargeStatementOnShopify = async ({
    shop,
    statementId,
    statementMonth,
    amount,
}) => {
    try {
        const finalAmount = Number(amount || 0);
        const description = `Final net billing for ${statementMonth}`;

        if (!(finalAmount > 0)) {
            await Services.Statement.findOneAndUpdate(
                { _id: statementId },
                {
                    shopify_charge_amount: finalAmount,
                    shopify_charge_status: "skipped_zero_amount",
                    shopify_charge_description: description,
                }
            );
            return { charged: false, skipped: true, reason: "zero_amount" };
        }

        const existingStatement = await Services.Statement.get({ _id: statementId });
        if (existingStatement?.shopify_usage_charge_id) {
            return {
                charged: false,
                skipped: true,
                reason: "already_charged",
                usageChargeId: existingStatement.shopify_usage_charge_id,
            };
        }

        const session = await Services.ShopifySession.get({ shop });
        if (!session) {
            throwError(
                `Shopify session not found for shop "${shop}". ` +
                `App may have been uninstalled or session was never created.`
            );
        }
        const hasPayment = await Billing.checkBillingStatus(session, { throwOnError: true });
        if (!hasPayment) {
            throwError(
                `Shopify billing is not approved for shop "${shop}". ` +
                `Merchant must approve the billing request before charges can be created. ` +
                `(IS_TEST_BILLING=${Config.get('IS_TEST_BILLING')})`
            );
        }

        const chargeResponse = await createShopifyUsageCharge({
            session,
            amount: finalAmount,
            description,
        });

        if (chargeResponse.capacityReached) {
            await Services.Statement.findOneAndUpdate(
                { _id: statementId },
                {
                    shopify_charge_amount: finalAmount,
                    shopify_charge_status: "capacity_reached",
                    shopify_charge_description: description,
                }
            );
            return { charged: false, skipped: true, reason: "capacity_reached" };
        }

        await Services.Statement.findOneAndUpdate(
            { _id: statementId },
            {
                shopify_usage_charge_id: chargeResponse.usageChargeId,
                shopify_charge_amount: finalAmount,
                shopify_charge_status: "charged",
                shopify_charge_description: description,
                shopify_charged_at: new Date(),
            }
        );

        return {
            charged: true,
            usageChargeId: chargeResponse.usageChargeId,
        };
    } catch (error) {
        await Services.Statement.findOneAndUpdate(
            { _id: statementId },
            {
                shopify_charge_amount: Number(amount || 0),
                shopify_charge_status: "failed",
                shopify_charge_description: error.message,
            }
        );
        throwError(error);
    }
}

Billing.getUsagesRecord = async (session, charge_id) => {
    try {
        const allCharges = await shopify.api.rest.UsageCharge.all({
            session: session,
            recurring_application_charge_id: charge_id,
        });
        return allCharges.data;
    } catch (error) {
        console.log(error);
        throwError(error);
    }
}

Billing.sendPaymentLink = async (params) => {
    try {
        const { product_id, merchant_id, customer_email, total_amount, statement_id, currency = 'usd' } = params;
        if (!product_id) throwError('Product ID not found');
        const price = await StripeAPI.priceCreate({
            currency,
            product: product_id,
            unit_amount: total_amount * 100,
        });
        const paymentLink = await StripeAPI.paymentLinkCreate({
            line_items: [
                { price: price.id, quantity: 1, }
            ],
        });
        await StripeAPI.paymentLinkUpdate(
            paymentLink.id,
            {
                after_completion: {
                    type: 'redirect',
                    redirect: { url: `https://dashboard.swipe.ai/billing/success/${paymentLink.id}` },
                },
            }
        );

        await Services.Statement.findOneAndUpdate(
            { _id: statement_id },
            { $set: { payment_link: paymentLink.url, payment_link_id: paymentLink.id } }
        );
        await Notifications.sendNotification({
            subject: `Payment link for protection`,
            to: [customer_email],
            template: "PAYMENT_LINK",
            payment_link: paymentLink.url,
        });
        return paymentLink;

    } catch (error) {
        console.log(error);
        throwError(error);
    }
}

Billing.cancelShopifyBilling = async (session) => {
    try {
        const { activeSubscriptions } = await shopify.api.billing.subscriptions({ session });
        if (!activeSubscriptions.length) return { message: MSG.NOT_ACTIVE_SUBSCRIPTION_FOUND };
        const subscriptionId = activeSubscriptions.at(0).id;
        await shopify.api.billing.cancel({
            session,
            subscriptionId,
            prorate: true, // Whether to issue prorated credits for the unused portion of the app subscription. Defaults to true.
        });
        await Services.Merchant.findOneAndUpdate(
            { shop_id: session.shop },
            { $set: { billing_type: '', is_billing: false, } }
        )
        return { message: MSG.SUBSCRIPTION_CANCELED };
    } catch (error) {
        throwError(error);
    }
}

module.exports = Billing;
