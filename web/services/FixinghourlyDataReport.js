/**
 * services/computeDailySwipeReport.js
 *
 * PURPOSE:
 * - Dashboard / CRON wali logic ko FORCE / ADMIN ke liye trigger karna
 * - Koi bhi business logic yahan duplicate NAHI hoti
 *
 * SOURCE OF TRUTH:
 * - controllers/cron/computeDailySwipeReport.js
 */

const mongoose = require("mongoose");
const moment = require("moment-timezone");
const Models = require("../models");
const DailyReport = require("../models/DailyReport");

const TZ = "America/Chicago";

const toObjectId = (v) =>
  v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(v);

const toCents = (n) => Math.round((Number(n) || 0) * 100);

const toUSD = (cents) =>
  "$" +
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const isSwipeItem = (li = {}) => {
  const sku = String(li.sku || "").toLowerCase();
  const title = String(li.title || "").toLowerCase();
  const vendor = String(li.vendor || "").toLowerCase();
  const ptype = String(li.product_type || "").toLowerCase();

  return (
    sku === "swipe" ||
    sku.includes("swipe") ||
    title.includes("swipe") ||
    title.includes("package protection") ||
    title.includes("shipping protection") ||
    title.includes("route protection") ||
    vendor.includes("swipe") ||
    ptype.includes("protection")
  );
};


function allocateAllDiscountsToLines(order) {
  const orderLines = Array.isArray(order.line_items) ? order.line_items : [];
  const swipeLines = orderLines.filter(isSwipeItem);
  const out = new Map(orderLines.map((li) => [li.id, 0]));

  for (const li of swipeLines) {
    const allocC = (li.discount_allocations || []).reduce((s, a) => {
      const amt = Number(a.amount ?? a.amount_set?.shop_money?.amount ?? 0);
      return s + toCents(amt);
    }, 0);

    if (allocC > 0) {
      out.set(li.id, allocC);
      continue;
    }

    const totalsC = toCents(
      Number(
        li.discount_total ??
          li.total_discount ??
          li.total_discount_set?.shop_money?.amount ??
          0
      )
    );
    out.set(li.id, totalsC);
  }

  return out;
}

function buildPerUnitSwipeDiscountMap(orders) {
  const byOrder = new Map();

  for (const o of orders || []) {
    const swipeItems = (o.line_items || []).filter(isSwipeItem);
    if (!swipeItems.length) continue;

    const alloc = allocateAllDiscountsToLines(o);
    const lineMap = new Map();

    for (const li of swipeItems) {
      const qty = Math.max(1, Number(li.quantity || 1));
      const allocC = alloc.get(li.id) || 0;
      lineMap.set(li.id, Math.round(allocC / qty));
    }

    byOrder.set(String(o.order_number), lineMap);
  }

  return byOrder;
}


