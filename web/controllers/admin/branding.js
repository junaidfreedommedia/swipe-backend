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
        let merchantId = req.params.id;
        const response = await Branding.get({ merchant: merchantId, type: "swipe", sub_type: "order" });
        const merchant = await Services.Merchant.get({ _id: merchantId });
        const merchant_shop = merchant.shop_id;
        return res.send({
            message: MSG.DATA_FOUND,
            data: response,merchant_shop
        });
    } catch (error) {
        return next(error);
    }
};

const postBranding = async (req, res, next) => {
    try {
        let merchantId = req.params.id;
        const configData = req.body || {};
        const merchant = await Services.Merchant.get({ _id: merchantId }, { shop_id: 1 });
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
            merchant?.shop_id,
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

const setDefaultBranding = async (req, res, next) => {
    try {
        const response = await Branding.insert({
            merchant: ObjectId("67f6ab3df7bfa60a9c42f75e"),
            type: "swipe",
            sub_type: "order",
            logo: "https://swipe.ai/wp-content/uploads/2024/05/swipe-email-logo.png",
            type_face: "sans-serif",
            bg_image:
                "https://swipe-images-01.s3.amazonaws.com/high-angle-delivery-truck-boxes+1.jpg",
            colors: {
                font_color: "#000000",
                bg_color: "#FFF382",
                button_bg_color: "#000000",
                button_text_color: "#f3efef",
            },
            button_style: "default",
        });
        return res.send({
            message: MSG.DATA_ADDED,
            data: response,
        });
    } catch (error) {
        return next(error);
    }
};

const findMerchant = async (req, res, next) => {
    try {
        const response = await Services.Merchant.get({
            shop_id: req.params.shop,
        });
        if (!response) throwError(MSG.INVALID_SHOP);
        return res.send({
            message: MSG.DATA_FOUND,
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
        const data = await S3.uploadExport(file_name, content.data, environment);
        return res.send({
            message: MSG.FILE_UPLOADED,
            data: data.Location,
        });
    } catch (error) {
        return next(error);
    }
};

const imageUpload = async (req, res, next) => {
    try {
        const content = req.files.file_content;
        const parts = req.files.file_content.name.split(".");
        const namePart = parts[0];
        const file_name = `${namePart}${createRandomString(10)}.jpg`;
        const environment = `branding/${process.env.S3_ENVIRONMENT}`;
        const data = await S3.uploadExport(file_name, content.data, environment);
        return res.send({
            message: MSG.FILE_UPLOADED,
            data: data.Location,
        });
    } catch (error) {
        return next(error);
    }
};

const getBrandingForWordpress = async (req, res, next) => {
    try {
        let merchantId = req.params.id;
        const response = await Branding.get({ merchant: merchantId, type: "swipe", sub_type: "order" });
        return res.send({
            message: MSG.DATA_FOUND,
            data: response,
        });
    } catch (error) {
        return next(error);
    }
};

router.get("/:id", Auth.check, getBranding);
router.post("/upsert/:id", Auth.check, postBranding);
router.post("/add", setDefaultBranding);
router.get("/find/:shop", findMerchant);
router.post("/upload", Auth.check, uploadToS3);
router.post("/image-upload", imageUpload);
router.get("/v1/:id", getBrandingForWordpress);

module.exports = router;
