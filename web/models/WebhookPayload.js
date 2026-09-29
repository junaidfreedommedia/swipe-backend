const Schema = Mongoose.Schema;

const WebhookPayloadSchema = Schema(
    {
        topic: String,
        payload: Schema.Types.Mixed
    },
    {
        timestamps: true,
        id: false
    }
);

module.exports = Mongoose.model("webhook_payloads", WebhookPayloadSchema); 
