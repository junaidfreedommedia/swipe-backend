const express = require("express");
const router = express.Router();
const Merchant = Services.Merchant;
const shopify = require("../../shopify.js");
const ShopifySession = require("../../models/ShopifySession.js");

const syncShopifyValidationMetafields = async (shop, restrictedProducts, errorMessage) => {
    try {
        const session = await ShopifySession.getShopifySession(shop);
        if (!session) {
            console.error(`No Shopify session found for shop: ${shop}`);
            return;
        }

        const client = new shopify.api.clients.Graphql({ session });
        
        // Get Shop ID
        const shopData = await client.query({
            data: {
                query: `
                    query {
                        shop {
                            id
                        }
                    }
                `
            }
        });

        const shopId = shopData.body.data.shop.id;

        // Set Metafields
        const result = await client.query({
            data: {
                query: `
                    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
                        metafieldsSet(metafields: $metafields) {
                            metafields {
                                id
                                namespace
                                key
                                value
                            }
                            userErrors {
                                field
                                message
                            }
                        }
                    }
                `,
                variables: {
                    metafields: [
                        {
                            ownerId: shopId,
                            namespace: "swipe_validation",
                            key: "restricted_products",
                            type: "single_line_text_field",
                            value: restrictedProducts || ""
                        },
                        {
                            ownerId: shopId,
                            namespace: "swipe_validation",
                            key: "restricted_error_message",
                            type: "single_line_text_field",
                            value: errorMessage || "This product cannot be purchased on its own. Please add other items to your cart."
                        }
                    ]
                }
            }
        });

        const userErrors = result.body.data.metafieldsSet.userErrors;
        if (userErrors && userErrors.length > 0) {
            console.error("Error setting validation metafields:", userErrors);
        } else {
            console.log(`Successfully updated validation metafields for ${shop}`);
        }
    } catch (error) {
        console.error("Failed to update validation metafields:", error);
    }
};

const updateMerchantSetting = async (req, res, next) => {
    try {
        const response = await Merchant.UpsertSetting(req.merchant._id, req.body);
        
        // Sync validation metafields to Shopify if validation configuration has been modified
        if (req.body.checkout_validation_enabled !== undefined || 
            req.body.restricted_products !== undefined || 
            req.body.restricted_error_message !== undefined) {
            
            const isEnabled = (req.body.checkout_validation_enabled ?? req.merchant.checkout_validation_enabled) === "on";
            const restrictedProducts = isEnabled ? (req.body.restricted_products ?? req.merchant.restricted_products) : "";
            const errorMessage = req.body.restricted_error_message ?? req.merchant.restricted_error_message;
            const shop = req.merchant.myshopify_domain;
            
            // Sync in background asynchronously
            syncShopifyValidationMetafields(shop, restrictedProducts, errorMessage);
        }

        res.send(response);
    } catch (error) {
        return next(error);
    }
};

const MerchantSettingList = async (req, res, next) => {
    try {
        const response = await Merchant.SettingList(req.params.id);
        res.send(response);
    } catch (error) {
        return next(error);
    }
};

const saveMerchantAccountSetting = async (req, res, next) => {
    try {
        const { payment_method } = req.body;
        let customer = await StripeAPI.customerFind(req.merchant.email);
        if (!customer) {
            customer = await StripeAPI.customerCreate({ email: req.merchant.email, payment_method: payment_method });
            await Merchant.findOneAndUpdate(
                { email: req.merchant.email },
                { $set: { customer_id: customer.id }},
                { new: true, upsert: true }
            );
        } else {
            customer = await StripeAPI.paymentMethodAttach( payment_method, { customer : customer.id } );
        }
        return res.send({
            data: customer,
            message: MSG.CUSTOMER_CREATED,
        });
    } catch (error) {
        return next(error);
    }
};

const saveMerchantBankAccountDetails = async (req, res, next) => {
    try {
        const { bank_token_id } = req.body;
        let customer = await StripeAPI.customerFind(req.merchant.email);
        if (!customer) {
            customer = await StripeAPI.customerCreate({ email: req.merchant.email })
        }
        customer = await StripeAPI.createSource(customer.id, {
            source: bank_token_id, 
        });
        return res.send({  
            data: customer,
            message: MSG.BANK_DETAILS_SAVE,
        });
    } catch (error) {
        return next(error);
     }
};

const getMerchantAccountDetails = async (req, res, next) => {
    try {
        const payment_type = req.params.type
        let customer = await StripeAPI.customerFind(req.merchant.email);
        if (!customer) {
            throwError(MSG.CUSTOMER_NOT_FOUND);
        }
        let paymentMethods = await StripeAPI.paymentMethodsList({ customer: customer.id });

        paymentMethods = paymentMethods.data
        .filter((paymentMethod) => paymentMethod.type.includes(payment_type))
        .map((paymentMethod) => {
            const bankAccountKey = Object.keys(paymentMethod).find((key) => key.includes("bank_account"));
            const { [bankAccountKey]: bankAccount, ...rest } = paymentMethod;
            return { ...rest, ...bankAccount };
        });
        
        return res.send({
            message: paymentMethods.length ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: paymentMethods,
        });
    } catch (error) {
        return next(error);
    }
};
const retriveMerchantPaymentDetails = async (req, res, next) => {
    try {
        let customer = await StripeAPI.customerFind(req.merchant.email);
        if (!customer) {
            throwError(MSG.CUSTOMER_NOT_FOUND);
        }

        let lastUsedPaymentMethod;
        let paymentMethods = await StripeAPI.paymentMethodsList({
            customer: customer.id,
        });

        if (paymentMethods.data.length > 0) {
            const mostRecentPaymentMethod = paymentMethods.data[0];
            lastUsedPaymentMethod = mostRecentPaymentMethod.type;
        }
        return res.send({
            message: lastUsedPaymentMethod
                ? MSG.DATA_FOUND
                : MSG.DATA_NOT_FOUND,
            data: { lastUsedPaymentMethod },
        });
    } catch (error) {
        return next(error);
    }
};

router.post("/upsert", Auth.check, updateMerchantSetting);
router.get("/setting-list/:id", Auth.check, MerchantSettingList);
router.post("/save-account", Auth.check, saveMerchantAccountSetting);
router.post("/save-bank", Auth.check, saveMerchantBankAccountDetails);
router.get("/get-account/:type", Auth.check, getMerchantAccountDetails);
router.get("/retrieve-payment/", Auth.check, retriveMerchantPaymentDetails);

module.exports = router;
