const crypto = require("crypto");
const { eventsFromDetails } = require("../utils/returnFinance");
const ReturnSchema = Models.Return;
const ReturnLookupAttemptSchema = Models.ReturnLookupAttempt;

const ReturnService = {};

const money = (amount, currency) => ({ amount, currency });

ReturnService.recordLookupAttempt = async ({ ip, shop }) => {
  const windowMs = 15 * 60 * 1000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const rawKey = `${String(ip || "unknown")}:${String(shop || "unknown")}:${windowStart}`;
  const key = crypto.createHash("sha256").update(rawKey).digest("hex");
  const expiresAt = new Date(windowStart + windowMs);
  const record = await ReturnLookupAttemptSchema.findOneAndUpdate(
    { key },
    {
      $inc: { attempts: 1 },
      $setOnInsert: { expires_at: expiresAt },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, lean: true }
  );

  if (record.attempts > 5) {
    const error = new Error("Too many attempts. Please try again in 15 minutes.");
    error.status = 429;
    throw error;
  }

  return record.attempts;
};

ReturnService.get = async (condition, projection = {}, options = { lean: true }) =>
  ReturnSchema.findOne(condition, projection, options);

// Chronological request number for this email in this store, including this return.
ReturnService.customerReturnNumber = async (record) => {
  const email = String(record.customer?.email || "").trim();
  const createdAt = record.createdAt && new Date(record.createdAt);
  if (!record.merchant || !record._id || !email || !createdAt || Number.isNaN(createdAt.getTime())) {
    return null;
  }
  const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const previous = await ReturnSchema.countDocuments({
    merchant: record.merchant._id || record.merchant,
    "customer.email": { $regex: `^\\s*${escapedEmail}\\s*$`, $options: "i" },
    $or: [
      { createdAt: { $lt: createdAt } },
      { createdAt, _id: { $lt: record._id } },
    ],
  });
  return previous + 1;
};

ReturnService.updateOne = async (condition, update, options = {}) =>
  ReturnSchema.findOneAndUpdate(condition, update, {
    new: true,
    runValidators: true,
    lean: true,
    ...options,
  });

