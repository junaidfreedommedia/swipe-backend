const mongoose = require('mongoose');
const schema = mongoose.Schema;

const StatementSchema =  schema({
        merchant: {
            type : schema.Types.ObjectId,
            ref : "merchants"
        },
        url: String,
        statement_month: String,
        month: Number,
        year: Number,
        status: String,
        payment_link: String,
        payment_link_id: String,
        shopify_usage_charge_id: String,
        shopify_charge_amount: Number,
        shopify_charge_status: String,
        shopify_charge_description: String,
        shopify_charged_at: Date,
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
)

module.exports = mongoose.model("statement",StatementSchema)
