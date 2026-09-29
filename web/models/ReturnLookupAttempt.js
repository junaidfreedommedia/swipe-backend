const Schema = Mongoose.Schema;

const ReturnLookupAttemptSchema = Schema(
  {
    key: { type: String, required: true, unique: true },
    attempts: { type: Number, default: 0 },
    expires_at: { type: Date, required: true },
  },
  { timestamps: true, id: false }
);

ReturnLookupAttemptSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = Mongoose.model(
  "return_lookup_attempts",
  ReturnLookupAttemptSchema
);