ReturnService.create = async ({
  merchant,
  order,
  shop,
  outcome,
  customer,
  items,
  summary,
  policy,
  idempotencyKey,
  status,
  reviewReason,
  autoApproved,
  shopifyPayload,
}) => {
  if (idempotencyKey) {
    const existing = await ReturnService.get({
      merchant: merchant._id,
      idempotency_key: idempotencyKey,
    });
    if (existing) return existing;
  }

  const baseNumber = String(order.name || `#${order.order_number || order.number}`)
    .replace(/-R\d+$/i, "")
    .replace(/^#/, "")
    .trim();
  const currency = summary.currency || order.currency || "USD";
  const publicToken = crypto.randomBytes(32).toString("hex");
  const returnNumber = baseNumber;

  const created = await new ReturnSchema({
    merchant: merchant._id,
    order: order._id,
    shop,
    shopify_order_id:
      order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`,
    shopify_return_id: shopifyPayload?.id,
    return_number: returnNumber,
    public_token: publicToken,
    idempotency_key: idempotencyKey,
    status,
    outcome,
    customer,
    items,
    subtotal: money(summary.subtotal, currency),
    restocking_fee: money(summary.restocking_fee, currency),
    return_shipping_fee: money(summary.return_shipping_fee, currency),
    refund_total: money(summary.refund_total, currency),
    exchange_total: money(summary.exchange_total, currency),
    store_credit_total: money(summary.store_credit_total, currency),
    revenue_kept: money(summary.revenue_kept, currency),
    policy_snapshot: policy,
    auto_approved: Boolean(autoApproved),
    review_reason: reviewReason,
    shopify_payload: shopifyPayload,
    timeline: [
      {
        status,
        label: status === "approved" ? "Return approved" : "Return requested",
        detail: reviewReason || "Your return request was received.",
      },
    ],
    approved_at: status === "approved" ? new Date() : undefined,
  }).save();

  return created.toObject();
};

ReturnService.updateStatus = async (
  returnId,
  status,
  { label, detail, set = {} } = {}
) =>
  ReturnSchema.findOneAndUpdate(
    { _id: returnId },
    {
      $set: { status, ...set },
      ...(eventsFromDetails(set).length ? { $addToSet: { finance_events: { $each: eventsFromDetails(set) } } } : {}),
      $push: {
        timeline: {
          status,
          label: label || status.replace(/_/g, " "),
          detail,
          created_at: new Date(),
        },
      },
    },
    { new: true, runValidators: true, lean: true }
  );

ReturnService.attachLabel = async (returnId, labelData) =>
  ReturnSchema.findOneAndUpdate(
    { _id: returnId },
    {
      $set: {
        status: "label_ready",
        easypost: labelData,
      },
      $addToSet: { finance_events: { $each: eventsFromDetails({ easypost: labelData }) } },
      $push: {
        timeline: {
          status: "label_ready",
          label: "Return label ready",
          detail: "Use the QR code or download the printable label.",
          created_at: new Date(),
        },
      },
    },
    { new: true, runValidators: true, lean: true }
  );

ReturnService.list = async ({
  merchantId,
  merchantIds,
  status,
  search,
  startDate,
  endDate,
  page = 1,
  limit = 25,
  view = "full",
}) => {
  const merchantCondition = {};
  if (merchantId) {
    merchantCondition.merchant = merchantId;
  } else if (Array.isArray(merchantIds)) {
    merchantCondition.merchant = { $in: merchantIds };
  }
  const condition = { ...merchantCondition };
  const selectedStatuses = (Array.isArray(status) ? status : String(status || "").split(","))
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (selectedStatuses.length && !selectedStatuses.includes("all")) {
    condition.status = { $in: [...new Set(selectedStatuses.flatMap((value) =>
      value === "needs_review" ? ["requested", "needs_review"] : [value]
    ))] };
  }
  if (search) {
    condition.$or = [
      { return_number: { $regex: search, $options: "i" } },
      { "customer.name": { $regex: search, $options: "i" } },
      { "customer.email": { $regex: search, $options: "i" } },
    ];
  }
  const createdAt = {};
  const parsedStartDate = startDate ? new Date(startDate) : null;
  const parsedEndDate = endDate ? new Date(endDate) : null;
  if (parsedStartDate && !Number.isNaN(parsedStartDate.getTime())) {
    createdAt.$gte = parsedStartDate;
  }
  if (parsedEndDate && !Number.isNaN(parsedEndDate.getTime())) {
    createdAt.$lte = parsedEndDate;
  }
  if (Object.keys(createdAt).length) condition.createdAt = createdAt;

  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);
  // Keep the legacy response for other callers; the dashboard can fetch rows
  // independently of slower counts and filter metadata.
  const rowsQuery = () => ReturnSchema.find(condition, view === "rows" ? {
    _id: 1, merchant: 1, shop: 1, return_number: 1, status: 1, outcome: 1,
    "customer.email": 1, "customer.name": 1, "items.quantity": 1,
    "items.title": 1, subtotal: 1, createdAt: 1,
  } : {})
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean();
  if (view === "rows") {
    return { rows: await rowsQuery(), page: safePage, limit: safeLimit };
  }
  const [rows, total, needsReview, availableStatuses] = await Promise.all([
    view === "summary" ? undefined : rowsQuery(),
    ReturnSchema.countDocuments(condition),
    ReturnSchema.countDocuments({
      ...merchantCondition,
      status: { $in: ["requested", "needs_review"] },
    }),
    ReturnSchema.distinct("status", merchantCondition),
  ]);

  return { ...(view === "summary" ? {} : { rows }), total, needs_review: needsReview, available_statuses: availableStatuses, page: safePage, limit: safeLimit };
};

ReturnService.analytics = async (merchantId, days = 30, merchantIds, range = {}) => {
  const allTime = range.allTime === true && !range.startDate && !range.endDate;
  const dayMs = 24 * 60 * 60 * 1000;
  let periodDays = Math.max(1, Math.min(365, Number(days) || 30));
  let currentEnd = new Date();
  let currentStart = new Date(currentEnd.getTime() - periodDays * dayMs);
  if (range.startDate || range.endDate) {
    const start = new Date(range.startDate);
    const end = new Date(range.endDate);
    if (!range.startDate || !range.endDate || !Number.isFinite(start.getTime()) ||
        !Number.isFinite(end.getTime()) || end < start || !Number.isFinite(end.getTime() + 1) ||
        Number.isNaN(new Date(end.getTime() + 1).getTime())) {
      const error = new Error("Choose a valid analytics start and end date.");
      error.status = 400;
      throw error;
    }
    currentStart = start;
    currentEnd = new Date(end.getTime() + 1);
    periodDays = Math.ceil((currentEnd - currentStart) / dayMs);
  }
  const previousStart = new Date(currentStart.getTime() - (currentEnd - currentStart));
  const condition = allTime ? {} : { createdAt: { $gte: previousStart, $lt: currentEnd } };
  if (merchantId) {
    condition.merchant = merchantId;
  } else if (Array.isArray(merchantIds)) {
    condition.merchant = { $in: merchantIds };
  }
  const rows = await ReturnSchema.find(condition, {
    createdAt: 1, outcome: 1, revenue_kept: 1, status: 1, "items.title": 1,
    "items.reason_label": 1, "items.reason_code": 1, "items.quantity": 1,
  }).lean();

  const summarize = (items) => {
    const reasons = {};
    const products = new Map();
    let revenueKept = 0;
    let exchangeCount = 0;
    let needsReview = 0;
    items.forEach((item) => {
      revenueKept += Number(item.revenue_kept?.amount || 0);
      if (item.outcome === "exchange") exchangeCount += 1;
      if (["requested", "needs_review"].includes(item.status)) needsReview += 1;
      (item.items || []).forEach((returnItem) => {
        const label = returnItem.reason_label || returnItem.reason_code || "Other";
        reasons[label] = (reasons[label] || 0) + Number(returnItem.quantity || 0);
        const title = returnItem.title || "Item";
        products.set(title, (products.get(title) || 0) + Number(returnItem.quantity || 0));
      });
    });
    return {
      returns: items.length,
      needs_review: needsReview,
      top_products: [...products.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      revenue_kept: Math.round(revenueKept * 100) / 100,
      exchange_rate: items.length
        ? Math.round((exchangeCount / items.length) * 1000) / 10
        : 0,
      reasons,
    };
  };

  const current = summarize(allTime ? rows : rows.filter((row) => row.createdAt >= currentStart));
  const previous = allTime ? null : summarize(rows.filter((row) => row.createdAt < currentStart));
  return { period_days: allTime ? null : periodDays, current, previous };
};

module.exports = ReturnService;
