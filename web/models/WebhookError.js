const Schema = Mongoose.Schema;

const WebhookSchema = Schema(
  {
    webhook_error: String,
    webhook_payload: Schema.Types.Mixed,
    webhook_name: String,
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

module.exports = Mongoose.model("webhook_errors", WebhookSchema);
