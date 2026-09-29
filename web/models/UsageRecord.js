const Schema = Mongoose.Schema;
const UsageRecordSchema = Schema(
    {
        merchant: {
            type: Schema.Types.ObjectId,
            ref: 'merchants'
        },
        order: {
            type: Schema.Types.ObjectId,
            ref: 'orders'
        },
        claim: {
            type: Schema.Types.ObjectId,
            ref: 'claims'
        },
        type: { 
            type: String,
            enum: ['usages', 'credit'],
            default: 'usages',
        },
        credit_type: {
            type: String,
            enum: ['reorder', 'refund']
        },
        amount: Number,
        generated: {
            type: String,
            enum: ['manual', 'default'],
            default: 'default',
        },
        source_type: {
            type: String,
            enum: ['order_usage', 'claim_refund', 'claim_reorder'],
        },
        adjustment_key: {
            type: String,
        },
        action_key: {
            type: String,
        },
        metadata: Schema.Types.Mixed,
        record_date: { type: Date, default: new Date() },
        order_name: String,
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

UsageRecordSchema.index(
    { adjustment_key: 1 },
    { unique: true, sparse: true, name: "usage_record_adjustment_key_unique" }
);

UsageRecordSchema.pre('save', async function (next){
    if(this.order && this.isNew){
        const order = await Services.Order.get({ _id: this.order }, { name: 1 });
        if(order.name) this.order_name = order.name;
    }
    next();
});

module.exports = Mongoose.model('usage_record', UsageRecordSchema);
