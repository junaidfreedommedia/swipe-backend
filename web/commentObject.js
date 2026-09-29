const taskObject = {
	"install_task": {
		"action": "link",
		"label": "Install App",
		"id": "installTask",
		"done": false,
		"url": "https://apps.shopify.com/swipe",
		"actionLabel": "Install Now"
	},
	"onboard_task": {
		"action": "calendly",
		"label": "Get Onboarded!",
		"id": "onboardTask",
		"done": false,
		"url": "https://calendly.com/post-protection-merchant-success/onboarding-call",
		"actionLabel": "Book A Call"
	},
	"partner_task": {
		"action": "popup",
		"label": "Approve Shopify Partner Request",
		"id": "partnerTask",
		"popupText": "Your Merchant Success Team will be sending a Partner Request to your Shopify store.",
		"done": false,
		"actionLabel": "Learn More"
	},
	"billing_task": {
		"action": "billing",
		"label": "Approve Shopify App Billing",
		"id": "billingTask",
		"done": false,
		"actionLabel": "Approve"
	},
	"widget_task": {
		"action": "popup",
		"label": "Add the Swipe Widget to your Theme",
		"id": "widgetTask",
		"popupText": "Almost done! Our developer team will be installing the Swipe widget on to a new duplicate theme for you within 48hrs of your onboarding call. We will notify you when the widget is installed and live!",
		"done": false,
		"actionLabel": "Learn More"
	},
	"protect_and_resolve": {
		"implement_swipe_protect_widget": "Blank",
		"setup_shipping_protection_banner": "Blank",
		"done": false
	},
	"track": {
		"thank_you_page_tracking_link": "Blank",
		"shopify_tracking_link": "Blank",
		"order_confirmation_email": "Blank",
		"done": false
	},
	"engage": {
		"customer_contact_info": "Blank",
		"done": false
	},
	"branding_and_profile": {
		"branding_and_merchant_profile": "Blank",
		"setup_merchant_categories": "Blank",
		"done": false
	},
	"admin": {
		"merchant_communication_email": "Blank",
		"add_your_team": "Blank",
		"done": false
	},
	"finance": {
		"approve_shopify_billing": "Blank",
		"done": false
	},
};

const cartWidget = {
	"cart_page" : {
		"background_color" : "#FFFFFF",
		"description" : "Add Swipe to your order at checkout for a worry-free shipping experience - your package is covered against loss, damage, or theft.",
		"description_text_color" : "#000000",
		"enable_default_protection" : false,
		"first_tab_description" : "We've Got Your Package Covered!",
		"first_tab_title" : "We've Got Your Package Covered!",
		"is_active" : true,
		"popup_description_color" : "#333333",
		"popup_title_color" : "#000000",
		"second_tab_description" : "Instantly resolve shipping issues with just a few clicks.",
		"second_tab_title" : "Instant Resolution",
		"show_protection_amount" : false,
		"third_tab_description" : "For immediate solutions to lost, stolen or damaged packages. We're here for you!",
		"third_tab_title" : "Trust Swipe",
		"title" : "Swipe",
		"title_text_color" : "#000000"
	},
	"configure_bar" : {
		"is_active": true,
        "title": "configure",
        "banner_background_color":"#fdf399",
        "font_color":"#000000",
        "offer_text": "free shipphing",
        "offer_image": "image",
        "spending_target": "23",
        "spending_currency": "usd",
        "location": "USA",
        "stickiness": [
            "sticky"
        ],
        "close_button": false,
        "font_family": "ariel",
        "font_size": "12"
	}
}

module.exports = { taskObject, cartWidget};