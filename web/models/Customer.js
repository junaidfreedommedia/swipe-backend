const mongoose = require("mongoose");
const { Schema } = mongoose;

const CustomerSchema = new Schema(
    {
        merchant: {
            type: Schema.Types.ObjectId,
            ref: "Merchant",
            required: true,
            index: true
        },

        id: {
            type: Number,
            required: true
        },

        email: String,
        firstName: String,
        lastName: String,
        phone: String,
        admin_graphql_api_id: String,
        state: String,
        verified_email: Boolean,
        tags: String,
        currency: String,
        customer_created_at: Date,
        billing_address: Schema.Types.Mixed

    },
    {
        timestamps: true,
        strict: true
    }
);

CustomerSchema.index({ merchant: 1, id: 1 }, { unique: true });

module.exports = mongoose.model("Customer", CustomerSchema);
