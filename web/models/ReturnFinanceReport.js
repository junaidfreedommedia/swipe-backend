const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  merchant: { type: mongoose.Schema.Types.ObjectId, ref: "merchants", required: true },
  month: { type: String, required: true }, merchant_name: String, generated_at: Date,
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true });
schema.index({ merchant: 1, month: 1 }, { unique: true });
module.exports = mongoose.model("return_finance_reports", schema);
