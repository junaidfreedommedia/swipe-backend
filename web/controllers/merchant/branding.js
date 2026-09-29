const express = require("express");
const router = express.Router();
const shopify = require("../../shopify");
const ShopifySession = require("../../services/ShopifySession");
const Branding = Services.Branding;

async function syncSwipeCartDynamicFlag(shopDomain, enabled) {
    if (!shopDomain) {
        return;
    }

    const session = await ShopifySession.get({ shop: shopDomain });
    if (!session) {
        console.warn(`[Swipe] No Shopify session found for ${shopDomain}; skipping dynamic flag sync.`);
        return;
    }

    const client = new shopify.api.clients.Graphql({ session });
    const shopQuery = `
        query SwipeShopId {
            shop {
                id
            }
        }
    `;
    const shopResponse = await client.request(shopQuery);
    const ownerId = shopResponse?.data?.shop?.id;

    if (!ownerId) {
        throw new Error(`Unable to resolve Shopify shop id for ${shopDomain}`);
    }

    const mutation = `
        mutation SwipeSetDynamicFlag($metafields: [MetafieldsSetInput!]!) {
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
    `;

    const mutationResponse = await client.request(mutation, {
        variables: {
            metafields: [
                {
                    ownerId,
                    namespace: "swipe",
                    key: "dynamic_config_enabled",
                    type: "boolean",
                    value: enabled ? "true" : "false",
                },
            ],
        },
    });

    const userErrors = mutationResponse?.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length) {
        throw new Error(userErrors.map((item) => item.message).join(", "));
    }
}

const getBranding = async (req, res, next) => {
    try {
        let merchantId = req.merchant._id;
        const response = await Branding.get({ merchant: merchantId, type: "swipe", sub_type: "order" });
        return res.send({
            message: MSG.DATA_FOUND,
            data: response,
        });
    } catch (error) {
        return next(error);
    }
};

const postBranding = async (req, res, next) => {
    try {
        let merchantId = req.merchant._id;
        const configData = req.body;
        if (!configData) {
            return res.status(400).send({ message: "Invalid payload" });
        }

        const response = await Branding.findOneAndUpdate(
            { merchant: merchantId, type: "swipe", sub_type: "order" },
            {
               $set: {
                ...configData,
                merchant: merchantId,
                swipe_tiers: configData.swipe_tiers || [],
                swipe_price_tiers_enabled: configData?.swipe_price_tiers_enabled ?? false,
                swipe_order_email_enabled: configData?.swipe_order_email_enabled ?? false,
                cart_customization_enabled: configData?.cart_customization_enabled ?? false,
                cart_customization: configData.cart_customization || {},
                show_logo: configData?.show_logo ?? false,
                type: "swipe",
                sub_type: "order",
                },
            },
            { upsert: true, new: true }
        );

        await syncSwipeCartDynamicFlag(
            req.merchant?.shop_id,
            configData?.cart_customization_enabled === true || String(configData?.cart_customization_enabled).toLowerCase() === "true"
        );

        return res.send({
            message: MSG.DATA_UPDATED,
            data: response,
        });
    } catch (error) {
        return next(error);
    }
};
const uploadToS3 = async (req, res, next) => {
    try {
        const content = req.files.file_content;
        const parts = req.files.file_content.name.split(".");
        const namePart = parts[0];
        const file_name = `${namePart}${createRandomString(10)}.jpg`;
        const environment = `branding/${process.env.S3_ENVIRONMENT}`; 
        const data =  await S3.uploadExport(file_name, content.data, environment)
        return res.send({
            message: MSG.FILE_UPLOADED,
            data: data.Location,
        });
    } catch (error) {
        return next(error);
    }
};

router.get("/", Auth.check, getBranding);
router.post("/upsert", Auth.check, postBranding);
router.post("/upload", Auth.check, uploadToS3);

module.exports = router;
