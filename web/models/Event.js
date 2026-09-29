const Schema = Mongoose.Schema;

const EventSchema = Schema(
    {
        merchant: {
            type: Schema.Types.ObjectId,
            ref: 'merchants'
        },
        user: {
            type: Schema.Types.ObjectId,
            ref: 'users'
        },
        order: {
            type: Schema.Types.ObjectId,
            ref: 'orders'
        },
        claim: {
            type: Schema.Types.ObjectId,
            ref: 'claims'
        },
        name: String,
        ts: {
            type: Number,
            default: Math.floor(new Date().getTime() / 1000)
        },
        created_by: {
            type: Schema.Types.ObjectId,
            ref: 'users'
        },
        action_on: String,
        title: String,
        type: String,
        sub_type: String,
        content: String,
        attachments: Array,
        who: String,
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
module.exports = Mongoose.model('events', EventSchema);
