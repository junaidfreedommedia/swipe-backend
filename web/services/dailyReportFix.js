/**
 * services/dailyReportFix.js
 *
 * PURPOSE:
 * - Recompute DAILY report for ONE merchant + ONE date
 * - EXACT SAME LOGIC as cron computeDailyForDate
 * - Hourly stats are PRESERVED
 * - No deletes, no skips, no cron side-effects
 */

const mongoose = require("mongoose");
const moment = require("moment-timezone");
const Models = require("../models");
const DailyReport = require("../models/DailyReport");
const { runWithOptionalHint } = require("../utils/mongooseHint");

const TZ = "America/Chicago";
const REPORT_VERSION = 3;

const toOID = (v) =>
  v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(v);

const toCents = (n) => Math.round((Number(n) || 0) * 100);
const fmtCents = (c) => (Number(c || 0) / 100).toFixed(2);
const fmtNeg = (c) => (c > 0 ? `-${fmtCents(c)}` : "0.00");
const fmtUSD = (n) =>
  `$${Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/* =========================
   SWIPE IDENTIFIER (SAME)
========================= */
const isSwipe = (li = {}) => {
  const t = String(li.title || "").toLowerCase();
  const s = String(li.sku || "").toLowerCase();
  const v = String(li.vendor || "").toLowerCase();
  const p = String(li.product_type || "").toLowerCase();

  return (
    s === "swipe" ||
    t.includes("swipe package protection") ||
    t.includes("shipping protection") ||
    t.includes("route protection") ||
    t.includes("swipe") ||
    v.includes("swipe") ||
    p.includes("protection")
  );
};

const isNetItemSoldSwipeItem = (li = {}) => {
  const title = String(li.title || "").toLowerCase();
  const sku = String(li.sku || "").toLowerCase();
  return title.includes("swipe package protection") || sku === "swipe";
};

const getSwipeLinesFromOrder = (order = {}) => {
  const raw = Array.isArray(order.line_items) ? order.line_items : [];
  const lines = raw.filter(isSwipe);
  if (lines.length) return lines;

  const protectionItem = order.protection_item || {};
  const fallbackQty = Math.max(
    1,
    Number(protectionItem.quantity || order.protection_quantity || 1)
  );
  const fallbackTotal = Number(
    order.protection_amount ??
      order.protection_fee ??
      protectionItem.final_price ??
      protectionItem.price ??
      0
  );
  const fallbackUnit = Number(
    protectionItem.price ??
      protectionItem.price_set?.shop_money?.amount ??
      (fallbackQty > 0 ? fallbackTotal / fallbackQty : fallbackTotal)
  );
  const hasProtection =
    order.is_protected || !!order.protection_item || fallbackTotal > 0;

  if (!hasProtection) return [];

  return [
    {
      id: protectionItem.id || "__synthetic_swipe",
      title: protectionItem.title || "Swipe Package Protection",
      sku: protectionItem.sku || "swipe",
      quantity: fallbackQty,
      price: fallbackUnit || 0,
      discount_total: 0,
      total_discount: 0,
      discount_allocations: [],
    },
  ];
};

const getProtectedItemQty = (order = {}) => {
  const raw = Array.isArray(order.line_items) ? order.line_items : [];
  const matchedLines = raw.filter(isNetItemSoldSwipeItem);
  if (matchedLines.length) {
    return matchedLines.reduce(
      (sum, li) => sum + Math.max(1, Number(li.quantity || 1)),
      0
    );
  }

  const protectionItem = order.protection_item || {};
  if (isNetItemSoldSwipeItem(protectionItem) || order.is_protected) {
    return Math.max(
      1,
      Number(protectionItem.quantity || order.protection_quantity || 1)
    );
  }

  return 0;
};

/* =========================
   MAIN FIX FUNCTION
========================= */
async function fixDailyOnly(merchantId, ymd) {
  const mId = toOID(merchantId);
  const dayStart = moment.tz(ymd, TZ).startOf("day").toDate();
  const dayEnd = moment.tz(ymd, TZ).endOf("day").toDate();

  /* ----------------------------------------------------
     0️⃣ Preserve hourly (ONLY difference vs cron)
  ---------------------------------------------------- */
  const existing = await DailyReport.findOne({
    merchant: mId,
    date: ymd,
  }).lean();

  const preservedHourly = existing?.hourly_stats || [];

  /* ----------------------------------------------------
     1️⃣ ORDERS (CRON-EQUIVALENT)
  ---------------------------------------------------- */
  const orderSelect = {
    order_number: 1,
    order_created_at: 1,
    line_items: 1,
    discount_applications: 1,
    refunds: 1,
    fulfillments: 1,
    protection_item: 1,
    protection_amount: 1,
    is_protected: 1,
    total_price_set: 1,
    final_total_price: 1,
    total_price: 1,
    total_line_items_price: 1,
    total_discounts: 1,
    total_discounts_set: 1,
  };

  const [createdOrders, refundedOrders] = await Promise.all([
    runWithOptionalHint(
      (hintName) => {
        const query = Models.Order.find({
          merchant: mId,
          is_protected: true,
          order_created_at: { $gte: dayStart, $lte: dayEnd },
        })
          .select(orderSelect)
          .lean();
        return hintName ? query.hint(hintName) : query;
      },
      "merchant_protected_created_idx",
      "services/dailyReportFix created orders"
    ),

    runWithOptionalHint(
      (hintName) => {
        const query = Models.Order.find({
          merchant: mId,
          is_protected: true,
          "refunds.processed_at": { $gte: dayStart, $lte: dayEnd },
        })
          .select(orderSelect)
          .lean();
        return hintName ? query.hint(hintName) : query;
      },
      "merchant_protected_refunds_processed_idx",
      "services/dailyReportFix refunded orders"
    ),
  ]);

  const ordersAllMap = new Map();
  for (const o of [...createdOrders, ...refundedOrders]) {
    const key = String(o?.order_number ?? o?._id ?? "");
    if (!key) continue;
    if (!ordersAllMap.has(key)) ordersAllMap.set(key, o);
  }
  const ordersAll = [...ordersAllMap.values()];

  /* ----------------------------------------------------
     2️⃣ DISCOUNT ALLOCATION (UNCHANGED)
  ---------------------------------------------------- */
  function allocateAllDiscountsToLines(order) {
    const orderLines = order.line_items || [];
    const swipeLines = orderLines.filter(isSwipe);
    const out = new Map(orderLines.map(li => [li.id, 0]));

    for (const li of swipeLines) {
      const alloc = (li.discount_allocations || []).reduce(
        (s, a) => s + toCents(a.amount || 0),
        0
      );
      if (alloc > 0) out.set(li.id, alloc);
      else {
        const total = toCents(
          li.discount_total ||
          li.total_discount ||
          li.total_discount_set?.shop_money?.amount ||
          0
        );
        out.set(li.id, total);
      }
    }
    return out;
  }

  /* ----------------------------------------------------
     3️⃣ SALES + DISCOUNTS
  ---------------------------------------------------- */
  let totalGrossSalesC = 0;
  let totalSwipeDiscountsC = 0;
  const totalProtectedItemsSold = createdOrders.reduce(
    (sum, order) => sum + getProtectedItemQty(order),
    0
  );
  const perUnitSwipeDiscountByOrder = new Map();

  for (const order of ordersAll) {
    const swipeItems = getSwipeLinesFromOrder(order);
    if (!swipeItems.length) continue;

    const allocMap = allocateAllDiscountsToLines(order);
    const lineMap = new Map();
    perUnitSwipeDiscountByOrder.set(String(order.order_number), lineMap);

    for (const li of swipeItems) {
      const qty = Math.max(1, Number(li.quantity || 1));
      const unit = Number(li.price || 0);
      totalGrossSalesC += toCents(qty * unit);

      const allocC = allocMap.get(li.id) || 0;
      totalSwipeDiscountsC += allocC;

      lineMap.set(li.id, Math.round(allocC / qty));
    }
  }

  /* ----------------------------------------------------
     4️⃣ REFUNDS (SAME-DAY vs PREVIOUS-DAY)
  ---------------------------------------------------- */
  const specials = await Models.SpecialOrder.aggregate([
    { $match: { merchant: mId, "payload.line_items.sku": "swipe" } },
    {
      $addFields: {
        refunds_cast: {
          $map: {
            input: { $ifNull: ["$payload.refunds", []] },
            as: "r",
            in: {
              processed_at_d: {
                $cond: [
                  { $eq: [{ $type: "$$r.processed_at" }, "string"] },
                  { $toDate: "$$r.processed_at" },
                  "$$r.processed_at",
                ],
              },
              refund_line_items: "$$r.refund_line_items",
            },
          },
        },
      },
    },
    {
      $addFields: {
        refunds_in_range: {
          $filter: {
            input: "$refunds_cast",
            as: "r",
            cond: {
              $and: [
                { $gte: ["$$r.processed_at_d", dayStart] },
                { $lte: ["$$r.processed_at_d", dayEnd] },
              ],
            },
          },
        },
      },
    },
    { $match: { "refunds_in_range.0": { $exists: true } } },
  ]).allowDiskUse(true);

  let grossReturnC = 0;
  let netReturnC = 0;
  let todayReturns = 0;
  let previousReturns = 0;
  for (const so of specials) {
    const p = so.payload || {};
    const orderCreatedAt = moment(
      p.order_created_at || p.created_at || so.createdAt
    ).tz(TZ);

    for (const r of so.refunds_in_range || []) {
      const rt = moment(r.processed_at_d).tz(TZ);
      const sameDay = rt.format("YYYY-MM-DD") === orderCreatedAt.format("YYYY-MM-DD");

      for (const rli of r.refund_line_items || []) {
        const li = rli.line_item || {};
        const qty = Number(rli.quantity || 0);
        if (!qty) continue;
        const isNetItemSoldLine = isNetItemSoldSwipeItem(li);
        if (!isSwipe(li)) continue;

        const unit = Number(li.price || 0);
        const gross = toCents(unit * qty);

        grossReturnC += gross;

        const perUnit =
          perUnitSwipeDiscountByOrder
            .get(String(p.order_number))
            ?.get(li.id) || 0;

        netReturnC += Math.max(0, gross - perUnit * qty);

        if (isNetItemSoldLine && sameDay) todayReturns += qty;
        else if (isNetItemSoldLine) previousReturns += qty;
      }
    }
  }

  const totalRefundOrders = todayReturns + previousReturns;
  const netSalesC =
    totalGrossSalesC - totalSwipeDiscountsC - netReturnC;

  /* ----------------------------------------------------
     5️⃣ ORDER STATS (CRON SAME)
  ---------------------------------------------------- */
  const [orderStats] = await Models.Order.aggregate([
    {
      $match: {
        merchant: mId,
        tracking_status: { $ne: "cancelled" },
        cancelled_at: null,
        order_created_at: { $gte: dayStart, $lte: dayEnd },
      },
    },
    {
      $group: {
        _id: null,
        total_order: { $sum: 1 },
        protected_order: { $sum: { $cond: ["$is_protected", 1, 0] } },
        total_price: {
          $sum: {
            $cond: [
              "$is_protected",
              { $toDouble: "$total_price" },
              0,
            ],
          },
        },
        total_order_amount: {
          $sum: { $toDouble: "$total_line_items_price" },
        },
      },
    },
  ]).allowDiskUse(true);

  const stats = orderStats || {};
  const protectedPct =
    stats.total_order > 0
      ? `${((stats.protected_order * 100) / stats.total_order).toFixed(2)}%`
      : "0.00%";

  /* ----------------------------------------------------
     6️⃣ SAVE (HOURLY PRESERVED)
  ---------------------------------------------------- */
  await DailyReport.updateOne(
    { merchant: mId, date: ymd },
    {
      $set: {
        total_gross_sales: fmtCents(totalGrossSalesC),
        swipe_discounts: `-${fmtCents(totalSwipeDiscountsC)}`,
        gross_returns_amount: fmtNeg(grossReturnC),
        net_returns_amount: fmtNeg(netReturnC),
        net_sales: fmtCents(netSalesC),
        total_orders: ordersAll.length,
        net_items_sold: Math.max(0, totalProtectedItemsSold - totalRefundOrders),
        total_returns_count: totalRefundOrders,
        today_returns_count: todayReturns,
        previous_returns_count: previousReturns,
        total_price: fmtUSD(stats.total_price || 0),
        total_order_amount: fmtUSD(stats.total_order_amount || 0),
        protected_order_percentage: protectedPct,
        hourly_stats: preservedHourly,
        computed_at: new Date(),
        version: REPORT_VERSION,
      },
    },
    { upsert: true }
  );

  return {
    merchantId: mId.toString(),
    date: ymd,
    orders: ordersAll.length,
    returns: totalRefundOrders,
    fixed: true,
  };
}

module.exports = { fixDailyOnly };
