const Schema = Mongoose.Schema;

const ImpersonationLogSchema = Schema(
    {
        admin: {
            type: Schema.Types.ObjectId,
            ref: "users",
            required: true,
        },
        merchant: {
            type: Schema.Types.ObjectId,
            ref: "merchants",
            required: true,
        },
        admin_email: String,
        merchant_name: String,
        merchant_email: String,
        ip: String,
        user_agent: String,
        action: {
            type: String,
            enum: ["start", "stop"],
            default: "start",
        },
        timestamp: {
            type: Date,
            default: Date.now,
        },
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

module.exports = Mongoose.model("impersonation_logs", ImpersonationLogSchema);
