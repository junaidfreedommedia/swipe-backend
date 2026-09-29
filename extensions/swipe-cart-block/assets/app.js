let dynamicTiers = null;
let cartCustomization = null;
let merchantLogo = null;
let showLogo = true;
let swipeFeaturesEnabled = false;
let merchantConfigPromise = null;
let loadedShopId = null;

function parseEmbeddedBoolean(value) {
  if (value === true || value === false) {
    return value;
  }

  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return null;
}

function getDynamicConfigFlag(shopElement) {
  const datasetValue = parseEmbeddedBoolean(shopElement?.dataset?.dynamicEnabled);
  if (datasetValue !== null) {
    return datasetValue;
  }

  return parseEmbeddedBoolean(window.swipeDynamicConfigEnabled);
}

async function loadMerchantConfig(forceReload = false) {
  try {
    const shopElement = document.querySelector(".post-protect_cart");
    const shopId = shopElement?.dataset.shop;
    const dynamicConfigFlag = getDynamicConfigFlag(shopElement);

    if (!shopId) {
      dynamicTiers = null;
      cartCustomization = null;
      merchantLogo = null;
      swipeFeaturesEnabled = false;
      loadedShopId = null;
      return;
    }

    if (dynamicConfigFlag === false) {
      dynamicTiers = null;
      cartCustomization = null;
      merchantLogo = null;
      swipeFeaturesEnabled = false;
      loadedShopId = shopId;
      merchantConfigPromise = Promise.resolve();
      return;
    }

    if (!forceReload && merchantConfigPromise && loadedShopId === shopId) {
      await merchantConfigPromise;
      return;
    }

    loadedShopId = shopId;
    merchantConfigPromise = (async () => {
      dynamicTiers = null;
      cartCustomization = null;
      merchantLogo = null;

      
      const response = await fetch("https://app.swipe.ai/public/get-tiers", {
        
      
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ shopId })
      });

      if (!response.ok) {
        swipeFeaturesEnabled = false;
        console.error("API Error:", response.status);
        return;
      }

      const data = await response.json();
      const dynamicConfigEnabled =
        data?.cart_customization_enabled === true ||
        String(data?.cart_customization_enabled).toLowerCase() === "true";

      swipeFeaturesEnabled = dynamicConfigEnabled;
      merchantLogo = data?.logo || null;
      cartCustomization = dynamicConfigEnabled
        ? (data?.cart_customization || null)
        : null;

      if (dynamicConfigEnabled && data?.swipe_tiers?.length) {
        dynamicTiers = data.swipe_tiers.map(t => ({
          title: t.title,
          min: t.min,
          max: t.max
        }));
        return;
      }

      dynamicTiers = null;
    })();

    await merchantConfigPromise;
  } catch (err) {
    dynamicTiers = null;
    cartCustomization = null;
    merchantLogo = null;
    swipeFeaturesEnabled = false;
    merchantConfigPromise = null;
    console.error("Failed to load merchant config:", err);
  }
}

let isApplyingSwipe = false;

const CHECKOUT_SELECTOR_LIST = [
  'a[href$="/checkout"]',
  'button[name="checkout"]',
  'input[name="checkout"]',
  ".cart__checkout",
  ".buy-now",
  ".rebuy-cart__checkout-button",
  ".buy-it-now",
  'a[href*="/tools/recurring/checkout"]',
  'form[action*="/tools/recurring/checkout"] button[type="submit"]',
  'form[action*="/tools/recurring/checkout"] input[type="submit"]',
  'button[data-recharge-checkout]',
  'input[data-recharge-checkout]',
  'a[data-recharge-checkout]',
  ".recharge-checkout-button",
];
const CHECKOUT_SELECTOR = CHECKOUT_SELECTOR_LIST.join(", ");

 // Inject CSS for button styling and loading state:
const styleTag = document.createElement("style");
styleTag.textContent = `



/* Cart & Product page checkout button tweaks */

.swipe-info-box svg {
    top: 0px;
    position: relative;
}
  .footer-terms-policy {
    width: 83%;
    line-height: 13px;
    font-size: 7px;
    margin: 0 auto;
}

  .footer-fileclaim {
    line-height: 28px;
    font-weight: bold;
}
.cart-drawer-overlay:before {
    z-index: 0 !important;
}
${CHECKOUT_SELECTOR} {
 display: none !important;
}
[data-rebuy-component=cart-items] .rebuy-cart__flyout-item.product-swipe {
  display: none !important;
}
.swipe-info-box .oldprotect {
    display: none;
}
.swipe-custom-box,
.swipe-btn-protection {
 z-index: 9999 !important;
 position: relative !important;
}
.swipe-btn-protection {
 pointer-events: auto !important;
}
 .open-popup {
 display: flex;
  justify-content:flex-start;
align-items:flex-start;
 border-radius: 13px;
 background-color: #fff;
 overflow: hidden;
 box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}

 .cart__row, 
.cart__item, 
[data-product-unlisted="true"], 
.product-unlisted  {
    display: none !important;
}

/* Hide quantity selectors for Swipe protection items */
[data-swipe-protected-item] .quantity,
[data-swipe-protected-item] .cart-item__quantity,
[data-swipe-protected-item] .cart__qty,
[data-swipe-protected-item] .cart__quantity,
[data-swipe-protected-item] .rebuy-cart__flyout-item-quantity,
[data-swipe-protected-item] .rebuy-cart__flyout-item-controls,
[data-swipe-protected-item] .quantity-selector,
[data-swipe-protected-item] [data-quantity-selector],
[data-swipe-protected-item] .qty-input,
// [data-swipe-protected-item] input[type="number"],
[data-swipe-protected-item] button[name="plus"],
[data-swipe-protected-item] button[name="minus"] {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
}

.footer-fileclaim {

}
.cartsimplebutton{
  display:none;
}
.swipe-info-box {
 order: 1;
 text-align: left;
padding:8px 0px;
}
.swipe-info-box span {
    font-size: 14px;
    display: inline-flex;
    font-family: Arial, sans-serif;
    width: 100%;
    line-height: 16px;
}
.swipe-container{
 width: 420px;
 height: 670px;
border-radius:13px;
background:#FFF;
box-sizing:border-box;
border-radius:13px;
font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif !important;
background:#FFF;
padding:30px;
box-sizing:border-box;
display:flex;
flex-direction:column;
gap:20px;
position:relative;
}
.swipe-header-logo{
display:flex;
justify-content:space-between;
 width:100%;
}
.swipe-header-logo svg{
width:67px;
height:20px;
}
.swipe-heading{
width:100%
}
.swipe-header-logo svg{width:67px;height:20px;}
.close img{width:14px;height:14px;cursor:pointer;}
.swipe-heading h1{
 margin:0;
 color:#000;
 font-size:36px;
 font-weight:700;
 line-height: 110%;
 letter-spacing:2.973px;
   text-align: start;
       text-transform: uppercase;
}
.swipe-para {
  text-align: left;
  width: 80%;
  font-size: 11px !important;
  font-weight: normal !important;
}
.swipe-heading span{
background: linear-gradient(84deg, #FFE0D9 10.9%, #D9C5E6 46.77%, #C4B7EC 84.54%);
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    font-size: 36px;
    font-weight: 700;
    line-height: 34px;
    letter-spacing: 2.973px
}
.swipe-para{
 margin:8px 0 0;
 color:#000;
 font-size:11px;
 line-height:14px;
}
.swipe-popup__feature-content{
  text-align: start;
  max-width: 230px;
}
 .swipe-checkout-hide{
display:none !important;
 visibility:hidden;
 opacity:0;
}
.swipe-listing-heading {
  margin: 0;
  color: #000;
  font-size: 18px;
  font-weight: 500;
  line-height: 17.43px;
  letter-spacing: -0.212px;
  text-transform: capitalize;
  text-align: start;
  padding-left: 0px;
}

.swipe-popup__features {
  list-style: none;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0px 0px;
}
.swipe-popup__feature{
display:flex;
justify-content: space-between;
gap:10px;
align-items: flex-start;
    border-radius: 14.615px;
    opacity: 0.7;
    background: linear-gradient(180deg,#fbe6e9,#e6e4f6)!important;
    padding: 16px;
}
.swipe-popup__feature-icon img {
  width: 53px;
  height: 53px;
  max-width:53px;
}
.swipe-popup__feature-title{
  color: #000000;
  font-size: 14px !important;
  font-weight: 700 !important;
  line-height: 28px;
  letter-spacing: -0.34px;
 margin:0px;
}
  .swipe-popup-privacy-content {
    text-align: center !important;
}
.swipe-popup__feature-description{
color: #000;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  letter-spacing: -0.4px;
 margin:0px;
}
.swipe-custom-box {
    display: flex !important;
    flex-direction: column-reverse;
    gap: 0px !important;
    margin-top: 0px !important;
    padding: 12px 0px 0px;
    border-radius: 17px;
  margin-bottom: 0px !important;
}
 button.swipe-btn-protection {
  background: #333;
  color: #fff;
  line-height: 32px;
  font-size: 16px;
  border-radius: 0px !important;
position:relative;
width:100%;
}
.swipe-popup-privacy-content span{
  text-align: center;
  color: #919191;
  font-size: 10px;
  font-weight: 300;
  width: 100%;
  max-width: 100%;
  margin: 0 auto;
  line-height: 20px;
  padding: 0px !important;
}
.swipe-popup-privacy-content a{
 color:#B1A4D7;
 font-weight:700;
 text-decoration:underline;
}
.swipe-link-no-protection {
  position: relative;
  text-align: center;
  font-size: 14px;
  padding: 12px 0px 0px;
position: static;
  font-size: 12px !important;
  width: 100%;

}
 /** swipe-pop-redeign */
.pp_footer_cart .full-carbon-text_cart {
 letter-spacing: .0;
}
body:has(.open-popup) {
 overflow: hidden;
}
.close * {
 pointer-events: none;
}
.tabing ul li a * {
 pointer-events: none;
}
.rebuy-button.block, .rebuy-cart__flyout-empty-cart a.block {
  display: none !important;
}
  .swipe-btn-protection span.cartfee{
display:block;
}
    .swipe-btn-protection span.protectfee{
display:none;
}
.swipe-popup {
 width: 100%;
 background: rgba(0, 0, 0, 0.8);
 display: none;
 position: fixed;
 top: 0;
 left: 0;
 right: 0;
 bottom: 0;
 text-align: center;
 z-index: 99;
 height: 100vh;
 overflow: auto;
 margin: 0px;
 padding: 15px;
 flex-wrap: wrap;
 justify-content: center;
 align-items: center;
}
.swipe-popup {
 opacity: 0;
 visibility: hidden;
 display:none;
}
.swipe-popup.open-popup {
 opacity: 1;
 visibility: visible;
 display: flex;
 z-index: 9999999;
}
#rebuy-cart .rebuy-cart__background.hidebg_rebuycart{
opacity:0 !important;
display:none !important;
}
.close {
 position: absolute;
 right: 15px;
 top: 13px;
 width: 14px;
 display: block;
 cursor: pointer;
}
.close span {
 cursor: pointer;
 position: fixed;
 width: 20px;
 height: 3px;
 background: #099ccc;
}
.close span:nth-child(1) {
 transform: rotate(45deg);
}
.close span:nth-child(2) {
 transform: rotate(135deg);
}

.popup__content_inner {
 display: flex;
 align-items: center;
 justify-content: space-between;
 padding: 0 0 5px;
}

@media only screen and (max-width: 749px) {
  dialog.swipe-modal {
    max-width: 100% !important;
}
   dialog.swipe-modal  .swipe-heading span {

    font-size: 20px;
    font-weight: 700;
    line-height: 24px;

    }
  dialog.swipe-modal  .swipe-heading h1 {

    font-size: 24px;}
   dialog.swipe-modal .swipe-popup__features {

    gap: 8px;

}
  .swipe-popup__features .swipe-popup__feature:last-child {
    margin: 0px;
}
 .post-protect_cart{
  width: 100%;
  max-width: 358px;
  margin: 0 auto;
 }
 .rebuy-cart__background {
    z-index:99 !important;
  }

  .swipe-container {
    position: relative;
   z-index: 9999 !important;
 }
 .swipe-popup.open-popup{
  z-index: 111111111111 !important;
 }
}

@media only screen and (max-width: 767px) {
 .post-protect_cart{
  width: 100%;
  max-width: 358px;
  margin: 0 auto;
 }
 .rebuy-cart__background {
    z-index:99 !important;
  }

  .swipe-container {
    position: relative;
   z-index: 9999 !important;
 }
 .swipe-popup.open-popup{
  z-index: 111111111111 !important;
 }
}
.pp-price{
 display:none;
}
.pp-checkbox:has(#post_protection_checkbox[checked]) + .pp-price.show_price{
 display: inline-block !important;
}
@media screen and (min-width: 750px) {
 .cart__ctas {
  display: flex;
  gap: 1rem;
  flex-direction: column-reverse;
 }
}
.cart__checkout-button {
 position: relative;
}
.cart__checkout-button svg {
 width: 20px !important;
 height: 20px !important;
 background: #eeeeee;
 position: absolute;
 left: 24px;
 top: 15px;
 border-radius: 25px;
}
.post-protect_cart {
 display: none !important;
}

.swipe-info-box {
  width: 100%;
}
.swipe-custom-box {
  display: flex !important;
  flex-direction: column-reverse;
  position: relative;
  gap: 0px !important;
  margin-top: 0px !important;
}

.pw-learn-more  svg .st0 {
  fill: #fff;
}
.pp_logo p {
 padding: 0px !important;
 margin: 0px !important;
}
.pp_subtitle-text p {
 font-size: 10px;
 padding: 0px !important;
 margin: 0px 0px 10px;
}
.loading-overlay {
 opacity: 1;
}
  .swipe-benefits{
  list-style:none;
  padding:0px;
  margin:0px;
  }
  .swipe-benefits-expand {
  display:none;
    cursor: pointer !important;
}
.swipe-benefits-expand svg {
    width: 12px;
    height: 12px;
    position: absolute;
    top: 23px;
    right: 20px;
    transform: rotate(360deg);
}
.swipe-benefits li {
    padding: 0px;
    margin: 0px;
    display: flex;
  line-height:27px;
    flex-direction: row;
}
.swipeprotected-icon {
    left: 0px !important;
}
  
.swipe-benefits h4 {
    font-size: 12px;
    font-weight: bold;
    text-transform: capitalize;
    margin: 10px 0px;
    border-top: 1px solid #CECECE;
    padding: 14px 0px 0px;
}
  .swipe-benefits-expand  .rotate-90 {
    transform: rotate(180deg) !important;
}
.swipe-benefits {
    display: none;
    transform: translateY(-40px);
    opacity: 0;
    transition: transform 0.45s 
cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s 
ease;
}

.swipe-benefits.active {
    display: block;
    transform: translateY(0);
    opacity: 1;
}

 .swipe-benefits .swipe-benefits-tick {
    margin: 12px 7px 0px 0px;
}
  .swipe-popupbtn-icon {
    position: relative;
    left: -4px;
    width: 16px;
    top: 2px;
    height: 16px;
  cursor:pointer;
}
.swipe-brand-logos{
 display:flex;
 align-items:center;


}

#swipe-merchant-logo{
 height:48px;
 width:auto;
 object-fit:contain;
 display:block;
 max-width:120px;
  margin-right:100px
 padding-right:100px;
     margin-top: -12px;
    max-height: 90px;
}
 .merchen_logo_db{
 margin-right: 17px !important;
    margin-top: -33px;
`;
document.head.appendChild(styleTag);


