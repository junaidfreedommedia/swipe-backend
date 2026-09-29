const router = require("express").Router();
const { Types } = require("mongoose");
const { createPdf } = require("../../utils/returnFinancePdf");
const { resolvedSnapshot, RESOLVED_STATUSES } = require("../../utils/returnFinance");
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const id = (value) => { if (!/^[a-f0-9]{24}$/i.test(String(value || ""))) fail("Invalid record or merchant."); return new Types.ObjectId(value); };

const scope = (req) => {
  if (req.user.role === "merchant") {
    const merchantId = req.merchant?._id || req.user.merchant;
    Auth.assertMerchantAccess(req.user, merchantId);
    if (req.query.merchantId && String(req.query.merchantId) !== String(merchantId)) fail("You do not have access to this store.", 403);
    return { merchant: id(String(merchantId)) };
  }
  if (req.user.role !== "admin") fail("Finance access is required.", 403);
  if (req.query.merchantId) {
    Auth.assertMerchantAccess(req.user, req.query.merchantId);
    return { merchant: id(req.query.merchantId) };
  }
  return Auth.isSuperAdmin(req.user) ? {} : { merchant: { $in: Auth.getAssignedMerchantIds(req.user).map(id) } };
};
const handler = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
router.use(Auth.check);
router.get("/", handler(async (req, res) => {
  const condition = scope(req);
  condition["snapshot.rows.status"] = { $in: [...RESOLVED_STATUSES, "Exchanged", "Refunded"] };
  if (req.query.month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)) fail("Choose a valid month.");
    condition.month = req.query.month;
  } else if (req.query.year || req.query.monthNumber) {
    const year = String(req.query.year || ""), month = String(req.query.monthNumber || "");
    if (year && !/^\d{4}$/.test(year)) fail("Choose a valid year.");
    if (month && !/^(0?[1-9]|1[0-2])$/.test(month)) fail("Choose a valid month.");
    condition.month = { $regex: `^${year || "[0-9]{4}"}-${month ? month.padStart(2, "0") : "[0-9]{2}"}$` };
  }
  const page = Math.max(1, parseInt(req.query.page, 10) || 1), limit = 25;
  const [rows, total] = await Promise.all([
    Models.ReturnFinanceReport.find(condition).select("merchant month merchant_name generated_at").sort({ month: -1, merchant_name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Models.ReturnFinanceReport.countDocuments(condition),
  ]);
  res.send({ data: { rows, total, page } });
}));
router.post("/", Auth.requireSuperAdmin, handler(async (req, res) => {
  const merchantId = id(req.body.merchantId);
  Auth.assertMerchantAccess(req.user, String(merchantId));
  const merchant = await Services.Merchant.get({ _id: merchantId }, { name: 1, shop_id: 1, address: 1, address1: 1, address2: 1, city: 1, province_code: 1, province: 1, zip: 1, country: 1 });
  if (!merchant) fail("Merchant not found.", 404);
  const data = await Services.ReturnFinance.generate(merchant, req.body.month);
  res.send({ data, message: "Returns report generated." });
}));
router.get("/:id", handler(async (req, res) => {
  const report = await Models.ReturnFinanceReport.findOne({ ...scope(req), _id: id(req.params.id) }).lean();
  if (!report) fail("Report not found.", 404);
  const snapshot = resolvedSnapshot(report.snapshot);
  if (!snapshot.rows.length) fail("This report has no recorded Stripe payments or refunds from resolved returns. Generate it again to use the latest records.", 404);
  res.send({ data: { ...report, snapshot } });
}));
router.get("/:id/pdf", handler(async (req, res) => {
  const report = await Models.ReturnFinanceReport.findOne({ ...scope(req), _id: id(req.params.id) }).lean();
  if (!report) fail("Report not found.", 404);
  const snapshot = resolvedSnapshot(report.snapshot);
  if (!snapshot.rows.length) fail("This report has no recorded Stripe payments or refunds from resolved returns. Generate it again to use the latest records.", 404);
  const pdf = await createPdf({ ...snapshot, report_id: String(report._id) });
  res.set("Content-Type", "application/pdf");
  res.set("Cache-Control", "private, no-store");
  res.set("Content-Disposition", `attachment; filename="returns-${report.month}.pdf"`);
  res.send(pdf);
}));
router.delete("/:id", Auth.requireSuperAdmin, handler(async (req, res) => {
  const result = await Models.ReturnFinanceReport.deleteOne({ ...scope(req), _id: id(req.params.id) });
  if (!result.deletedCount) fail("Report not found.", 404);
  res.send({ message: "Returns report deleted." });
}));
module.exports = router;
