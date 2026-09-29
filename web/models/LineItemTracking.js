const Schema = Mongoose.Schema;

const LineItemsTrackingSchema = Schema(
    {
        merchant: {
            type: Schema.Types.ObjectId,
            ref: 'merchants',
            required: true,
            index: true
        },
        order: {
            type: Schema.Types.ObjectId,
            ref: 'orders',
            required: true,
            index: true
        },
        order_id: {
            type: String,
            required: true,
            index: true
        },
        line_item_id: {
            type: Number,
            required: true,
            index: true
        },
        return_id: {
            type: String,
            sparse: true,
            index: true
        },
        gross_sale: {
            type: Number,
            required: true
        }
        
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

// Compound index for faster queries
LineItemsTrackingSchema.index({ merchant: 1, order: 1, line_item_id: 1 });

module.exports = Mongoose.model('line_items_tracking', LineItemsTrackingSchema); 