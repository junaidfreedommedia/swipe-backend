const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    // The primary key enforces one bill per merchant/month even before background indexes finish.
    _id: String,
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'merchants', required: true, index: true },
    period: String, provider: String, status: String,
    snapshot: mongoose.Schema.Types.Mixed, settings: mongoose.Schema.Types.Mixed, report_url: String,
    stripe_invoice_id: String, stripe_customer_id: String, stripe_payment_method: String, invoice_url: String, invoice_pdf: String,
    stripe_started_at: Date, stripe_released: Boolean, collection_paused: Boolean, report_ready: Boolean,
    stripe_test_reset_id: String,
    shopify_subscription_line_item_id: String, shopify_usage_charge_id: String, shopify_submitted_at: Date,
    last_error: String, payment_reference: String, payment_note: String, paid_at: Date,
    due_at: Date, notified: { type: mongoose.Schema.Types.Mixed, default: {} },
    audit: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });
module.exports = mongoose.model('MerchantBillingRun', schema);