let variantLogic = [
   { title: "$1.27", min: 0, max: 50 },
  { title: "$1.57", min: 51, max: 75 },
  { title: "$2.07", min: 76, max: 100 },
  { title: "$2.77", min: 101, max: 125 },
  { title: "$3.47", min: 126, max: 150 },
  { title: "$4.17", min: 151, max: 175 },
  { title: "$4.77", min: 176, max: 200 },
  { title: "$5.47", min: 201, max: 250 },
  { title: "$6.87", min: 251, max: 300 },
  { title: "$8.17", min: 301, max: 350 },
  { title: "$9.57", min: 351, max: 400 },
  { title: "$10.87", min: 401, max: 450 },
  { title: "$12.27", min: 451, max: 500 },
  { title: "$13.57", min: 501, max: 550 },
  { title: "$14.97", min: 551, max: 600 },
  { title: "$16.27", min: 601, max: 650 },
  { title: "$17.67", min: 651, max: 700 },
  { title: "$18.97", min: 701, max: 750 },
  { title: "$20.37", min: 751, max: 800 },
  { title: "$21.67", min: 801, max: 850 },
  { title: "$23.07", min: 851, max: 900 },
  { title: "$24.37", min: 901, max: 950 },
  { title: "$25.77", min: 951, max: 1000 },
  { title: "$27.07", min: 1001, max: 1050 },
  { title: "$28.47", min: 1051, max: 1100 },
  { title: "$29.77", min: 1101, max: 1150 },
  { title: "$31.17", min: 1151, max: 1200 },
  { title: "$32.47", min: 1201, max: 1300 },
  { title: "$35.17", min: 1301, max: 1400 },
  { title: "$37.87", min: 1401, max: 1500 },

];

// State variables (populated on demand)
let productData; // 
let skipSwipeMutation = false;
// Helper to replace "{{amount}}" in the money format
const moneyFormat = (amount) => {
 const cleanAmount = parseFloat(amount).toFixed(2);
 return window.postMoneyFomat.replace("{{amount}}", cleanAmount);
};

// Build fetch params for JSON calls
const prepParams = (method, body) => {
  let obj = { method, headers: { "Content-Type": "application/json" } };
  if (body) obj.body = JSON.stringify(body);
  return obj;
};

const SWIPE_FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = SWIPE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Parse textÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂJSON if there is a response body
const prepResponse = async (response) => {
  const text = await response.text();
  if (!text) return { response: false };
  return { response: true, data: JSON.parse(text) };
};

function getLineItemSellingPlanId(item) {
  if (!item) return null;

  const directPlanId = item.selling_plan || item.selling_plan_id;
  if (directPlanId !== undefined && directPlanId !== null && directPlanId !== "") {
    return String(directPlanId);
  }

  const allocatedPlanId = item.selling_plan_allocation?.selling_plan?.id;
  if (
    allocatedPlanId !== undefined &&
    allocatedPlanId !== null &&
    allocatedPlanId !== ""
  ) {
    return String(allocatedPlanId);
  }

  return null;
}

function normalizeSellingPlanId(planId) {
  if (!planId) return null;
  const raw = String(planId);
  const gidMatch = raw.match(/(\d+)(?!.*\d)/);
  const normalized = gidMatch ? gidMatch[1] : raw;
  return normalized;
}

