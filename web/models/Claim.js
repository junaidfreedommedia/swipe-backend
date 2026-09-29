const Schema = Mongoose.Schema;
const ClaimSchema = Schema(
    {
        address_verified: {
            type: Boolean,
            default: false,
        },
        reason: String,
        description: String,
        ip_address: String,
        merchant: {
            type: Schema.Types.ObjectId,
            ref: "merchants",
        },
        google_sheet_sync_enabled: Boolean,
        order: {
            type: Schema.Types.ObjectId,
            ref: "orders",
        },
        product_id: [
            {
                type: Number,
            },
        ],
        products: [
            {
                id: Number,
                quantity: Number,
            },
        ],
        claim_items: [
    {
        item_id: {
            type: Number, // Shopify line_item.id
            required: true,
        },
        variant_id: {
            type: Number,
        },
        quantity: {
            type: Number,
            default: 1,
        },
        resolution: {
            type: String,
            enum: ["pending", "refund", "reorder"],
            default: "pending",
        },
        resolved_at: {
            type: Date,
            default: null,
        },
    },
],

        claim_total: {
            type: String,
            default: "0.00",
        },
        original_shipping_total: {
            type: String,
            default: "0.00",
        },
        refund_count: {
            type: Number,
            default: 0,
        },
        refund_shipping_total: {
            type: String,
            default: "0.00",
        },
        refund_total: {
            type: String,
            default: "0.00",
        },
        reorder_count: {
            type: Number,
            default: 0,
        },
        reorder_shipping_total: {
            type: String,
            default: "0.00",
        },
        reorder_total: {
            type: String,
            default: "0.00",
        },
        claim_total_amount: Number,
        reviewers: [
            {
                type: Schema.Types.ObjectId,
                ref: "users",
            },
        ],
        source: {
            type: String,
            enum: ["PUBLIC"],
        },
        status: {
            type: String,
            enum: ["REVIEWING", "APPROVED", "CLOSED", "RESOLVED"],
        },
        sub_status: {
            type: String,
            enum: ["IN_REVIEW", "PROCESSED", "OTHER", "RESOLVED"],
        },
        refund_status: { type: String, enum: ["REFUND", "REPLACE"] },
        resolved_date: Date,
        created_by: {
            type: Schema.Types.ObjectId,
            ref: "users",
        },
        created_role: String,
        reorder_id: Number,
        order_name: String,
        previous_status: String,
        customer_claim_no: Number,
        total_claim_no: Number,
        // 🔥 READ OPTIMIZATION SNAPSHOTS (NON-BREAKING)
order_snapshot: {
    name: String,
    number: Number,
    customer_email: String,
    customer_name: String,
    created_at: Date,
},

merchant_snapshot: {
    name: String,
    shop_id: String,
},

    swipe_by_refunded: {
    type: String,

  default: 0
}
,
    combined_refund_total: { type: String, default: "0" },

        refunded_partial_amount: Boolean,
        reorder_details: {
            id: Number,
            number: Number,
            order: {
                type: Schema.Types.ObjectId,
                ref: "orders",
            },
        },
        processed_billing_actions: [
            {
                type: String,
            },
        ],
    },
    {
        timestamps: true,
        id: false,
        toObject: {
            virtuals: true,
            getters: true,
        },
        toJSON: {
            virtuals: true,
            getters: true,
        },
    }
);

ClaimSchema.pre("save", async function (next) {
    this.$locals.wasNew = this.isNew;
    if (!this.isNew) return next();

    this.google_sheet_sync_enabled = false;
    if (!this.order && !this.merchant) return next();

    try {
        let merchantId = this.merchant;
        let order;

        if (this.order) {
            order = await Services.Order.get(
                { _id: this.order },
                {
                    name: 1,
                    order_number: 1,
                    "customer.email": 1,
                    "customer.name": 1,
                    merchant: 1,
                    order_created_at: 1,
                    createdAt: 1,
                }
            );
        }

        if (order) {
            // existing behavior (DO NOT BREAK)
            this.order_name = order.name;

            // 🔥 NEW snapshot
            this.order_snapshot = {
                name: order.name,
                number: order.order_number,
                customer_email: order.customer?.email,
                customer_name: order.customer?.name,
                created_at: order.order_created_at || order.createdAt,
            };
            merchantId = order.merchant || merchantId;
        }

        if (merchantId) {
            const merchant = await Services.Merchant.get(
                { _id: merchantId },
                {
                    name: 1,
                    shop_id: 1,
                    google_sheet_claim_sync_enabled: 1,
                }
            );

            if (merchant) {
                this.merchant_snapshot = {
                    name: merchant.name,
                    shop_id: merchant.shop_id,
                };
                this.google_sheet_sync_enabled =
                    merchant.google_sheet_claim_sync_enabled === true;
            }
        }

        next();
    } catch (err) {
        next(err); // fail-safe
    }
});

ClaimSchema.post("save", function (doc) {
    if (!doc.$locals?.wasNew) return;

    const claimData = doc.toObject({
        getters: false,
        virtuals: false,
    });

    setImmediate(async () => {
        const googleSheetService = global.Services?.GoogleSheet;

        try {
            if (
                !googleSheetService?.isConfigured ||
                !(await googleSheetService.isConfigured())
            ) {
                Logger.warn(
                    `[GoogleSheet] Claim sync skipped; Google Sheet database credentials are not configured. claim_id=${claimData._id}`
                );
                return;
            }

            const result = await googleSheetService.appendClaimRow(claimData);
            if (result?.action === "skipped") {
                Logger.info(
                    `[GoogleSheet] Claim sync skipped. claim_id=${claimData._id} reason=${result.reason || "disabled"}`
                );
                return;
            }
            Logger.info(
                `[GoogleSheet] Claim synced. claim_id=${claimData._id} range=${result?.updates?.updatedRange || "unknown"}`
            );
        } catch (error) {
            const message =
                error?.response?.data?.error?.message ||
                error?.message ||
                String(error);

            Logger.error(
                `[GoogleSheet] Claim sync failed. claim_id=${claimData._id} error=${message}`
            );
        }
    });
});

// 🔥 PERFORMANCE INDEXES
ClaimSchema.index({ merchant: 1, createdAt: -1 });
ClaimSchema.index({ status: 1, createdAt: -1 });
ClaimSchema.index({ merchant: 1, status: 1, createdAt: -1 });
ClaimSchema.index({ "order_snapshot.customer_email": 1 });
ClaimSchema.index({ order_name: 1 });


module.exports = Mongoose.model("claims", ClaimSchema);
