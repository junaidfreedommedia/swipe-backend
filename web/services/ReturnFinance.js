const { buildReport, RESOLVED_STATUSES } = require("../utils/returnFinance");

const generate = async (merchant, month) => {
  // Validate before querying. No billing, refund, payment or statement service is called here.
  buildReport([], month, merchant.name);
  const start = new Date(`${month}-01T00:00:00Z`), end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const dates = ["processed_at", "finance_events.date", "refund_details.processed_at", "credit_refund_details.processed_at", "reorder_details.processed_at",
    "reorder_details.paid_at", "reorder_details.stripe_paid_at", "items.resolved_at", "easypost.purchased_at", "timeline.created_at"];
  const records = await Models.Return.find({ merchant: merchant._id, status: { $in: RESOLVED_STATUSES }, $or: dates.map((field) => ({ [field]: { $gte: start, $lt: end } })) })
    .select("merchant shop return_number customer.email status subtotal outcome order processed_at finance_events refund_details credit_refund_details reorder_details easypost items timeline createdAt")
    .populate("order", "name")
    .lean();
  const snapshot = buildReport(records, month, merchant.name || merchant.shop_id || "Store");
  snapshot.merchant_address = [merchant.address || merchant.address1, merchant.address2, merchant.city, merchant.province_code || merchant.province, merchant.zip, merchant.country].filter(Boolean).join(", ");
  if (!snapshot.rows.length) throw Object.assign(new Error("No completed exchanges or refunds were found for this month."), { status: 404 });
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 12 * 1024 * 1024) throw Object.assign(new Error("This report exceeds the supported size. Contact support to export this period."), { status: 413 });
  const condition = { merchant: merchant._id, month };
  const update = { $set: { merchant_name: snapshot.merchant_name, generated_at: snapshot.generated_at, snapshot } };
  try {
    return await Models.ReturnFinanceReport.findOneAndUpdate(condition, update, { upsert: true, new: true, runValidators: true, lean: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    return Models.ReturnFinanceReport.findOneAndUpdate(condition, update, { new: true, runValidators: true, lean: true });
  }
};
module.exports = { generate };