function normalizeSellingPlanTitle(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getLineItemSellingPlanTitle(item) {
  if (!item) return null;

  const plan = item?.selling_plan_allocation?.selling_plan;
  const directName =
    plan?.name ||
    plan?.title ||
    item?.selling_plan_name ||
    item?.selling_plan_allocation?.name;

  if (directName) {
    return String(directName);
  }

  const options = Array.isArray(plan?.options) ? plan.options : [];
  if (options.length) {
    return options
      .map((option) => option?.value || option?.name || "")
      .filter(Boolean)
      .join(" / ");
  }

  return null;
}
const SWIPE_MAX_CART_SUBTOTAL = Infinity;
const SWIPE_PRODUCT_TITLES = new Set(["Swipe", "Swipe Package Protection"]);

function isSwipeProtectionItem(item) {
  const title = item?.product_title || item?.title || "";
  return SWIPE_PRODUCT_TITLES.has(title);
}

function getSwipeProtectionItems(items = []) {
  return (items || []).filter((item) => isSwipeProtectionItem(item));
}

function getNonSubscriptionSwipeItems(items = []) {
  return getSwipeProtectionItems(items).filter(
    (item) => !getLineItemSellingPlanId(item)
  );
}

function getCartLineUpdateKey(item) {
  if (!item) return null;
  return item.key || item.id || null;
}

function buildRemoveSwipeUpdates(items = []) {
  const updates = {};
  getSwipeProtectionItems(items).forEach((item) => {
    const updateKey = getCartLineUpdateKey(item);
    if (updateKey !== undefined && updateKey !== null) {
      updates[updateKey] = 0;
    }
  });
  return updates;
}

function hasSubscriptionLine(items = []) {
  return (items || []).some(
    (item) => !isSwipeProtectionItem(item) && !!getLineItemSellingPlanId(item)
  );
}

function getProtectionTiersToUse() {
  return dynamicTiers && dynamicTiers.length ? dynamicTiers : variantLogic;
}

function resolveTierForSubtotal(subtotal) {
  const tiersToUse = getProtectionTiersToUse();
  const maxTier = tiersToUse.reduce((highest, current) => {
    if (!highest || Number(current.max) > Number(highest.max)) {
      return current;
    }
    return highest;
  }, null);

  const tierMaxLimit = maxTier ? Number(maxTier.max) : null;
  const maxTierLimit =
    tierMaxLimit === null
      ? SWIPE_MAX_CART_SUBTOTAL
      : Math.min(tierMaxLimit, SWIPE_MAX_CART_SUBTOTAL);

  if (subtotal > maxTierLimit) {
    return { tier: null, maxTier, isAboveMaxTier: true };
  }

  for (const t of tiersToUse) {
    const tierUpperBound = Math.min(Number(t.max), maxTierLimit);
    const isLastTier = Number(t.max) >= maxTierLimit;
    const isTierMatch = isLastTier
      ? t.min <= subtotal && subtotal <= tierUpperBound
      : t.min <= subtotal && subtotal <= tierUpperBound;

    if (isTierMatch) {
      return { tier: t, maxTier, isAboveMaxTier: false };
    }
  }

  return { tier: null, maxTier, isAboveMaxTier: false };
}

function findSwipeVariantByTier(swipe, tier) {
  if (!swipe?.variants || !tier?.title) return null;
  return swipe.variants.find((v) => v.title === tier.title) || null;
}

function getItemSubtotal(item) {
  return Number(item?.final_line_price || 0) / 100;
}

function getVariantPriceAmount(variant) {
  return Number(variant?.price || 0) / 100;
}

function getSwipeSupportedSellingPlanIds(swipe) {
  const groups = Array.isArray(swipe?.selling_plan_groups)
    ? swipe.selling_plan_groups
    : [];
  const supportedIds = new Set();

  groups.forEach((group) => {
    const plans = Array.isArray(group?.selling_plans) ? group.selling_plans : [];
    plans.forEach((plan) => {
      const normalizedId = normalizeSellingPlanId(plan?.id);
      if (normalizedId) {
        supportedIds.add(normalizedId);
      }
    });
  });

  return supportedIds;
}

function getSwipeSellingPlanIdByTitle(swipe, title) {
  const normalizedTarget = normalizeSellingPlanTitle(title);
  if (!normalizedTarget) return null;

  const groups = Array.isArray(swipe?.selling_plan_groups)
    ? swipe.selling_plan_groups
    : [];

  for (const group of groups) {
    const plans = Array.isArray(group?.selling_plans) ? group.selling_plans : [];
    for (const plan of plans) {
      const candidates = [
        plan?.name,
        plan?.title,
        ...(Array.isArray(plan?.options)
          ? plan.options.flatMap((option) => [option?.name, option?.value])
          : []),
      ]
        .filter(Boolean)
        .map(normalizeSellingPlanTitle);

      if (candidates.includes(normalizedTarget)) {
        return normalizeSellingPlanId(plan?.id);
      }
    }
  }

  return null;
}

function buildDesiredSwipeLines(items = [], swipe) {
  const sourceItems = (items || []).filter((item) => !isSwipeProtectionItem(item));
  if (!sourceItems.length || !swipe?.variants?.length) {
    return { lines: [], totalProtectionAmount: 0, hasAboveMaxTier: false };
  }

  const supportedSellingPlanIds = getSwipeSupportedSellingPlanIds(swipe);
  const subscriptionItems = sourceItems.filter((item) => !!getLineItemSellingPlanId(item));
  const onetimeItems = sourceItems.filter((item) => !getLineItemSellingPlanId(item));
  const desiredLines = [];
  let totalProtectionAmount = 0;
  let hasAboveMaxTier = false;

  if (!subscriptionItems.length) {
    const subtotal = sourceItems.reduce((sum, item) => sum + getItemSubtotal(item), 0);
    const { tier, isAboveMaxTier } = resolveTierForSubtotal(subtotal);
    hasAboveMaxTier = isAboveMaxTier;

    if (!tier) {
      return { lines: [], totalProtectionAmount: 0, hasAboveMaxTier };
    }

    const match = findSwipeVariantByTier(swipe, tier);
    if (!match) {
      return { lines: [], totalProtectionAmount: 0, hasAboveMaxTier };
    }

    desiredLines.push({
      variantId: Number(match.id),
      sellingPlanId: null,
      quantity: 1,
    });
    totalProtectionAmount += getVariantPriceAmount(match);
    return { lines: desiredLines, totalProtectionAmount, hasAboveMaxTier };
  }

  // Group subscription items by their resolved selling plan so that all
  // subscription items sharing the same plan produce a single Swipe line
  // (mirrors the one-time items aggregation below).
  const subscriptionGroups = new Map();
  for (const item of subscriptionItems) {
    const cartSellingPlanId = getLineItemSellingPlanId(item);
    const cartSellingPlanTitle = getLineItemSellingPlanTitle(item);
    const normalizedSellingPlanId = normalizeSellingPlanId(cartSellingPlanId);
    const matchedSwipeSellingPlanId = getSwipeSellingPlanIdByTitle(
      swipe,
      cartSellingPlanTitle
    );
    const resolvedSellingPlanId =
      matchedSwipeSellingPlanId || normalizedSellingPlanId;

    if (!resolvedSellingPlanId) {
      console.warn(
        "Swipe subscription mapping skipped: missing selling plan title/id.",
        item
      );
      continue;
    }

    if (
      supportedSellingPlanIds.size > 0 &&
      !supportedSellingPlanIds.has(resolvedSellingPlanId)
    ) {
      console.warn(
        `Swipe subscription mapping fallback: plan title "${cartSellingPlanTitle || "unknown"}" did not match a Swipe selling plan.`
      );
    }

    const existing = subscriptionGroups.get(resolvedSellingPlanId);
    if (existing) {
      existing.subtotal += getItemSubtotal(item);
    } else {
      subscriptionGroups.set(resolvedSellingPlanId, {
        subtotal: getItemSubtotal(item),
      });
    }
  }

  for (const [resolvedSellingPlanId, group] of subscriptionGroups) {
    const { tier, isAboveMaxTier } = resolveTierForSubtotal(group.subtotal);
    hasAboveMaxTier = hasAboveMaxTier || isAboveMaxTier;
    if (!tier) continue;

    const match = findSwipeVariantByTier(swipe, tier);
    if (!match) continue;

    desiredLines.push({
      variantId: Number(match.id),
      sellingPlanId: resolvedSellingPlanId,
      quantity: 1,
    });
    totalProtectionAmount += getVariantPriceAmount(match);
  }

  if (onetimeItems.length) {
    const subtotal = onetimeItems.reduce((sum, item) => sum + getItemSubtotal(item), 0);
    const { tier, isAboveMaxTier } = resolveTierForSubtotal(subtotal);
    hasAboveMaxTier = hasAboveMaxTier || isAboveMaxTier;

    if (tier) {
      const match = findSwipeVariantByTier(swipe, tier);
      if (match) {
        desiredLines.push({
          variantId: Number(match.id),
          sellingPlanId: null,
          quantity: 1,
        });
        totalProtectionAmount += getVariantPriceAmount(match);
      }
    }
  }

  return { lines: desiredLines, totalProtectionAmount, hasAboveMaxTier };
}

function getSwipeSignature(variantId, sellingPlanId) {
  const normalizedVariantId = Number(variantId);
  const normalizedPlanId = normalizeSellingPlanId(sellingPlanId) || "none";
  return `${normalizedVariantId}::${normalizedPlanId}`;
}

function getCountMap(entries) {
  const map = new Map();
  entries.forEach((entry) => {
    map.set(entry, (map.get(entry) || 0) + 1);
  });
  return map;
}

function areSwipeLinesInSync(existingSwipeItems = [], desiredSwipeLines = []) {
  const existingSignatures = existingSwipeItems.flatMap((item) => {
    const count = Math.max(1, Number(item?.quantity || 1));
    const signature = getSwipeSignature(
      item.variant_id,
      getLineItemSellingPlanId(item)
    );
    return Array.from({ length: count }, () => signature);
  });
  const desiredSignatures = desiredSwipeLines.flatMap((line) => {
    const count = Math.max(1, Number(line?.quantity || 1));
    const signature = getSwipeSignature(line.variantId, line.sellingPlanId);
    return Array.from({ length: count }, () => signature);
  });

  const existingMap = getCountMap(existingSignatures);
  const desiredMap = getCountMap(desiredSignatures);

  if (existingMap.size !== desiredMap.size) return false;

  for (const [key, value] of existingMap.entries()) {
    if (desiredMap.get(key) !== value) return false;
  }

  return true;
}

async function addSwipeVariantsToCart(lines = []) {
  if (!lines.length) return;

  for (const line of lines) {
    const payloadLine = {
      id: Number(line.variantId),
      quantity: Number(line.quantity || 1),
    };

    const normalizedPlanId = normalizeSellingPlanId(line.sellingPlanId);
    if (normalizedPlanId) {
      payloadLine.selling_plan = Number(normalizedPlanId);
    }

    const response = await fetchWithTimeout(
      "/cart/add.js",
      prepParams("POST", { items: [payloadLine] })
    );
    if (!response.ok) {
      let errorText = "";
      try {
        errorText = await response.text();
      } catch (err) {
        errorText = "";
      }
      throw new Error(
        `Swipe add failed with status ${response.status}${
          errorText ? `: ${errorText}` : ""
        }`
      );
    }
  }
}

async function getCartItem() {
  const response = await fetchWithTimeout("/cart.js");
  if (!response.ok) {
    throw new Error(`Cart fetch failed with status ${response.status}`);
  }
  const cart = await response.json();
  if (window.Shopify) {
    window.Shopify.cart = cart;
  }
  return cart;
}

async function syncSwipeCartLines(desiredSwipeLines = []) {
  const currentCart = await getCartItem();
  const currentItems = currentCart.items || [];
  const currentSwipeItems = getSwipeProtectionItems(currentItems);

  if (areSwipeLinesInSync(currentSwipeItems, desiredSwipeLines)) {
    return currentCart;
  }

  const removeUpdates = buildRemoveSwipeUpdates(currentItems);
  if (Object.keys(removeUpdates).length) {
    const removeResponse = await fetchWithTimeout(
      "/cart/update.js",
      prepParams("POST", { updates: removeUpdates })
    );
    if (!removeResponse.ok) {
      throw new Error(`Swipe replace failed with status ${removeResponse.status}`);
    }
    await new Promise((res) => setTimeout(res, 200));
  }

  if (desiredSwipeLines.length) {
    await addSwipeVariantsToCart(desiredSwipeLines);
    await new Promise((res) => setTimeout(res, 200));
  }

  return getCartItem();
}

async function enforceNonSubscriptionSwipeRules() {
  if (isApplyingSwipe || skipSwipeMutation) return false;

  const cart = await getCartItem();
  const items = cart.items || [];
  const nonSubscriptionSwipeItems = getNonSubscriptionSwipeItems(items);
  if (!nonSubscriptionSwipeItems.length) return false;

  const updates = {};
  let hasChanges = false;

  nonSubscriptionSwipeItems.forEach((item, index) => {
    const updateKey = getCartLineUpdateKey(item);
    if (!updateKey) return;

    if (index === 0) {
      if (Number(item.quantity || 1) !== 1) {
        updates[updateKey] = 1;
        hasChanges = true;
      }
      return;
    }

    updates[updateKey] = 0;
    hasChanges = true;
  });

  if (!hasChanges) {
    // Tag the DOM items for CSS to take effect
    requestAnimationFrame(tagSwipeItemsInDOM);
    return false;
  }

  skipSwipeMutation = true;
  try {
    const response = await fetchWithTimeout(
      "/cart/update.js",
      prepParams("POST", { updates })
    );
    if (!response.ok) {
      throw new Error(`Non-subscription Swipe sync failed with status ${response.status}`);
    }
    await new Promise((res) => setTimeout(res, 200));
    requestAnimationFrame(tagSwipeItemsInDOM);
    return true;
  } finally {
    skipSwipeMutation = false;
  }
}

/**
 * Find Swipe items in the DOM and tag them so CSS can hide their quantity controls.
 * Also force value to 1 if found.
 */
function tagSwipeItemsInDOM() {
  const cartContainers = document.querySelectorAll('form[action="/cart"], .cart, .cart-drawer, #rebuy-cart, .rebuy-cart');
  if (!cartContainers.length) return;

  const swipeTitles = ["Swipe", "Swipe Package Protection"];
  
  // Broad search for any element containing the title
  const allElements = document.querySelectorAll('.cart-item, .cart__item, .rebuy-cart__flyout-item, .rebuy-cart__item, tr, li');
  
  allElements.forEach(el => {
    const text = el.innerText || '';
    const isSwipe = swipeTitles.some(t => text.includes(t));
    
    if (isSwipe) {
      el.setAttribute('data-swipe-protected-item', 'true');
      
      // Force quantity input to 1 if visible
      const qtyInput = el.querySelector('input[type="number"], .quantity__input, input[name="updates[]"]');
      if (qtyInput && qtyInput.value !== "1") {
        qtyInput.value = "1";
        // If it's a real input, we might need to trigger change but that could cause loops
        // For now, just setting value is safer if we also hide it.
      }
    }
  });
}


// Fetch the Swipe product JSON (requires /products/swipe.js to exist)
async function getSwipeProductData() {
  if (productData) return productData; // cache if already fetched
  const response = await fetchWithTimeout("/products/swipe.js", prepParams("GET"));
  const result = await prepResponse(response);
  if (result.response) {
    productData = result.data;
    return productData;
  } else {
    throw new Error("Could not fetch Swipe product data.");
  }
}

// 1. Compute cart subtotal (excluding any existing Swipe protection).
// 2. Determine correct tier from variantLogic.
// 3. Return { tier, subtotal, maxTier, isAboveMaxTier }.
async function computeProtectionTier(cart = null) {
  const activeCart = cart || await getCartItem();
  const items = activeCart.items || [];

  // Exclude any Swipe wipe Package Protection items from subtotal
  let subtotal = 0;
  items.forEach((item) => {
    if (isSwipeProtectionItem(item)) {
      return;
    } else {
      subtotal += (item.final_line_price || 0) / 100;
    }
  });

  // Find the tier {title, min, max} where min subtotal < max
  const { tier, maxTier, isAboveMaxTier } = resolveTierForSubtotal(subtotal);

  return { tier, subtotal, maxTier, isAboveMaxTier };
}

function showNativeCheckoutButton(origEl) {
  if (!origEl) return;

  const fallbackDisplay = origEl.tagName.toLowerCase() === "a" ? "inline-flex" : "block";

  origEl.classList.remove("swipe-checkout-hide");
  origEl.style.setProperty(
    "display",
    fallbackDisplay,
    "important"
  );
  origEl.style.setProperty("visibility", "visible", "important");
  origEl.style.setProperty("opacity", "1", "important");
  origEl.hidden = false;
}

function hideNativeCheckoutButton(origEl) {
  if (!origEl) return;

  if (!origEl.dataset.swipeOriginalDisplay) {
    origEl.dataset.swipeOriginalDisplay = getComputedStyle(origEl).display || "block";
  }

  origEl.classList.add("swipe-checkout-hide");
  origEl.style.removeProperty("display");
  origEl.style.removeProperty("visibility");
  origEl.style.removeProperty("opacity");
}

function toggleCheckoutMode(origEl, customBox, useSwipeCustomCheckout) {
  if (useSwipeCustomCheckout) {
    hideNativeCheckoutButton(origEl);
    if (customBox) {
      customBox.style.setProperty("display", "flex", "important");
      customBox.classList.remove("swipe-custom-box-hidden");
    }
    return;
  }

  showNativeCheckoutButton(origEl);
  if (customBox) {
    customBox.style.setProperty("display", "none", "important");
    customBox.classList.add("swipe-custom-box-hidden");
  }
}

function resolveCheckoutTarget(origEl) {
  if (!origEl) return { type: "href", value: "/checkout" };

  const tagName = (origEl.tagName || "").toLowerCase();
  const formAction = origEl.getAttribute?.("formaction");
  if (formAction && formAction !== "#") {
    return { type: "href", value: formAction };
  }

  const href = origEl.getAttribute?.("href");
  if (tagName === "a" && href && href !== "#") {
    return { type: "href", value: href };
  }

  const dataHref =
    origEl.getAttribute?.("data-href") ||
    origEl.dataset?.href ||
    origEl.dataset?.checkoutUrl ||
    origEl.dataset?.checkout;
  if (dataHref && dataHref !== "#") {
    return { type: "href", value: dataHref };
  }

  const form = origEl.form || origEl.closest?.("form");
  if (form) {
    return { type: "form", value: form };
  }

  return { type: "click", value: origEl };
}

function submitCheckoutForm(form, submitter) {
  if (!form) return false;

  try {
    if (typeof form.requestSubmit === "function") {
      // Keep native submitter semantics (name/value/formaction), critical for checkout buttons.
      form.requestSubmit(submitter || undefined);
      return true;
    }
  } catch (err) {
    // Ignore and continue to fallback submission below.
  }

  try {
    if (submitter && submitter.name) {
      const hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.name = submitter.name;
      hidden.value = submitter.value || "1";
      hidden.dataset.swipeTempSubmit = "true";
      form.appendChild(hidden);
      form.submit();
      hidden.remove();
      return true;
    }

    form.submit();
    return true;
  } catch (err) {
    return false;
  }
}

function navigateToCheckoutUrl(url) {
  if (!url) return false;

  try {
    if (window.top && window.top.location) {
      window.top.location.assign(url);
      return true;
    }
  } catch (err) {
    console.warn("Top window checkout navigation failed:", err);
  }

  try {
    window.location.assign(url);
    return true;
  } catch (err) {
    console.warn("Window checkout navigation failed:", err);
  }

  try {
    window.location.href = url;
    return true;
  } catch (err) {
    console.warn("Window href checkout navigation failed:", err);
  }

  return false;
}

function isRebuyCheckoutElement(el) {
  return !!el?.closest?.(
    "#rebuy-cart, .rebuy-cart, .rebuy-cart__flyout, [data-rebuy-component]"
  );
}

function continueToCheckout(origEl) {
  const target = resolveCheckoutTarget(origEl);

  try {
    if (target.type === "href" && target.value) {
      const navigated = navigateToCheckoutUrl(target.value);
      if (navigated) {
        return;
      }
    }

    if (target.type === "form" && target.value) {
      const submitted = submitCheckoutForm(target.value, origEl);
      if (submitted) {
        return;
      }
    }

    if (target.value?.form) {
      const submitted = submitCheckoutForm(target.value.form, target.value);
      if (submitted) {
        return;
      }
    }

    if (target.value?.closest) {
      const parentForm = target.value.closest("form");
      if (parentForm) {
        const submitted = submitCheckoutForm(parentForm, target.value);
        if (submitted) {
          return;
        }
      }
    }

    if (isRebuyCheckoutElement(origEl)) {
      const navigated = navigateToCheckoutUrl("/checkout");
      if (navigated) {
        return;
      }
    }

    if (target.type === "click" && target.value) {
      target.value.click();
      return;
    }

    if (target.type === "href" && target.value) {
      navigateToCheckoutUrl(target.value);
      return;
    }
  } catch (err) {
    console.warn("continueToCheckout fallback triggered:", err);
  }

  navigateToCheckoutUrl("/checkout");
}

async function applyProtectionVariant() {

  // Prevent parallel execution (RACE CONDITION FIX)
  if (isApplyingSwipe) {
    return;
  }

  isApplyingSwipe = true;
  skipSwipeMutation = true;

  try {

    // Always fetch fresh cart
    const freshCart = await getCartItem();

    // Get Swipe product JSON
    const swipe = await getSwipeProductData();
    if (!swipe || !swipe.variants) {
      console.warn("Swipe product data not available.");
      return;
    }

    // Check existing Swipe items
    const items = freshCart.items || [];
    const existingSwipeItems = getSwipeProtectionItems(items);
    const { lines: desiredSwipeLines } = buildDesiredSwipeLines(items, swipe);

    if (!desiredSwipeLines.length) {
      if (existingSwipeItems.length) {
        const updates = buildRemoveSwipeUpdates(items);
        if (Object.keys(updates).length) {
          const response = await fetchWithTimeout(
            "/cart/update.js",
            prepParams("POST", { updates })
          );
          if (!response.ok) {
            throw new Error(`Swipe cleanup failed with status ${response.status}`);
          }
        }
      }
      return;
    }

    if (areSwipeLinesInSync(existingSwipeItems, desiredSwipeLines)) {
      return;
    }

    await syncSwipeCartLines(desiredSwipeLines);

  } catch (err) {
    console.error("applyProtectionVariant error:", err);
  } finally {

    // Always release locks
    skipSwipeMutation = false;
    isApplyingSwipe = false;
  }
}



const popupHTML = `<dialog id="swipe-modal" class="swipe-modal">

  <div class="swipe-container">
    <div class="swipe-header-logo">
    <svg id="swipe-default-logo" width="67" height="20" viewBox="0 0 67 20" fill="none" xmlns="http://www.w3.org/2000/svg">
<g clip-path="url(#clip0_914_104)">
<path d="M19.4084 13.4214C19.5385 13.304 19.6544 13.1712 19.7557 13.0241C19.8565 12.8769 19.9077 12.708 19.9077 12.5163C19.9077 12.2809 19.8241 12.0823 19.6581 11.9203C19.4915 11.7583 19.2889 11.6223 19.0502 11.5118C18.8116 11.4013 18.5619 11.3169 18.3013 11.2579C18.0408 11.1995 17.824 11.1474 17.6501 11.1033C17.1728 10.9859 16.7243 10.842 16.3044 10.6731C15.8845 10.5041 15.5195 10.2981 15.2083 10.0548C14.897 9.81202 14.6511 9.52518 14.4704 9.19373C14.2892 8.8628 14.1994 8.4692 14.1994 8.01291C14.1994 7.58638 14.2996 7.18533 14.5002 6.80979C14.7007 6.43478 14.9691 6.10332 15.3054 5.81648C15.6417 5.52965 16.037 5.30124 16.4914 5.13232C16.9452 4.96341 17.4256 4.87842 17.9321 4.87842C18.3802 4.87842 18.8074 4.94588 19.2126 5.0792C19.6173 5.21359 19.9829 5.39579 20.3087 5.62685C20.6341 5.85738 20.9088 6.13625 21.1333 6.46346C21.3573 6.79067 21.5057 7.1524 21.5782 7.54972L19.6899 8.01344C19.6032 7.66021 19.4147 7.36594 19.1259 7.13062C18.8361 6.89531 18.4387 6.77739 17.9321 6.77739C17.7588 6.77739 17.5776 6.80342 17.3896 6.85441C17.2016 6.90593 17.0277 6.98295 16.8689 7.08547C16.7096 7.18799 16.576 7.31282 16.4673 7.45995C16.3587 7.60709 16.3044 7.77548 16.3044 7.96617C16.3044 8.17174 16.366 8.34756 16.4887 8.49469C16.6115 8.64183 16.7598 8.76294 16.9337 8.85802C17.107 8.95363 17.295 9.03065 17.4977 9.08962C17.7003 9.14805 17.8883 9.19957 18.0622 9.24366C18.8288 9.43488 19.4654 9.64045 19.9719 9.86036C20.4779 10.0803 20.8832 10.3225 21.1871 10.587C21.491 10.851 21.7041 11.141 21.8273 11.4571C21.9501 11.7731 22.0117 12.129 22.0117 12.5253C22.0117 12.9949 21.9067 13.4357 21.6978 13.8469C21.4884 14.258 21.2002 14.6139 20.832 14.9145C20.4644 15.2157 20.0241 15.4505 19.5118 15.6194C18.9995 15.7883 18.4476 15.8728 17.8559 15.8728C16.9613 15.8728 16.1639 15.6481 15.4642 15.1998C14.7644 14.7509 14.2918 14.1512 14.0469 13.4007L15.8266 12.5837C16.0579 13.099 16.3545 13.4485 16.7164 13.6323C17.0778 13.8166 17.4904 13.908 17.9536 13.908C18.5322 13.908 19.0168 13.7459 19.4074 13.4225L19.4084 13.4214Z" fill="#949494"/>
<path d="M26.4834 15.6289L22.9893 5.05518H25.2249L27.6552 13.0463L30.2162 5.05518H32.0826L34.6435 12.9799L37.0525 5.05518H39.2881L35.7939 15.6289H33.4936L31.3233 9.16067L31.1499 8.14505L30.9765 9.16067L28.8281 15.6289H26.4844H26.4834Z" fill="#949494"/>
<path d="M41.8702 2.75948C41.4936 2.75948 41.1756 2.6235 40.915 2.351C40.6544 2.07904 40.5244 1.7513 40.5244 1.36885C40.5244 0.986402 40.6544 0.662382 40.915 0.397323C41.1756 0.132264 41.4936 0 41.8702 0C42.2467 0 42.5647 0.132264 42.8248 0.397323C43.0853 0.662382 43.2154 0.985871 43.2154 1.36885C43.2154 1.75183 43.0853 2.07904 42.8248 2.351C42.5642 2.6235 42.2462 2.75948 41.8702 2.75948ZM42.9553 15.6289H40.8283V5.05524H42.9334L42.9553 15.6289Z" fill="#949494"/>
<path d="M45.2979 20V5.05525H46.9517L47.3815 6.15904C47.8019 5.7325 48.2844 5.40105 48.8285 5.16573C49.3727 4.93042 49.9852 4.8125 50.6673 4.8125C51.3926 4.8125 52.0637 4.95592 52.6804 5.24276C53.2971 5.52959 53.8298 5.92373 54.2794 6.42357C54.729 6.92394 55.0805 7.51302 55.3348 8.18974C55.5886 8.867 55.7155 9.58781 55.7155 10.3532C55.7155 11.1187 55.5886 11.84 55.3348 12.5167C55.081 13.194 54.729 13.7825 54.2794 14.2829C53.8298 14.7833 53.2966 15.1769 52.6804 15.4637C52.0637 15.7506 51.3931 15.894 50.6673 15.894C49.9414 15.894 49.3325 15.7723 48.7962 15.5296C48.2593 15.2868 47.7883 14.9373 47.382 14.481V20H45.2989H45.2979ZM50.4954 6.75503C50.0745 6.75503 49.675 6.82514 49.298 6.96484C48.9204 7.10507 48.5899 7.32551 48.3068 7.62722C48.0238 7.92893 47.8024 8.30448 47.6426 8.7528C47.4828 9.20164 47.4029 9.73495 47.4029 10.3532C47.4029 11.0156 47.4828 11.5781 47.6426 12.0419C47.8024 12.5056 48.0238 12.8806 48.3068 13.1674C48.5899 13.4543 48.9204 13.6641 49.298 13.7969C49.6756 13.9291 50.0745 13.9955 50.4954 13.9955C50.9163 13.9955 51.3158 13.8999 51.6934 13.7087C52.071 13.5175 52.3973 13.2561 52.6736 12.9252C52.9498 12.5943 53.1671 12.2076 53.3269 11.7662C53.4867 11.3248 53.5666 10.8541 53.5666 10.3532C53.5666 9.85234 53.4867 9.38171 53.3269 8.9403C53.1671 8.49889 52.9493 8.11644 52.6736 7.79242C52.3973 7.46893 52.071 7.21503 51.6934 7.03071C51.3158 6.84692 50.9169 6.75503 50.4954 6.75503Z" fill="#949494"/>
<path d="M62.4649 15.894C61.7124 15.894 61.0074 15.7506 60.3489 15.4637C59.6903 15.1769 59.1154 14.7833 58.6235 14.2829C58.1315 13.7831 57.7446 13.194 57.4621 12.5167C57.1801 11.84 57.0391 11.1187 57.0391 10.3532C57.0391 9.58781 57.1728 8.867 57.4406 8.18974C57.708 7.51302 58.0699 6.92447 58.5258 6.42357C58.9817 5.9232 59.5133 5.52959 60.1212 5.24276C60.729 4.95592 61.3797 4.8125 62.0742 4.8125C62.7688 4.8125 63.4377 4.93786 64.0383 5.18804C64.6383 5.43823 65.1595 5.82812 65.6007 6.35823C66.042 6.88782 66.3856 7.56136 66.6316 8.37831C66.8776 9.19527 67.0008 10.17 67.0008 11.303H59.2747C59.3754 11.686 59.5352 12.0424 59.752 12.3739C59.9692 12.7048 60.2256 12.9921 60.5222 13.2349C60.8188 13.4776 61.1515 13.6652 61.5202 13.7979C61.8894 13.9302 62.2758 13.9966 62.6816 13.9966C63.231 13.9966 63.7411 13.8941 64.2117 13.6875C64.6817 13.4814 65.0832 13.2094 65.4159 12.8705L66.7183 14.1953C66.2117 14.7105 65.5929 15.1222 64.8629 15.4313C64.1323 15.7405 63.3328 15.895 62.4649 15.895V15.894ZM62.0742 6.75503C61.7411 6.75503 61.4267 6.82142 61.1301 6.95369C60.8335 7.08595 60.5583 7.27027 60.3055 7.50558C60.0522 7.74143 59.835 8.02083 59.6543 8.34432C59.4731 8.66834 59.3394 9.02157 59.2527 9.40402H64.7433C64.714 9.05079 64.6347 8.71243 64.5046 8.38841C64.3746 8.06492 64.1934 7.78127 63.9621 7.53852C63.7302 7.29577 63.4592 7.10454 63.1479 6.96431C62.8367 6.82461 62.4784 6.7545 62.0737 6.7545L62.0742 6.75503Z" fill="#949494"/>
<path d="M9.09227 11.6514C9.18 12.3063 8.97947 12.8689 8.45464 13.2901C7.02378 14.439 5.58769 15.5811 4.15108 16.722C3.41894 17.3032 2.34736 17.1741 1.78128 16.4442C1.18648 15.6777 1.29353 14.6122 2.04134 14.0077C3.08054 13.1679 4.12863 12.3387 5.17514 11.508C5.82739 10.9895 5.92034 10.1806 5.39917 9.53199C5.36366 9.4879 5.12501 9.27384 5.10099 9.22072C5.16261 9.21912 5.45505 9.35245 5.50936 9.3721C6.35639 9.68444 7.20655 9.9888 8.04575 10.3224C8.62698 10.5534 8.96798 11.0092 9.09174 11.6519L9.09227 11.6514Z" fill="#949494"/>
<path d="M0.0199006 8.34823C-0.0678313 7.69328 0.132699 7.13076 0.657523 6.70953C2.08839 5.56059 3.52448 4.41855 4.96109 3.27758C5.69323 2.69647 6.76481 2.82554 7.33089 3.55539C7.92569 4.32188 7.81864 5.38743 7.07083 5.99191C6.03162 6.83171 4.98354 7.66088 3.93702 8.49164C3.28478 9.01008 3.19183 9.81906 3.713 10.4676C3.74851 10.5117 3.98716 10.7258 4.01118 10.7789C3.94956 10.7805 3.65712 10.6472 3.60281 10.6275C2.75578 10.3152 1.90561 10.0108 1.06642 9.67724C0.485193 9.44618 0.144187 8.99042 0.0204228 8.34769L0.0199006 8.34823Z" fill="#949494"/>
</g>
<defs>
<clipPath id="clip0_914_104">
<rect width="67" height="20" fill="white"/>
</clipPath>
</defs>
</svg>

<img id="swipe-merchant-logo" class="merchen_logo_db" />


      <div class="close">
        <img src="https://swipe.ai/wp-content/uploads/2025/12/Vector.png" alt="remove" width="14" height="14" />
      </div>
    </div>

    <!-- Protection shield -->
    <div class="swipe-shield">
      <svg viewBox="0 0 64 76" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="swipeShieldGrad" x1="50" y1="9" x2="14" y2="68" gradientUnits="userSpaceOnUse">
            <stop stop-color="#85ADEE"/>
            <stop offset="0.52" stop-color="#BAC5EC"/>
            <stop offset="1" stop-color="#EFDEE8"/>
          </linearGradient>
        </defs>
        <path d="M32 2C22.8 8.8 14.2 11.8 2.5 13.2v23.1C2.5 54 13.6 65.1 32 74.5 50.4 65.1 61.5 54 61.5 36.3V13.2C49.8 11.8 41.2 8.8 32 2Z"
          stroke="url(#swipeShieldGrad)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="m21.5 35.2 9 8.8L47 27.5"
          stroke="url(#swipeShieldGrad)" stroke-width="4.2" stroke-linecap="square" stroke-linejoin="miter"/>
      </svg>
    </div>

    <h1 class="swipe-hero-title">
      <span class="swipe-hero-lead">Protected by</span><span class="swipe-hero-brand">swipe</span>
    </h1>

    <p class="swipe-hero-sub">Shipping protection you can count on</p>

    <div class="swipe-feature-grid">
      <div class="swipe-feature-cell">
        <div class="swipe-feature-icon">
          <svg class="swipe-icon-pkg" viewBox="0 0 60 55" fill="none" xmlns="http://www.w3.org/2000/svg">
            <g stroke="#85ADEE" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2.2 13.8 25.8 2.1Q27 1.5 28.3 2.1l23.9 11.7-25.1 12.3L2.2 13.8Z"/>
              <path d="M2.2 13.8v28.1L27 53.5 41.8 46M27.1 26.1v27.4M52.2 13.8v12.8"/>
              <path d="m9.1 17.1 13.5-6 10.1 4.8-13.2 6.3-10.4-5.1Z"/>
              <path d="M9.1 17.1v14.5l4.6-2.5 5.8 7.4V22.2"/>
              <path d="m32.1 39.5 4.5-2.2M32.1 44.3l6-3"/>
              <path d="M46.9 24.8c3.2 1.7 6.8 3 10.5 4.2v4.5c0 7.3-3.8 12.5-10.5 14.7-6.7-2.2-10.5-7.4-10.5-14.7V29c3.7-1.2 7.3-2.5 10.5-4.2Z" fill="#fff"/>
              <path d="m44.1 35.7 2.8 3.6 5.7-7.3"/>
            </g>
          </svg>
        </div>
        <h3>Lost, stolen<br>or damaged.</h3>
        <p>You&#39;re covered.</p>
      </div>

      <div class="swipe-feature-divider"></div>

      <div class="swipe-feature-cell">
        <div class="swipe-feature-icon">
          <svg class="swipe-icon-bolt" viewBox="1.45 0.85 14.1 20.3" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M11.6 1.4 2 12.8h5.4l-2 7.8 9.6-11.4H9.6z" fill="none" stroke="#85ADEE" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h3>Fast &amp; easy<br>claims</h3>
        <p>Resolved in<br>less than 24 hrs.</p>
      </div>
    </div>

    <div class="swipe-assurance">
      <svg viewBox="1.36 1.36 21.28 21.28" fill="none" xmlns="http://www.w3.org/2000/svg">
        <g fill="none" stroke="#85ADEE" stroke-width="1.28" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="m7.9 12.3 2.7 2.7 5.5-5.9"/>
        </g>
      </svg>
      <div class="swipe-assurance-text">
        <strong>If something goes wrong, we&#39;ll make it right.</strong>
        <span>Refund or reorder &ndash; your choice.</span>
      </div>
    </div>

    <div class="swipe-trust">
      <span>Secure</span><i>&middot;</i><span>Private</span><i>&middot;</i><span>Trusted</span>
    </div>

    <div class="swipe-popup-legal">
      <div class="footer-terms-policy">By adding Swipe Protection, you agree to our
      <a href="https://swipe.ai/privacy-policy" target="_blank" rel="noopener noreferrer">Terms and Privacy Policy</a>.
      Coverage is subject to Swipe&#39;s
      <a href="https://swipe.ai/claims-policy" target="_blank" rel="noopener noreferrer">Claims Policy</a>.
</div>
<div class="footer-fileclaim">
Need help with a protected order? <a href="https://swipe.ai/file-a-claim" target="_blank" rel="noopener noreferrer"> File a Claim </a></div>
    </div>
  </div>
</dialog>
`;


async function verifySwipeBeforeCheckout() {

  // Prevent parallel execution
  if (isApplyingSwipe) return;

  isApplyingSwipe = true;
  skipSwipeMutation = true;

  try {
    const cart = await getCartItem();
    const items = cart.items || [];
    const swipe = await getSwipeProductData().catch(() => null);

    if (!swipe || !swipe.variants?.length) {
      return;
    }

    const { lines: desiredSwipeLines } = buildDesiredSwipeLines(items, swipe);
    await syncSwipeCartLines(desiredSwipeLines);
    await new Promise((res) => setTimeout(res, 300));

  } catch (err) {
    console.error("verifySwipeBeforeCheckout error:", err);
  } finally {
    skipSwipeMutation = false;
    isApplyingSwipe = false;
  }
}



// Remove Swipe protection ONLY when it's the only item in the cart
async function removeSwipeIfCartEmpty() {
try {
 const cart = await getCartItem();
 const items = cart.items || [];

 // Skip if no items
 if (!items.length) return;

 // Check if any other item exists
 const hasOther = items.some(
 (i) => !isSwipeProtectionItem(i)
 );

 if (hasOther) return; // there are other products ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â do nothing

 // Only Swipe left ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â remove all Swipe lines
 const updates = buildRemoveSwipeUpdates(items);
 if (Object.keys(updates).length) {
 console.log("ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â§ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âº Removing Swipe Protection (only item left)");
 // FIX 5: Mute interceptors during update
 skipSwipeMutation = true;
 await fetch("/cart/update.js", prepParams("POST", { updates }));
 skipSwipeMutation = false;
 }
} catch (err) {
 console.error("removeSwipeIfCartEmpty error:", err);
} finally {
   skipSwipeMutation = false;
 }
}

// Helper to remove any existing Swipe protection before plain checkout:
async function removeExistingProtectionIfAny() {
 const cart = await getCartItem();
 const items = cart.items || [];
 const updates = buildRemoveSwipeUpdates(items);
 if (Object.keys(updates).length) {
    // FIX: Mute interceptors during update
    skipSwipeMutation = true;
    const response = await fetchWithTimeout(
      "/cart/update.js",
      prepParams("POST", { updates })
    );
    if (!response.ok) {
      throw new Error(`Remove protection failed with status ${response.status}`);
    }
    // FIX: Unmute
    skipSwipeMutation = false;
 }
}
// ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ Remove Swipe protection ONLY when Loop Onstore is ACTIVE
async function removeSwipeIfLoopActive() {
try {
 // Exit early if Loop is not active or undefined
 if (typeof LoopOnstore === "undefined" || !LoopOnstore.isActive()) return;

 const cart = await getCartItem();
 const items = cart.items || [];

 const updates = buildRemoveSwipeUpdates(items);
 if (Object.keys(updates).length) {
 console.log("Removing Swipe due to active Loop Onstore");
 // FIX 6: Mute interceptors during update
 skipSwipeMutation = true;
 await fetch("/cart/update.js", prepParams("POST", {
  updates
 }));
 skipSwipeMutation = false;
 }
} catch (err) {
 console.error("removeSwipeIfLoopActive error:", err);
} finally {
   skipSwipeMutation = false;
 }
}

const modalCSS = document.createElement("style");
modalCSS.textContent = `
/* ---------- dialog shell ---------- */
.swipe-modal,
dialog.swipe-modal {
  border: none;
  outline: none;
  margin: 0;
  padding: 16px;
  width: 100vw;
  max-width: 100vw;
  height: 100vh;
  max-height: 100vh;
  box-sizing: border-box;
  background: transparent;
  background-color: transparent;
  display: flex;
  justify-content: center;
  align-items: center;
  overflow: auto;
}
.swipe-modal::backdrop {
  background: rgba(24, 24, 27, 0.62);
}

/* ---------- card ---------- */
.swipe-modal .swipe-container {
  width: 100%;
  max-width: 400px;
  height: 560px !important;
  min-height: 0 !important;
  padding: 16px 41px 20px !important;
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.18);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0 !important;
  text-align: center;
  position: relative;
}

/* ---------- popup font lock ---------- */
.swipe-modal .swipe-container,
.swipe-modal .swipe-container * {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Poppins", Roboto, "Helvetica Neue", Arial, sans-serif !important;
  font-style: normal !important;
  text-transform: none !important;
  font-variant: normal !important;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ---------- close ---------- */
.swipe-modal .close {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 3;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: .45;
  cursor: pointer;
  transition: opacity .15s ease;
}
.swipe-modal .close:hover { opacity: .8; }
.swipe-modal .close::before,
.swipe-modal .close::after {
  content: "";
  position: absolute;
  width: 14px;
  height: 1.5px;
  border-radius: 999px;
  background: #6F6F6F;
}
.swipe-modal .close::before { transform: rotate(45deg); }
.swipe-modal .close::after { transform: rotate(-45deg); }
.swipe-modal .close img { display: none; }

/* ---------- logo ---------- */
.swipe-modal .swipe-header-logo {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  margin: 0 0 16px;
}
.swipe-modal .swipe-header-logo svg#swipe-default-logo {
  width: 96px;
  height: 29px;
}
.swipe-modal .swipe-header-logo svg#swipe-default-logo path {
  fill: #111111 !important;
}
.swipe-modal #swipe-merchant-logo {
  height: 32px !important;
  max-height: 40px !important;
  width: auto !important;
  max-width: 170px !important;
  margin: 0 auto !important;
  padding: 0 !important;
  object-fit: contain;
  display: block;
}

/* ---------- shield ---------- */
.swipe-modal .swipe-shield { line-height: 0; margin: 0 0 18px; }
.swipe-modal .swipe-shield svg { width: 60px; height: 75px; display: block; }

/* ---------- hero ---------- */
.swipe-modal .swipe-hero-title,
.swipe-modal .swipe-hero-title *,
.swipe-modal .swipe-hero-sub {
  font-family: "Inter", Arial, sans-serif !important;
}
.swipe-modal .swipe-hero-title {
  margin: 0;
  padding: 0;
  color: #000;
  font-size: 28px !important;
  font-weight: 600 !important;
  line-height: 1.16 !important;
  letter-spacing: -0.7px !important;
  display: flex;
  align-items: baseline;
  justify-content: center;
  flex-wrap: wrap;
  column-gap: 5px;
  row-gap: 0;
}
.swipe-modal .swipe-hero-lead { font-weight: 600 !important; }
.swipe-modal .swipe-hero-brand {
  font-weight: 600 !important;
  letter-spacing: -0.7px !important;
  white-space: nowrap;
}
.swipe-modal .swipe-hero-sub {
  margin: 7px 0 13px;
  color: #848281;
  font-size: 11.2px !important;
  font-weight: 400 !important;
  line-height: 1.4 !important;
  letter-spacing: 0 !important;
}

/* ---------- features ---------- */
.swipe-modal .swipe-feature-grid {
  display: flex;
  align-items: stretch;
  width: 100%;
  height: 143px;
  box-sizing: border-box;
  border: 1px solid #EFEFEF;
  border-radius: 14px;
  padding: 24px 5px 9px;
}
.swipe-modal .swipe-feature-cell {
  flex: 1 1 0;
  min-width: 0;
  padding: 0 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.swipe-modal .swipe-feature-divider {
  width: 1px;
  flex: 0 0 1px;
  background: #E2E2E2;
  align-self: center;
  height: 96px;
}
.swipe-modal .swipe-feature-icon {
  height: 40px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  margin-bottom: 7px;
}
.swipe-modal .swipe-icon-pkg { width: 45px; height: 40px; display: block; }
.swipe-modal .swipe-icon-bolt { width: 24px; height: 39px; display: block; }
.swipe-modal .swipe-feature-cell h3 {
  margin: 0;
  padding: 0;
  color: #222;
  font-size: 11.2px !important;
  font-weight: 700 !important;
  line-height: 1.25 !important;
  letter-spacing: -0.1px !important;
}
.swipe-modal .swipe-feature-cell p {
  margin: 4px 0 0;
  padding: 0;
  color: #9E9E9E;
  font-size: 9.5px !important;
  font-weight: 400 !important;
  line-height: 1.25 !important;
}

/* ---------- assurance ---------- */
.swipe-modal .swipe-assurance {
  display: flex;
  align-items: center;
  gap: 15px;
  width: 100%;
  height: 65px;
  box-sizing: border-box;
  background: #E0EBFB;
  border-radius: 12px;
  padding: 12px 17px;
  margin-top: 9px;
  text-align: left;
}
.swipe-modal .swipe-assurance svg {
  width: 29px;
  height: 29px;
  flex: 0 0 29px;
  display: block;
}
.swipe-modal .swipe-assurance-text { min-width: 0; }
.swipe-modal .swipe-assurance strong {
  display: block;
  color: #222;
  font-size: 10px !important;
  font-weight: 700 !important;
  line-height: 1.25 !important;
}
.swipe-modal .swipe-assurance span {
  display: block;
  margin-top: 1px;
  color: #767676;
  font-size: 10px !important;
  font-weight: 400 !important;
  line-height: 1.25 !important;
}

/* ---------- footer ---------- */
.swipe-modal .swipe-trust {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 13px;
  width: 100%;
  box-sizing: border-box;
  margin-top: 13px;
  padding-top: 14px;
  border-top: 1px solid #EDEDED;
  color: #848281;
  font-size: 9.5px !important;
  font-weight: 400 !important;
  letter-spacing: 0.2px !important;
}
.swipe-modal .swipe-trust i { font-style: normal !important; color: #C9C9C9; }
.swipe-modal .swipe-popup-legal {
  width: 100%;
  box-sizing: border-box;
  margin-top: 10px;
  color: #848281;
  font-size: 8px !important;
  font-weight: 400 !important;
  line-height: 1.2 !important;
  letter-spacing: 0 !important;
  text-align: center;
}
.swipe-modal .swipe-popup-legal a {
  color: #848281 !important;
  font-weight: 700 !important;
  text-decoration: underline !important;
  text-underline-offset: 2px;
  cursor: pointer;
  pointer-events: auto !important;
  position: relative;
  z-index: 2;
}

@media only screen and (max-width: 480px) {
  .swipe-modal .swipe-container {
    max-width: 100%;
    height: auto !important;
    padding: 18px 22px 18px !important;
    border-radius: 22px;
  }
  .swipe-modal .swipe-hero-title { font-size: 27px !important; column-gap: 5px; }
  .swipe-modal .swipe-hero-sub { font-size: 13px !important; }
  .swipe-modal .swipe-feature-cell { padding: 0 4px; }
  .swipe-modal .swipe-icon-pkg { width: 46px; height: 40px; }
  .swipe-modal .swipe-icon-bolt { width: 26px; height: 38px; }
  .swipe-modal .swipe-feature-icon { height: 40px; }
}`;
document.head.appendChild(modalCSS);


// Show Processing on a button/link and disable further clicks:
function showLoadingOnElement(el) {

  if (!el.dataset.originalText) {
    el.dataset.originalText =
      el.tagName.toLowerCase() === "input"
        ? el.value
        : el.innerHTML;
  }

  el.classList.add("loading-overlay");

  if (el.tagName.toLowerCase() === "input") {
    el.value = "TAKING YOU TO CHECKOUT...";
  } else {
    el.innerHTML = "TAKING YOU TO CHECKOUT...";
  }
}

function restoreElementLoadingState(el) {
  if (!el) return;

  el.classList.remove("loading-overlay");

  if (el.tagName.toLowerCase() === "input") {
    el.value = el.dataset.originalText || el.value;
    return;
  }

  if (el.dataset.originalText) {
    el.innerHTML = el.dataset.originalText;
  }
}


/* =====================================================
   SWIPE POPUP TRUE MODAL SYSTEM (NO Z-INDEX NEEDED)
===================================================== */

function ensureSwipeModal() {

  if (!document.querySelector("#swipe-modal")) {
    document.body.insertAdjacentHTML("beforeend", popupHTML);
  }

  const logo = document.getElementById("swipe-merchant-logo");
const defaultLogo = document.getElementById("swipe-default-logo");

if (!logo) return;

if (showLogo && merchantLogo) {

  // DB logo show
  logo.src = merchantLogo;
  logo.style.display = "block";

  // hide default svg
  if (defaultLogo) defaultLogo.style.display = "none";

} else {

  // hide DB logo
  logo.style.display = "none";

  // show default svg
  if (defaultLogo) defaultLogo.style.display = "block";
}
}
function openSwipePopup(e) {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  ensureSwipeModal();

  const modal = document.getElementById("swipe-modal");
  if (!modal.open) modal.showModal(); // ALWAYS ABOVE SHOPIFY DRAWER
}
function closeSwipePopup() {
  const modal = document.getElementById("swipe-modal");
  if (!modal) return;

  // Close dialog
  if (modal.open) modal.close();

  // Remove dialog from DOM completely
  modal.remove();
}

function handleSwipePopupOutsideClick(e) {
  const modal = document.getElementById("swipe-modal");
  if (!modal || !modal.open) return;

  const clickedInsidePopup = e.target.closest(".swipe-container");
  const clickedPopupTrigger = e.target.closest(".swipe-popupbtn-icon");

  if (clickedPopupTrigger) return;

  if (!clickedInsidePopup || e.target === modal) {
    closeSwipePopup();
  }
}

/* Close when clicking X or Backdrop */
document.addEventListener("click", (e) => {
  const modal = document.getElementById("swipe-modal");
  if (!modal || !modal.open) return;

  if (e.target.closest(".close")) {
    closeSwipePopup();
    return;
  }

  // Backdrop click (clicking outside .swipe-container)
  if (e.target === modal) {
    closeSwipePopup();
  }
});

document.addEventListener("pointerdown", handleSwipePopupOutsideClick, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSwipePopup();
  }
});

