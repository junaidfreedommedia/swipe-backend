const Schema = Mongoose.Schema;

const MerchantSchema = Schema(
    {
        shop_id: String,
        id: Number,
        name: String,
        email: String,
        phone: String,
        domain: String,
        province: String,
        country: String,
        address1: String,
        address2: String,
        zip: String,
        city: String,
        country_code: String,
        country_name: String,
        latitude: String,
        longitude: String,
        primary_locale: String,
        created_at: String,
        currency: String,
        customer_email: String,
        customer_id: String,
        timezone: String,
        iana_timezone: { type: String, default: "America/Chicago" },
        shop_owner: String,
        money_format: String,
        money_with_currency_format: String,
        weight_unit: String,
        province_code: String,
        taxes_included: String,
        county_taxes: String,
        plan_display_name: String,
        plan_name: String,
        myshopify_domain: String,
        money_in_emails_format: String,
        money_with_currency_in_emails_format: String,
        eligible_for_payments: String,
        password_enabled: Boolean,
        has_storefront: Boolean,
        finances: Boolean,
        primary_location_id: Number,
        cookie_consent_level: String,
        checkout_api_supported: Boolean,
        enabled_presentment_currencies: [String],
        store_logo: String,
        is_active: { type: Boolean, default: true },
        is_billing: { type: Boolean, default: false },
        is_onboarding: { type: Boolean, default: false },
        is_blocked: { type: Boolean, default: false },
        is_deleted: { type: Boolean, default: false },
        blocked_date: Date,
        deleted_date: Date,
        billing_approved_date: Date,
        charge_id: Number,
       billing_type: { type: String, default: "stripe" },
        stripe_product_id: String,
        payment_links: [String],
        site_url: String,
        phone_no: String,
        platform: String,
        billing_contact_email: String,
        reimbursement_contact_email: String,
        claims_contact_email: String,
        google_sheet_claim_sync_enabled: { type: Boolean, default: false },
        google_sheet_id: String,
        google_sheet_url: String,
        google_sheet_tab: { type: String, default: "Claims" },
        google_sheet_status: {
            type: String,
            enum: ["provisioning", "ready", "error"],
        },
        google_sheet_error: String,
        google_sheet_created_at: Date,
        google_sheet_monthly_tabs_migrated_at: Date,
        route_plus_package_protection: String,
        protection_widget: String,
        thank_you_page_tracking_link: String,
        free_shipping_and_protection_bar: String,
         competition: { 
        type: Number, 
        required: false,
    },
        account_manager: {
            type: Schema.Types.ObjectId,
            ref: "users",
        },
    },
    {
        timestamps: true,
        id: false,
        toObject: {
            virtuals: true,
            getters: true
        },
        toJSON: {
            virtuals: true,
            getters: true
        }
    }
);
MerchantSchema.index(
  { deleted_date: 1 },
  { expireAfterSeconds: 3600 } 
);

MerchantSchema.index(
  { deleted_date: 1 },
  { expireAfterSeconds: 180 }   
);
module.exports = Mongoose.model('merchants', MerchantSchema);