async function computeHourlyForDay_Service(merchantId, ymd) {
  const mId = toObjectId(merchantId);

  const dayStart = moment.tz(ymd, TZ).startOf("day").toDate();
  const dayEnd = moment.tz(ymd, TZ).endOf("day").toDate();

  // 1️⃣ Orders (indexable: uses order_created_at directly)
  // NOTE: If you have legacy data with missing order_created_at, run the backfill script:
  //   node web/script/backfill-order-created-at.js
  const orders = await Models.Order.aggregate([
    {
      $match: {
        merchant: mId,
        tracking_status: { $ne: "cancelled" },
        cancelled_at: null,
        order_created_at: { $gte: dayStart, $lte: dayEnd },
      },
    },
    {
      $addFields: {
        hour: {
          $hour: {
            date: "$order_created_at",
            timezone: TZ,
          },
        },
      },
    },
  ]).allowDiskUse(true);

  // 2️⃣ Init 24 hours (always)
  const hourly = new Array(24).fill(0).map((_, hour) => ({
    hour,
    ymdH: moment.tz(ymd, TZ).hour(hour).format("YYYY-MM-DD-HH"),
    total_orders_all: 0,
    total_protected_orders: 0,
    total_gross_sales_c: 0,
    swipe_discounts_c: 0,
    gross_returns_amount_c: 0,
    net_returns_amount_c: 0,
  }));

  const protectedOrders = [];

  // 3️⃣ Orders → buckets
  for (const o of orders) {
    if (o.hour < 0 || o.hour > 23) continue;

    hourly[o.hour].total_orders_all += 1;

    if (o.is_protected === true) {
      hourly[o.hour].total_protected_orders += 1;
      protectedOrders.push(o);
    }
  }

  const perUnitDiscMap = buildPerUnitSwipeDiscountMap(protectedOrders);

  // 4️⃣ Sales + discounts
  for (const o of protectedOrders) {
    const h = o.hour;
    const swipeItems = (o.line_items || []).filter(isSwipeItem);
    const alloc = allocateAllDiscountsToLines(o);

    for (const li of swipeItems) {
      const qty = Math.max(1, Number(li.quantity || 1));
      const unit = Number(li.price || 0);
      hourly[h].total_gross_sales_c += toCents(unit * qty);
      hourly[h].swipe_discounts_c += alloc.get(li.id) || 0;
    }
  }

  // 5️⃣ Refunds (same logic as dashboard)
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
              created_at_d: {
                $cond: [
                  { $eq: [{ $type: "$$r.created_at" }, "string"] },
                  { $toDate: "$$r.created_at" },
                  "$$r.created_at",
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
                {
                  $gte: [
                    { $ifNull: ["$$r.processed_at_d", "$$r.created_at_d"] },
                    dayStart,
                  ],
                },
                {
                  $lte: [
                    { $ifNull: ["$$r.processed_at_d", "$$r.created_at_d"] },
                    dayEnd,
                  ],
                },
              ],
            },
          },
        },
      },
    },
    { $match: { "refunds_in_range.0": { $exists: true } } },
    { $project: { payload: 1, refunds_in_range: 1 } },
  ]).allowDiskUse(true);

  for (const so of specials) {
    const p = so.payload || {};
    const orderNum = String(p.order_number || "");

    for (const r of so.refunds_in_range || []) {
      const hour = moment(r.processed_at_d || r.created_at_d)
        .tz(TZ)
        .hour();

      if (hour < 0 || hour > 23) continue;

      for (const rli of r.refund_line_items || []) {
        const li = rli.line_item || {};
        if (!isSwipeItem(li)) continue;

        const qty = Number(rli.quantity || 0);
        const unit = Number(li.price || 0);
        const gross = toCents(unit * qty);

        hourly[hour].gross_returns_amount_c += gross;

        const perUnit =
          perUnitDiscMap.get(orderNum)?.get(li.id) || 0;

        hourly[hour].net_returns_amount_c += Math.max(
          0,
          gross - perUnit * qty
        );
      }
    }
  }

  // 6️⃣ Final format (same as dashboard)
  return hourly.map((h) => ({
    ymdH: h.ymdH,
    hour: h.hour,
    net_items_sold: h.total_protected_orders,
    protected_order_percentage:
      h.total_orders_all > 0
        ? `${(
            (h.total_protected_orders * 100) /
            h.total_orders_all
          ).toFixed(2)}%`
        : "0.00%",
    total_gross_sales: toUSD(h.total_gross_sales_c),
    swipe_discounts: toUSD(h.swipe_discounts_c * -1),
    gross_returns_amount: toUSD(h.gross_returns_amount_c * -1),
    net_returns_amount: toUSD(h.net_returns_amount_c * -1),
    net_sales: toUSD(
      h.total_gross_sales_c -
        h.swipe_discounts_c -
        h.net_returns_amount_c
    ),
  }));
}

async function fixMissingHoursOnly(merchantId, ymd) {
  const mId = toObjectId(merchantId);

  console.log(
    "🧩 FIX MISSING HOURS ONLY (SERVICE DASHBOARD-EQUIVALENT):",
    mId.toString(),
    ymd
  );

  const hourly = await computeHourlyForDay_Service(mId, ymd);

  await DailyReport.updateOne(
    { merchant: mId, date: ymd },
    {
      $set: {
        hourly_stats: hourly,
        computed_at: new Date(),
      },
    },
    { upsert: true }
  );

  return {
    merchantId: mId.toString(),
    date: ymd,
    hours: hourly.length,
    mode: "service_hourly_only",
  };
}




async function forceFixFullDay(merchantId, ymd) {
  const mId = toObjectId(merchantId);

  console.log(
    "🚀 FORCE FULL DAY FIX (DASHBOARD LOGIC):",
    mId.toString(),
    ymd
  );

  // 1️⃣ Remove stale report
  await DailyReport.deleteOne({
    merchant: mId,
    date: ymd,
  });

  // 2️⃣ FIX HOURLY FIRST (IMPORTANT)
const hourly = await computeHourlyForDay_Service(mId, ymd);


  await DailyReport.updateOne(
    { merchant: mId, date: ymd },
    {
      $set: {
        hourly_stats: hourly,
        computed_at: new Date(),
      },
    },
    { upsert: true }
  );

  // 3️⃣ THEN FIX DAILY
  await computeDailyForDate(mId, ymd);

  // 4️⃣ Return final state
  const report = await DailyReport.findOne(
    { merchant: mId, date: ymd }
  ).lean();

  return {
    merchantId: mId.toString(),
    date: ymd,
    recomputed_using: "dashboard_cron_logic",
    hourly_hours: Array.isArray(hourly) ? hourly.length : 0,
    hasReport: !!report,
  };
}




/* ------------------------------------------------------------------
   EXPORTS
-------------------------------------------------------------------*/

module.exports = {
  forceFixFullDay,
  fixMissingHoursOnly,
};