/* Open modal on any "pw-learn-more" click */
document.addEventListener("click", (e) => {
  const trigger = e.target.closest(".swipe-popupbtn-icon");
  if (trigger) {
    openSwipePopup(e);
  }
});




async function replaceNativeWithCustom() {

const cart = await getCartItem();
  await removeSwipeIfCartEmpty();

  removeSwipeIfLoopActive();
  const swipe = await getSwipeProductData().catch(() => null);
  const {
    lines: desiredSwipeLines,
    totalProtectionAmount,
    hasAboveMaxTier,
  } = buildDesiredSwipeLines(cart.items || [], swipe);
  const shouldUseSwipeCustomCheckout = desiredSwipeLines.length > 0;

  if (hasAboveMaxTier && !desiredSwipeLines.length) {
    const updates = buildRemoveSwipeUpdates(cart.items || []);
    if (Object.keys(updates).length) {
    skipSwipeMutation = true;
    try {
      await fetch(
        "/cart/update.js",
          prepParams("POST", { updates })
      );
    } catch (err) {
      console.error("Error removing protection above max tier:", err);
    } finally {
      skipSwipeMutation = false;
    }
    }
  }

  // 1. Calculations
  const protectionAmount = totalProtectionAmount;

  // The total shown on the 'Checkout + Protection' button will always be the current cart total
  const totalWithProtection = cart.total_price / 100;

  const formattedTotal = new Intl.NumberFormat(navigator.language, {
    style: "currency",
    currency: cart.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(totalWithProtection);

  // Checkout Selectors (Wohi rahen ge)
  const checkoutSelectors = CHECKOUT_SELECTOR_LIST;

  checkoutSelectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(origEl => {
      // Check if this element has already been processed by Swipe
      if (origEl.dataset.swipeInjected) {
        // ********************************************
        // UPDATING EXISTING BUTTONS (REFRESH LOGIC) - FIXED
        // ********************************************
        const customBox = origEl.nextElementSibling;
        if (!customBox || !customBox.classList.contains("swipe-custom-box")) return;
       
        // 1. Update Protection Fee display (pw-learn-more strong)
        const learnMoreSpan = customBox.querySelector(".pw-learn-more .protection-price");
        if (learnMoreSpan) {
          learnMoreSpan.innerHTML = moneyFormat(protectionAmount);
        }

        // 2. Update Protection Button Text (.protectfee)
        const protectFeeSpan = customBox.querySelector(".swipe-btn-protection span.protectfee");
        if (protectFeeSpan) {
          protectFeeSpan.innerHTML = `Checkout +  ${moneyFormat(protectionAmount)} protection fee`;
        }
       
        // 3. Update Total Price Button Text (.cartfee)
        const cartFeeSpan = customBox.querySelector(".swipe-btn-protection span.cartfee");
        if (cartFeeSpan) {
          cartFeeSpan.textContent = `Checkout +  ${formattedTotal}`;
        }

        toggleCheckoutMode(origEl, customBox, shouldUseSwipeCustomCheckout);
        return; // Go to next element after updating prices
      }

      // Hide the original element and mark it as processed
      origEl.dataset.swipeInjected = "true";

      // Build custom box (Injection)
      const box = document.createElement("div");
      box.className = "swipe-custom-box";
      box.style.cssText = "margin:1rem 0; display:flex; gap:1rem; align-items:center;";

      box.innerHTML = `
        <div class="swipe-info-box">
          <span class="pw-learn-more post_protect">
           <span class="newprotecttext"> <svg width="9" height="15" viewBox="0 0 113 173" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M112.245 106.05C113.328 113.999 110.852 120.825 104.374 125.937C86.7106 139.881 68.9831 153.74 51.2492 167.587C42.2114 174.639 28.9835 173.073 21.9957 164.216C14.6533 154.914 15.9748 141.982 25.2059 134.646C38.0342 124.455 50.972 114.392 63.8905 104.31C71.942 98.0181 73.0894 88.2003 66.656 80.3293C66.2176 79.7943 63.2716 77.1964 62.9751 76.5517C63.7358 76.5324 67.3457 78.1504 68.0161 78.389C78.4721 82.1794 88.9668 85.8732 99.3261 89.9215C106.501 92.7256 110.71 98.2566 112.238 106.057L112.245 106.05Z" fill="black"/>
<path d="M0.245658 65.9603C-0.837329 58.012 1.63807 51.1853 8.11665 46.0733C25.7797 32.1299 43.5071 18.2702 61.241 4.42344C70.2788 -2.62886 83.5067 -1.0624 90.4946 7.79488C97.837 17.097 96.5155 30.0283 87.2843 37.3643C74.456 47.556 61.5182 57.6187 48.5997 67.7008C40.5482 73.9925 39.4008 83.8102 45.8343 91.6812C46.2726 92.2163 49.2186 94.8142 49.5151 95.4588C48.7544 95.4781 45.1445 93.8601 44.4741 93.6216C34.0181 89.8311 23.5234 86.1374 13.1641 82.0891C5.98936 79.2849 1.77989 73.754 0.252104 65.9539L0.245658 65.9603Z" fill="black"/>
</svg> &nbsp;
 Package Protection • &nbsp;<div class="protection-price">${moneyFormat(protectionAmount)}</div></span>
        <span class="oldprotect">Swipe Package Protection</span>
            <svg  class="swipe-popupbtn-icon" width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M5 8.75C7.07107 8.75 8.75 7.07107 8.75 5C8.75 2.92893 7.07107 1.25 5 1.25C2.92893 1.25 1.25 2.92893 1.25 5C1.25 7.07107 2.92893 8.75 5 8.75ZM5 10C7.76142 10 10 7.76142 10 5C10 2.23858 7.76142 0 5 0C2.23858 0 0 2.23858 0 5C0 7.76142 2.23858 10 5 10Z" fill="#999999"/>
              <path fill-rule="evenodd" clip-rule="evenodd" d="M4.375 7.5V4.375H5.625V7.5H4.375Z" fill="#999999"/>
              <circle cx="5" cy="3.125" r="0.625" fill="#999999"/>
            </svg>
          </span>

     <div class="swipe-benefits-expand"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="256" height="256" viewBox="0 0 256 256" xml:space="preserve">
<g style="stroke: none; stroke-width: 0; stroke-dasharray: none; stroke-linecap: butt; stroke-linejoin: miter; stroke-miterlimit: 10; fill: none; fill-rule: nonzero; opacity: 1;" transform="translate(1.4065934065934016 1.4065934065934016) scale(2.81 2.81)">
  <path d="M 90 24.25 c 0 -0.896 -0.342 -1.792 -1.025 -2.475 c -1.366 -1.367 -3.583 -1.367 -4.949 0 L 45 60.8 L 5.975 21.775 c -1.367 -1.367 -3.583 -1.367 -4.95 0 c -1.366 1.367 -1.366 3.583 0 4.95 l 41.5 41.5 c 1.366 1.367 3.583 1.367 4.949 0 l 41.5 -41.5 C 89.658 26.042 90 25.146 90 24.25 z" style="stroke: none; stroke-width: 1; stroke-dasharray: none; stroke-linecap: butt; stroke-linejoin: miter; stroke-miterlimit: 10; fill: rgb(0,0,0); fill-rule: nonzero; opacity: 1;" transform=" matrix(1 0 0 1 0 0) " stroke-linecap="round"/>
</g>
</svg></div>

          <ul class="swipe-benefits">
<h4>Benefits</h4>
        <li><svg  class="swipe-benefits-tick" xmlns="http://www.w3.org/2000/svg" width="12" height="8" viewBox="0 0 12 8" fill="none">
  <path d="M11.6328 0.166799C11.653 0.178173 11.6733 0.189548 11.6941 0.201267C11.7764 0.266927 11.8333 0.340538 11.89 0.422851C11.8998 0.436993 11.9096 0.451136 11.9197 0.465706C12.0201 0.638679 12.0152 0.856161 11.9657 1.04121C11.8431 1.34076 11.5224 1.56265 11.2618 1.78179C11.2348 1.80458 11.2078 1.82736 11.1808 1.85015C11.1074 1.91209 11.0339 1.97397 10.9604 2.03583C10.8809 2.10282 10.8014 2.16986 10.7219 2.2369C10.5665 2.36792 10.4111 2.49889 10.2556 2.62984C10.1292 2.73627 10.0029 2.84272 9.87653 2.94918C9.51796 3.25132 9.15934 3.55343 8.80065 3.85548C8.78136 3.87173 8.76206 3.88798 8.74218 3.90472C8.72286 3.92099 8.70354 3.93726 8.68364 3.95402C8.37009 4.21807 8.05666 4.48222 7.74328 4.74641C7.42114 5.01798 7.09891 5.28948 6.77659 5.56091C6.59578 5.71317 6.415 5.86547 6.23431 6.01785C6.08061 6.14747 5.92682 6.27703 5.77293 6.4065C5.69445 6.47252 5.61601 6.53858 5.53768 6.60472C5.46592 6.6653 5.39406 6.72579 5.32211 6.78621C5.29615 6.80804 5.27024 6.82991 5.24436 6.85181C4.98346 7.07256 4.72763 7.26558 4.33898 7.27972C3.89734 7.26445 3.65244 7.06806 3.35785 6.81841C3.32349 6.78959 3.28912 6.76079 3.25473 6.732C3.16184 6.65412 3.06924 6.57601 2.97671 6.49783C2.87959 6.41584 2.78224 6.33404 2.68493 6.25221C2.52159 6.1148 2.35844 5.97722 2.19541 5.83954C2.00722 5.68063 1.8187 5.52201 1.63001 5.36353C1.46767 5.22718 1.30552 5.09067 1.14352 4.95403C1.04691 4.87255 0.950238 4.79112 0.8534 4.70983C0.762346 4.63337 0.671526 4.55673 0.580878 4.47994C0.547679 4.45187 0.5144 4.42388 0.481035 4.39595C0.232608 4.18792 0.00745816 3.99594 0 3.68344C0.000726532 3.43362 0.0553093 3.24781 0.26617 3.06216C0.486969 2.88762 0.730569 2.81904 1.02902 2.82157C1.37107 2.83987 1.59747 3.0096 1.8276 3.2061C1.85457 3.22884 1.88156 3.25155 1.90857 3.27426C1.9814 3.33556 2.05393 3.39711 2.12641 3.4587C2.20238 3.52317 2.27861 3.58741 2.35481 3.65168C2.49887 3.77324 2.64268 3.895 2.78642 4.01684C2.95015 4.15561 3.11415 4.29415 3.27817 4.43268C3.61538 4.71749 3.95226 5.00257 4.28891 5.28785C4.37129 5.25821 4.42415 5.21818 4.48713 5.16494C4.50809 5.14731 4.52906 5.12969 4.55066 5.11153C4.57383 5.09185 4.59701 5.07216 4.62017 5.05248C4.64485 5.03165 4.66955 5.01084 4.69425 4.99003C4.76217 4.93276 4.82996 4.87537 4.89772 4.81795C4.9708 4.75608 5.04401 4.69432 5.11721 4.63254C5.2441 4.52544 5.3709 4.41827 5.49765 4.31105C5.68115 4.15585 5.86483 4.00079 6.04855 3.84578C6.34692 3.59403 6.64522 3.34223 6.94345 3.09036C6.9613 3.07528 6.97916 3.0602 6.99756 3.04466C7.25073 2.83083 7.50383 2.61695 7.75691 2.40304C7.77471 2.38799 7.79252 2.37294 7.81086 2.35744C7.83754 2.33489 7.83754 2.33489 7.86475 2.31189C8.16157 2.06101 8.45856 1.81029 8.75571 1.5597C8.93892 1.40517 9.12198 1.25052 9.30485 1.0957C9.43028 0.989528 9.55588 0.883499 9.68161 0.77758C9.7541 0.71651 9.8265 0.655379 9.8987 0.594072C9.96491 0.537852 10.0313 0.48182 10.0979 0.425927C10.1219 0.405768 10.1457 0.385543 10.1695 0.365244C10.5965 0.000920892 11.1059 -0.137011 11.6328 0.166799Z" fill="#434343"/>
</svg> Post purchase protection by <svg style="margin: 8px 5px;" xmlns="http://www.w3.org/2000/svg" width="38" height="11" viewBox="0 0 38 11" fill="none">
  <g clip-path="url(#clip0_6219_423)">
    <path d="M11.0057 7.38174C11.0795 7.31718 11.1452 7.24414 11.2027 7.16321C11.2599 7.08229 11.2889 6.98938 11.2889 6.88392C11.2889 6.7545 11.2415 6.64523 11.1473 6.55613C11.0528 6.46702 10.9379 6.39223 10.8026 6.33146C10.6672 6.2707 10.5256 6.22425 10.3778 6.19182C10.23 6.15968 10.1071 6.13105 10.0085 6.1068C9.73778 6.04224 9.48336 5.96306 9.24523 5.87016C9.0071 5.77726 8.80007 5.6639 8.62355 5.5301C8.44703 5.39659 8.30752 5.23883 8.20505 5.05653C8.10227 4.87452 8.05133 4.65803 8.05133 4.40708C8.05133 4.17248 8.1082 3.95191 8.22193 3.74536C8.33566 3.5391 8.4879 3.3568 8.67864 3.19904C8.86938 3.04128 9.09359 2.91566 9.35127 2.82275C9.60865 2.72985 9.88113 2.68311 10.1684 2.68311C10.4226 2.68311 10.6648 2.72021 10.8947 2.79354C11.1242 2.86745 11.3315 2.96766 11.5163 3.09474C11.7009 3.22154 11.8567 3.37491 11.984 3.55488C12.1111 3.73484 12.1952 3.9338 12.2364 4.15232L11.1654 4.40737C11.1162 4.21309 11.0093 4.05124 10.8455 3.92182C10.6811 3.7924 10.4557 3.72754 10.1684 3.72754C10.0701 3.72754 9.96732 3.74185 9.8607 3.7699C9.75407 3.79824 9.65544 3.8406 9.5654 3.89699C9.47507 3.95337 9.39925 4.02203 9.33764 4.10295C9.27604 4.18388 9.24523 4.27649 9.24523 4.38137C9.24523 4.49443 9.28018 4.59113 9.34978 4.67206C9.41939 4.75298 9.5035 4.81959 9.60213 4.87189C9.70046 4.92447 9.80709 4.96684 9.92201 4.99926C10.0369 5.0314 10.1435 5.05974 10.2422 5.08399C10.677 5.18916 11.038 5.30222 11.3253 5.42317C11.6123 5.54412 11.8421 5.67734 12.0145 5.82283C12.1869 5.96803 12.3077 6.12754 12.3776 6.30137C12.4472 6.4752 12.4822 6.67094 12.4822 6.88889C12.4822 7.14714 12.4227 7.38963 12.3042 7.61575C12.1854 7.84188 12.0219 8.03762 11.8131 8.20297C11.6046 8.36862 11.3549 8.49775 11.0644 8.59065C10.7738 8.68356 10.4608 8.73001 10.1252 8.73001C9.61783 8.73001 9.16556 8.60643 8.76868 8.35986C8.3718 8.11299 8.10375 7.78315 7.96484 7.37035L8.97423 6.92102C9.10544 7.20441 9.27367 7.39664 9.47892 7.49772C9.68388 7.5991 9.91786 7.64935 10.1806 7.64935C10.5087 7.64935 10.7836 7.56024 11.0051 7.38233L11.0057 7.38174Z" fill="black"/>
    <path d="M15.0169 8.5958L13.0352 2.78027H14.3031L15.6815 7.17537L17.134 2.78027H18.1926L19.645 7.13885L21.0113 2.78027H22.2793L20.2975 8.5958H18.9928L17.7619 5.03829L17.6636 4.47971L17.5652 5.03829L16.3468 8.5958H15.0175H15.0169Z" fill="black"/>
    <path d="M23.7437 1.51771C23.5302 1.51771 23.3498 1.44292 23.202 1.29305C23.0542 1.14347 22.9805 0.963216 22.9805 0.752868C22.9805 0.542521 23.0542 0.36431 23.202 0.218528C23.3498 0.0727452 23.5302 0 23.7437 0C23.9573 0 24.1376 0.0727452 24.2851 0.218528C24.4329 0.36431 24.5067 0.542229 24.5067 0.752868C24.5067 0.963508 24.4329 1.14347 24.2851 1.29305C24.1374 1.44292 23.957 1.51771 23.7437 1.51771ZM24.3592 8.59591H23.1528V2.78038H24.3468L24.3592 8.59591Z" fill="black"/>
    <path d="M25.6875 10.9999V2.78024H26.6255L26.8693 3.38733C27.1077 3.15273 27.3814 2.97043 27.69 2.84101C27.9986 2.71159 28.346 2.64673 28.7328 2.64673C29.1442 2.64673 29.5248 2.72561 29.8746 2.88337C30.2244 3.04113 30.5265 3.2579 30.7815 3.53282C31.0365 3.80802 31.2359 4.13201 31.3801 4.50421C31.524 4.8767 31.596 5.27315 31.596 5.69414C31.596 6.11512 31.524 6.51186 31.3801 6.88406C31.2362 7.25655 31.0365 7.58025 30.7815 7.85546C30.5265 8.13066 30.2241 8.34714 29.8746 8.5049C29.5248 8.66266 29.1445 8.74154 28.7328 8.74154C28.3211 8.74154 27.9758 8.67464 27.6716 8.54113C27.3671 8.40762 27.1 8.21538 26.8696 7.96443V10.9999H25.6881H25.6875ZM28.6354 3.71512C28.3967 3.71512 28.1701 3.75368 27.9562 3.83052C27.7421 3.90764 27.5546 4.02889 27.3941 4.19483C27.2336 4.36077 27.108 4.56732 27.0174 4.81389C26.9267 5.06076 26.8814 5.35407 26.8814 5.69414C26.8814 6.05845 26.9267 6.36783 27.0174 6.62288C27.108 6.87792 27.2336 7.08418 27.3941 7.24194C27.5546 7.3997 27.7421 7.5151 27.9562 7.58814C28.1704 7.66088 28.3967 7.6974 28.6354 7.6974C28.8741 7.6974 29.1007 7.64482 29.3148 7.53964C29.529 7.43447 29.7141 7.29073 29.8708 7.10872C30.0274 6.92671 30.1506 6.71403 30.2413 6.47125C30.3319 6.22848 30.3772 5.96963 30.3772 5.69414C30.3772 5.41864 30.3319 5.1598 30.2413 4.91702C30.1506 4.67424 30.0271 4.4639 29.8708 4.28569C29.7141 4.10777 29.529 3.96812 29.3148 3.86674C29.1007 3.76566 28.8744 3.71512 28.6354 3.71512Z" fill="black"/>
    <path d="M35.425 8.74154C34.9982 8.74154 34.5983 8.66266 34.2249 8.5049C33.8514 8.34714 33.5253 8.13066 33.2463 7.85546C32.9673 7.58054 32.7478 7.25655 32.5876 6.88406C32.4276 6.51186 32.3477 6.11512 32.3477 5.69414C32.3477 5.27315 32.4235 4.8767 32.5754 4.50421C32.7271 4.13201 32.9323 3.80831 33.1909 3.53282C33.4494 3.25761 33.751 3.04113 34.0957 2.88337C34.4405 2.72561 34.8095 2.64673 35.2034 2.64673C35.5974 2.64673 35.9768 2.71568 36.3174 2.85328C36.6577 2.99088 36.9533 3.20532 37.2035 3.49688C37.4538 3.78816 37.6487 4.1586 37.7882 4.60793C37.9277 5.05725 37.9976 5.59334 37.9976 6.2165H33.6156C33.6728 6.42714 33.7634 6.62317 33.8863 6.80547C34.0095 6.98748 34.155 7.14553 34.3232 7.27905C34.4914 7.41256 34.6801 7.51569 34.8892 7.58872C35.0986 7.66147 35.3178 7.69799 35.5479 7.69799C35.8595 7.69799 36.1488 7.6416 36.4157 7.52796C36.6823 7.4146 36.91 7.26502 37.0987 7.07863L37.8374 7.80725C37.5501 8.09064 37.1991 8.31705 36.785 8.48708C36.3707 8.65711 35.9172 8.74213 35.425 8.74213V8.74154ZM35.2034 3.71512C35.0145 3.71512 34.8362 3.75164 34.6679 3.82438C34.4997 3.89713 34.3436 3.9985 34.2003 4.12792C34.0566 4.25764 33.9334 4.41131 33.8309 4.58923C33.7282 4.76744 33.6523 4.96172 33.6032 5.17207H36.7172C36.7006 4.97779 36.6556 4.79169 36.5819 4.61348C36.5081 4.43556 36.4053 4.27955 36.2741 4.14604C36.1426 4.01253 35.9889 3.90735 35.8124 3.83022C35.6359 3.75339 35.4327 3.71483 35.2031 3.71483L35.2034 3.71512Z" fill="black"/>
    <path d="M5.15663 6.40817C5.20639 6.76839 5.09266 7.07778 4.795 7.30945C3.98346 7.94137 3.16896 8.56949 2.35417 9.19703C1.93892 9.51664 1.33116 9.44565 1.0101 9.04423C0.672752 8.62266 0.733469 8.03661 1.1576 7.70414C1.747 7.24226 2.34143 6.78621 2.93498 6.32929C3.30491 6.04415 3.35763 5.59921 3.06204 5.2425C3.0419 5.21825 2.90655 5.10051 2.89292 5.0713C2.92787 5.07042 3.09373 5.14375 3.12454 5.15456C3.60494 5.32634 4.08712 5.49374 4.56309 5.67721C4.89274 5.8043 5.08614 6.05496 5.15634 6.40846L5.15663 6.40817Z" fill="black"/>
    <path d="M0.0112869 4.59138C-0.0384715 4.23116 0.0752619 3.92177 0.372924 3.6901C1.18446 3.05818 1.99896 2.43006 2.81375 1.80252C3.229 1.48291 3.83676 1.5539 4.15782 1.95532C4.49517 2.37689 4.43445 2.96294 4.01032 3.2954C3.42092 3.75729 2.82649 4.21334 2.23294 4.67026C1.86301 4.9554 1.81029 5.40034 2.10588 5.75705C2.12602 5.7813 2.26137 5.89904 2.275 5.92825C2.24005 5.92913 2.07419 5.8558 2.04338 5.84499C1.56298 5.67321 1.0808 5.5058 0.604833 5.32233C0.275184 5.19525 0.0817779 4.94459 0.0115831 4.59109L0.0112869 4.59138Z" fill="black"/>
  </g>
  <defs>
    <clipPath id="clip0_6219_423">
      <rect width="38" height="11" fill="white"/>
    </clipPath>
  </defs>
</svg></li>

        <li><svg  class="swipe-benefits-tick" xmlns="http://www.w3.org/2000/svg" width="12" height="8" viewBox="0 0 12 8" fill="none">
  <path d="M11.6328 0.166799C11.653 0.178173 11.6733 0.189548 11.6941 0.201267C11.7764 0.266927 11.8333 0.340538 11.89 0.422851C11.8998 0.436993 11.9096 0.451136 11.9197 0.465706C12.0201 0.638679 12.0152 0.856161 11.9657 1.04121C11.8431 1.34076 11.5224 1.56265 11.2618 1.78179C11.2348 1.80458 11.2078 1.82736 11.1808 1.85015C11.1074 1.91209 11.0339 1.97397 10.9604 2.03583C10.8809 2.10282 10.8014 2.16986 10.7219 2.2369C10.5665 2.36792 10.4111 2.49889 10.2556 2.62984C10.1292 2.73627 10.0029 2.84272 9.87653 2.94918C9.51796 3.25132 9.15934 3.55343 8.80065 3.85548C8.78136 3.87173 8.76206 3.88798 8.74218 3.90472C8.72286 3.92099 8.70354 3.93726 8.68364 3.95402C8.37009 4.21807 8.05666 4.48222 7.74328 4.74641C7.42114 5.01798 7.09891 5.28948 6.77659 5.56091C6.59578 5.71317 6.415 5.86547 6.23431 6.01785C6.08061 6.14747 5.92682 6.27703 5.77293 6.4065C5.69445 6.47252 5.61601 6.53858 5.53768 6.60472C5.46592 6.6653 5.39406 6.72579 5.32211 6.78621C5.29615 6.80804 5.27024 6.82991 5.24436 6.85181C4.98346 7.07256 4.72763 7.26558 4.33898 7.27972C3.89734 7.26445 3.65244 7.06806 3.35785 6.81841C3.32349 6.78959 3.28912 6.76079 3.25473 6.732C3.16184 6.65412 3.06924 6.57601 2.97671 6.49783C2.87959 6.41584 2.78224 6.33404 2.68493 6.25221C2.52159 6.1148 2.35844 5.97722 2.19541 5.83954C2.00722 5.68063 1.8187 5.52201 1.63001 5.36353C1.46767 5.22718 1.30552 5.09067 1.14352 4.95403C1.04691 4.87255 0.950238 4.79112 0.8534 4.70983C0.762346 4.63337 0.671526 4.55673 0.580878 4.47994C0.547679 4.45187 0.5144 4.42388 0.481035 4.39595C0.232608 4.18792 0.00745816 3.99594 0 3.68344C0.000726532 3.43362 0.0553093 3.24781 0.26617 3.06216C0.486969 2.88762 0.730569 2.81904 1.02902 2.82157C1.37107 2.83987 1.59747 3.0096 1.8276 3.2061C1.85457 3.22884 1.88156 3.25155 1.90857 3.27426C1.9814 3.33556 2.05393 3.39711 2.12641 3.4587C2.20238 3.52317 2.27861 3.58741 2.35481 3.65168C2.49887 3.77324 2.64268 3.895 2.78642 4.01684C2.95015 4.15561 3.11415 4.29415 3.27817 4.43268C3.61538 4.71749 3.95226 5.00257 4.28891 5.28785C4.37129 5.25821 4.42415 5.21818 4.48713 5.16494C4.50809 5.14731 4.52906 5.12969 4.55066 5.11153C4.57383 5.09185 4.59701 5.07216 4.62017 5.05248C4.64485 5.03165 4.66955 5.01084 4.69425 4.99003C4.76217 4.93276 4.82996 4.87537 4.89772 4.81795C4.9708 4.75608 5.04401 4.69432 5.11721 4.63254C5.2441 4.52544 5.3709 4.41827 5.49765 4.31105C5.68115 4.15585 5.86483 4.00079 6.04855 3.84578C6.34692 3.59403 6.64522 3.34223 6.94345 3.09036C6.9613 3.07528 6.97916 3.0602 6.99756 3.04466C7.25073 2.83083 7.50383 2.61695 7.75691 2.40304C7.77471 2.38799 7.79252 2.37294 7.81086 2.35744C7.83754 2.33489 7.83754 2.33489 7.86475 2.31189C8.16157 2.06101 8.45856 1.81029 8.75571 1.5597C8.93892 1.40517 9.12198 1.25052 9.30485 1.0957C9.43028 0.989528 9.55588 0.883499 9.68161 0.77758C9.7541 0.71651 9.8265 0.655379 9.8987 0.594072C9.96491 0.537852 10.0313 0.48182 10.0979 0.425927C10.1219 0.405768 10.1457 0.385543 10.1695 0.365244C10.5965 0.000920892 11.1059 -0.137011 11.6328 0.166799Z" fill="#434343"/>
</svg> Coverage for damaged, lost or stolen orders</li>
 <li><svg class="swipe-benefits-tick" xmlns="http://www.w3.org/2000/svg" width="12" height="8" viewBox="0 0 12 8" fill="none">
  <path d="M11.6328 0.166799C11.653 0.178173 11.6733 0.189548 11.6941 0.201267C11.7764 0.266927 11.8333 0.340538 11.89 0.422851C11.8998 0.436993 11.9096 0.451136 11.9197 0.465706C12.0201 0.638679 12.0152 0.856161 11.9657 1.04121C11.8431 1.34076 11.5224 1.56265 11.2618 1.78179C11.2348 1.80458 11.2078 1.82736 11.1808 1.85015C11.1074 1.91209 11.0339 1.97397 10.9604 2.03583C10.8809 2.10282 10.8014 2.16986 10.7219 2.2369C10.5665 2.36792 10.4111 2.49889 10.2556 2.62984C10.1292 2.73627 10.0029 2.84272 9.87653 2.94918C9.51796 3.25132 9.15934 3.55343 8.80065 3.85548C8.78136 3.87173 8.76206 3.88798 8.74218 3.90472C8.72286 3.92099 8.70354 3.93726 8.68364 3.95402C8.37009 4.21807 8.05666 4.48222 7.74328 4.74641C7.42114 5.01798 7.09891 5.28948 6.77659 5.56091C6.59578 5.71317 6.415 5.86547 6.23431 6.01785C6.08061 6.14747 5.92682 6.27703 5.77293 6.4065C5.69445 6.47252 5.61601 6.53858 5.53768 6.60472C5.46592 6.6653 5.39406 6.72579 5.32211 6.78621C5.29615 6.80804 5.27024 6.82991 5.24436 6.85181C4.98346 7.07256 4.72763 7.26558 4.33898 7.27972C3.89734 7.26445 3.65244 7.06806 3.35785 6.81841C3.32349 6.78959 3.28912 6.76079 3.25473 6.732C3.16184 6.65412 3.06924 6.57601 2.97671 6.49783C2.87959 6.41584 2.78224 6.33404 2.68493 6.25221C2.52159 6.1148 2.35844 5.97722 2.19541 5.83954C2.00722 5.68063 1.8187 5.52201 1.63001 5.36353C1.46767 5.22718 1.30552 5.09067 1.14352 4.95403C1.04691 4.87255 0.950238 4.79112 0.8534 4.70983C0.762346 4.63337 0.671526 4.55673 0.580878 4.47994C0.547679 4.45187 0.5144 4.42388 0.481035 4.39595C0.232608 4.18792 0.00745816 3.99594 0 3.68344C0.000726532 3.43362 0.0553093 3.24781 0.26617 3.06216C0.486969 2.88762 0.730569 2.81904 1.02902 2.82157C1.37107 2.83987 1.59747 3.0096 1.8276 3.2061C1.85457 3.22884 1.88156 3.25155 1.90857 3.27426C1.9814 3.33556 2.05393 3.39711 2.12641 3.4587C2.20238 3.52317 2.27861 3.58741 2.35481 3.65168C2.49887 3.77324 2.64268 3.895 2.78642 4.01684C2.95015 4.15561 3.11415 4.29415 3.27817 4.43268C3.61538 4.71749 3.95226 5.00257 4.28891 5.28785C4.37129 5.25821 4.42415 5.21818 4.48713 5.16494C4.50809 5.14731 4.52906 5.12969 4.55066 5.11153C4.57383 5.09185 4.59701 5.07216 4.62017 5.05248C4.64485 5.03165 4.66955 5.01084 4.69425 4.99003C4.76217 4.93276 4.82996 4.87537 4.89772 4.81795C4.9708 4.75608 5.04401 4.69432 5.11721 4.63254C5.2441 4.52544 5.3709 4.41827 5.49765 4.31105C5.68115 4.15585 5.86483 4.00079 6.04855 3.84578C6.34692 3.59403 6.64522 3.34223 6.94345 3.09036C6.9613 3.07528 6.97916 3.0602 6.99756 3.04466C7.25073 2.83083 7.50383 2.61695 7.75691 2.40304C7.77471 2.38799 7.79252 2.37294 7.81086 2.35744C7.83754 2.33489 7.83754 2.33489 7.86475 2.31189C8.16157 2.06101 8.45856 1.81029 8.75571 1.5597C8.93892 1.40517 9.12198 1.25052 9.30485 1.0957C9.43028 0.989528 9.55588 0.883499 9.68161 0.77758C9.7541 0.71651 9.8265 0.655379 9.8987 0.594072C9.96491 0.537852 10.0313 0.48182 10.0979 0.425927C10.1219 0.405768 10.1457 0.385543 10.1695 0.365244C10.5965 0.000920892 11.1059 -0.137011 11.6328 0.166799Z" fill="#434343"/>
</svg> Fast resolution with a replacement or refund</li>
        </ul>
        </div>

         
        <a href="#" class="swipe-link-no-protection" style=" color:#000;">
          Checkout without package protection
        </a>
        <button class="swipe-btn-protection" style="padding:.5rem 1rem; border:none; border-radius:4px; cursor:pointer;">
              <span class="cartsimplebutton">Complete Checkout</span>
          <span class="protectfee">Checkout + ${moneyFormat(protectionAmount)} protection fee</span>
          <span class="cartfee">Checkout + ${formattedTotal}</span>
        </button>

      `;

      origEl.insertAdjacentElement("afterend", box);
      toggleCheckoutMode(origEl, box, shouldUseSwipeCustomCheckout);

      const link = box.querySelector(".swipe-link-no-protection");
      const btn = box.querySelector(".swipe-btn-protection");
      /* ---------------------------
   Apply Cart Customization
----------------------------*/

if (cartCustomization) {

  if (cartCustomization.checkout_button_bg_color) {
    btn.style.backgroundColor =
      cartCustomization.checkout_button_bg_color;
  }

  if (cartCustomization.checkout_button_text_color) {
    btn.style.color =
      cartCustomization.checkout_button_text_color;
  }

  if (cartCustomization.cart_text_color) {
    link.style.color =
      cartCustomization.cart_text_color;
  }

}
      // Override link: plain checkout
      link.addEventListener("click", async e => {
        e.preventDefault();
        if (link.dataset.swipeProcessing === "true") return;
        link.dataset.swipeProcessing = "true";
        showLoadingOnElement(link);
        try {
          await removeExistingProtectionIfAny();
          continueToCheckout(origEl);
        } catch (err) {
          console.error("Error removing protection:", err);
          restoreElementLoadingState(link);
        } finally {
          link.dataset.swipeProcessing = "false";
        }
      });

// Override button: add protection then checkout
btn.addEventListener("click", async (e) => {
  e.preventDefault();
  if (btn.dataset.swipeProcessing === "true") return;
  btn.dataset.swipeProcessing = "true";

  const loadingTimer = setTimeout(() => {
    showLoadingOnElement(btn);
  }, 200); // show loading only if takes >200ms

  skipSwipeMutation = true;

  try {
    const cart = await getCartItem();
    const nonSwipeItems = cart.items.filter(
      (i) =>
        i.product_title !== "Swipe" &&
        i.product_title !== "Swipe Package Protection"
    );

    // If only Swipe exists
    if (nonSwipeItems.length === 0) {
      clearTimeout(loadingTimer);
      await removeExistingProtectionIfAny();
      skipSwipeMutation = false;
      window.location.reload();
      return;
    }

    await verifySwipeBeforeCheckout();
    await applyProtectionVariant();

    // Small buffer for Shopify cart consistency
    await new Promise((res) => setTimeout(res, 250));

    clearTimeout(loadingTimer);
    continueToCheckout(origEl);
  } catch (err) {
    console.error("Error applying protection:", err);
    restoreElementLoadingState(btn);
  } finally {
    clearTimeout(loadingTimer);
    skipSwipeMutation = false;
    btn.dataset.swipeProcessing = "false";
  }
});

    });
  });





}


