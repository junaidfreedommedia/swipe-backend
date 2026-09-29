const Schema = Mongoose.Schema;
const SubscriptionSchema = Schema(
    {
        merchant: {
            type: Schema.Types.ObjectId,
            ref: 'merchants'
        },
        admin_graphql_api_id: String,
        name: String,
        status: String,
        admin_graphql_api_shop_id: String,
        created_at: Date,
        updated_at: Date,
        currency: String,
        capped_amount: String
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

module.exports = Mongoose.model('subscriptions', SubscriptionSchema)