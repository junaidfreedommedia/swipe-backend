const express = require("express");
const router = express.Router();

router.post("/get-tiers", async (req, res) => {
  try {
    const { shopId } = req.body;

    if (!shopId) {
      return res.status(400).json({
        swipe_price_tiers_enabled: false,
        cart_customization_enabled: false,
        swipe_tiers: [],
        cart_customization: {},
        logo: null,
      });
    }

    const branding = await Models.Branding.findOne({
      merchant_shopify_id: String(shopId),
      type: "swipe",
      sub_type: "order"
    }).lean();

    if (!branding) {
      return res.json({
        swipe_price_tiers_enabled: false,
        cart_customization_enabled: false,
        swipe_tiers: [],
        cart_customization: {},
        logo: null,
      });
    }

    const dynamicConfigEnabled =
      branding.cart_customization_enabled === true ||
      String(branding.cart_customization_enabled).toLowerCase() === "true";

    const swipeTiers = dynamicConfigEnabled ? (branding.swipe_tiers || []) : [];

    return res.json({
      swipe_price_tiers_enabled: dynamicConfigEnabled,
      cart_customization_enabled: dynamicConfigEnabled,
      swipe_tiers: swipeTiers,
      cart_customization: dynamicConfigEnabled ? (branding.cart_customization || {}) : {},
      logo: branding.show_logo === true ? (branding.logo || null) : null
    });
  } catch (err) {
    console.error("Public get-tiers error:", err);
    res.status(500).json({
      swipe_price_tiers_enabled: false,
      cart_customization_enabled: false,
      swipe_tiers: [],
      cart_customization: {},
      logo: null,
    });
  }
});

module.exports = router;