window.addEventListener("pageshow", async () => {

  await loadMerchantConfig();

    // -----------------------------------------
    // 1. LoopOnstore check
    // -----------------------------------------
    if (typeof LoopOnstore !== "undefined" && LoopOnstore.isActive()) {
        document.querySelectorAll(
            '.rebuy-button.block, .rebuy-cart__flyout-empty-cart a.block'
        ).forEach(button => {
            button.style.setProperty("display", "block", "important");
        });
        return; // STOP if LoopOnstore active
    }


function waitForCheckoutButton(cb, tries = 0) {
  const btn = document.querySelector(CHECKOUT_SELECTOR);

  if (btn) {
    cb();
    return;
  }

  if (tries > 20) return; // max ~1s, avoid infinite loop

  setTimeout(() => waitForCheckoutButton(cb, tries + 1), 50);
}

function runCartFunctions() {
  waitForCheckoutButton(() => {
    replaceNativeWithCustom();
  });
}
const observer = new MutationObserver(() => {
  const btn = document.querySelector(CHECKOUT_SELECTOR);
  if (btn) {
    observer.disconnect();
    replaceNativeWithCustom();
  }
});
observer.observe(document.body, { childList: true, subtree: true });


// A. Check if the page is fully ready
    if (document.readyState === "complete") {
        runCartFunctions();
    } else {
        // B. Wait for the standard DOMContentLoaded event
        document.addEventListener("DOMContentLoaded", () => {
             // Use a short delay (e.g., 100ms) to ensure theme scripts finish setup
             setTimeout(runCartFunctions, 300); 
        });
    }


    // -----------------------------------------
    // 3. Debounce wrapper
    // -----------------------------------------
   let lastCartState = null;
let cartChangeTimer = null;


function scheduleCartChange() {
    clearTimeout(cartChangeTimer);
    cartChangeTimer = setTimeout(async () => {
        try {
            await enforceNonSubscriptionSwipeRules();
        } catch (err) {
            console.error("Non-subscription Swipe auto-sync error:", err);
        }
        runCartFunctions();
    }, 300);
}

async function processCartResponse(response) {
    try {
        const clone = response.clone();
        const cartData = await clone.json();   // read JSON safely
        const currentState = JSON.stringify(cartData);

        if (lastCartState !== currentState) {
            lastCartState = currentState;
            scheduleCartChange();  // real change detected
        } else {
            // Same response, ignore
        }

    } catch (err) {
        console.warn("Unable to parse cart JSON", err);
    }
}

/* -------------------------
   FETCH INTERCEPTOR
-------------------------- */
const originalFetch = window.fetch;

function showSwipeCartError(message) {
  // 1. Try Swipe's own box first
  const swipeBox = document.querySelector(".swipe-custom-box");
  if (swipeBox) {
    let msg = swipeBox.querySelector(".swipe-cart-error");
    if (!msg) {
      msg = document.createElement("p");
      msg.className = "swipe-cart-error";
      msg.style.cssText = "color:red;font-size:13px;margin:8px 0 0;text-align:center;";
      swipeBox.appendChild(msg);
    }
    msg.textContent = message;
    setTimeout(() => msg?.remove(), 5000);
    return;
  }

  // 2. Try common theme cart error containers
  const themeSelectors = [
    ".cart-errors",
    ".cart__warnings",
    "[data-cart-errors]",
    ".cart-error",
    ".cart__error",
    ".flash--error",
  ];
  for (const sel of themeSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      el.textContent = message;
      el.style.display = "block";
      setTimeout(() => { el.textContent = ""; el.style.display = ""; }, 5000);
      return;
    }
  }

  // 3. Fallback: inject a floating error banner
  let banner = document.getElementById("swipe-error-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "swipe-error-banner";
    banner.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#c0392b;color:#fff;padding:12px 20px;border-radius:6px;font-size:14px;z-index:99999;text-align:center;max-width:90vw;";
    document.body.appendChild(banner);
  }
  banner.textContent = message;
  banner.style.display = "block";
  setTimeout(() => { if (banner) banner.style.display = "none"; }, 5000);
}

window.fetch = async (...args) => {
    const response = await originalFetch(...args);

    let url = args[0];
    if (url && typeof url === "object") url = url.url || "";
    const urlStr = String(url);

    if (!skipSwipeMutation && urlStr.includes("/cart")) {
        processCartResponse(response);
    }

    return response;
};

// Intercept cart/update.js BEFORE sending â€” if removing the last non-Swipe
// item, append Swipe protection removals to the same update so both are
// removed together in one request.
const _origFetchForRemove = window.fetch;
window.fetch = async (...args) => {
    let url = args[0];
    if (url && typeof url === "object") url = url.url || "";
    const urlStr = String(url);

    if (!skipSwipeMutation && (urlStr.includes("/cart/update") || urlStr.includes("/cart/change"))) {
        try {
            const bodyText = args[1]?.body;
            if (bodyText) {
                const body = typeof bodyText === "string" ? JSON.parse(bodyText) : bodyText;
                const updates = body?.updates || {};
                const removingKeys = Object.keys(updates).filter((k) => Number(updates[k]) === 0);

                if (removingKeys.length) {
                    const cart = await getCartItem();
                    const items = cart.items || [];

                    // Keys being removed
                    const removingSet = new Set(removingKeys);

                    // Items that will remain after this update
                    const remaining = items.filter((item) => {
                        const key = getCartLineUpdateKey(item);
                        return !removingSet.has(key) && Number(updates[key]) !== 0;
                    });

                    // If only Swipe protection items remain, also remove them
                    const onlySwipeLeft = remaining.length > 0 && remaining.every((item) => isSwipeProtectionItem(item));
                    if (onlySwipeLeft) {
                        const swipeUpdates = buildRemoveSwipeUpdates(remaining);
                        const mergedUpdates = { ...updates, ...swipeUpdates };
                        const newBody = JSON.stringify({ ...body, updates: mergedUpdates });
                        const newArgs = [args[0], { ...args[1], body: newBody }];
                        const response = await _origFetchForRemove(...newArgs);
                        scheduleCartChange();
                        return response;
                    }
                }
            }
        } catch (e) {}
    }

    return _origFetchForRemove(...args);
};

/* -------------------------
   XHR INTERCEPTOR
-------------------------- */
const XHR = window.XMLHttpRequest;
const origOpen = XHR.prototype.open;
const origSend = XHR.prototype.send;

XHR.prototype.open = function (method, url, ...rest) {
    this.__cartURL = url;
    return origOpen.apply(this, [method, url, ...rest]);
};

XHR.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      if (!skipSwipeMutation && String(this.__cartURL).includes("/cart")) {

            const text = this.responseText;
            try {
                const cartData = JSON.parse(text);
                const currentState = JSON.stringify(cartData);

                if (lastCartState !== currentState) {
                    lastCartState = currentState;
                    scheduleCartChange();
                }
            } catch (e) {}
        }
    });

    return origSend.apply(this, args);
};
// --- Swipe Benefits Dropdown Toggle (Always active like popup learn-more button) ---
document.addEventListener("click", function (e) {
  const expandBtn = e.target.closest(".swipe-benefits-expand");
  if (!expandBtn) return;

  const benefits = expandBtn.nextElementSibling; // ul.swipe-benefits
  const svg = expandBtn.querySelector("svg");

  if (!benefits) return;

  benefits.classList.toggle("active");
  svg?.classList.toggle("rotate-90");
});


});


/* =====================================================
  FINAL SAFETY: AJAX / Drawer Checkout Watcher
   Purpose:
   - Whenever checkout button appears via AJAX
   - Ensure replaceNativeWithCustom() runs ONCE
===================================================== */

(function () {
  let ranForThisDOM = false;

  function tryRunReplace() {
    const btn = document.querySelector(CHECKOUT_SELECTOR);
    if (!btn) return;

    // Prevent loop for same DOM instance
    if (btn.dataset.swipeObserved) return;

    btn.dataset.swipeObserved = "true";

    // Reset guard so debounce logic can work normally
    ranForThisDOM = true;

    //  Call your existing logic
    replaceNativeWithCustom();
  }

  // Run immediately (in case already present)
  tryRunReplace();

  //  Observe DOM for AJAX injections
  const observer = new MutationObserver(() => {
    tryRunReplace();
    tagSwipeItemsInDOM();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Safety: re-run on pageshow (back button / bfcache)
  window.addEventListener("pageshow", async () => {

  await loadMerchantConfig();
    ranForThisDOM = false;
    tryRunReplace();
    tagSwipeItemsInDOM();
  });

  // Periodically check as a fail-safe
  setInterval(tagSwipeItemsInDOM, 2000);
})();
/* =====================================
   FIX: Reset Processing on Back Button
===================================== */

window.addEventListener("pageshow", function () {

  document.querySelectorAll(".swipe-btn-protection, .swipe-link-no-protection").forEach(el => {

    el.classList.remove("loading-overlay");

    if (el.dataset.originalText) {
      if (el.tagName.toLowerCase() === "input") {
        el.value = el.dataset.originalText;
      } else {
        el.innerHTML = el.dataset.originalText;
      }
    } else {
      // Fallback default
   if (el.classList.contains("swipe-btn-protection")) {
  const cartFee = el.querySelector(".cartfee");

  if (cartFee) {
    cartFee.style.display = "block";
  }
}

      if (el.classList.contains("swipe-link-no-protection")) {
        el.innerHTML = "Checkout without package protection";
      }
    }

  });

});
