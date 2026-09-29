const express = require("express");
const router = express.Router();
const moment = require("moment-timezone");
const mongoose = require("mongoose");
const { Types } = mongoose;
const Models = require("../../models");
const DailyReport = require("../../models/DailyReport");
const { runWithOptionalHint } = require("../../utils/mongooseHint");
const { getMerchantTimezone } = require("../../utils/merchantTimezone");

const REPORT_VERSION = 8;
const ONLINE_STORE_APP_ID = 580111;

/* =========================
   SHARED HELPERS
========================= */
const toCents = (n) => Math.round((Number(n) || 0) * 100);
const fmtCents = (c) => (Number(c || 0) / 100).toFixed(2);
const fmtNeg = (c) => (c > 0 ? `-${fmtCents(c)}` : "0.00");
const fmtUSD = (n) =>
  `$${Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

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

const getProtectedOrderTotalCents = (order = {}) =>
  toCents(
    Number(
      order.total_price_set?.shop_money?.amount ??
        order.final_total_price ??
        order.total_price ??
        0
    )
  );

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

/* =========================================================
   HOURLY COMPUTE (NEW)
   - Runs from CRON too, so graph never freezes
   - Uses SAME dayStart/dayEnd and SAME swipe identification
   - Always returns 24 rows
========================================================= */
async function computeHourlyForDay(merchantId, ymd, explicitTimezone) {
  const mId =
    merchantId instanceof Types.ObjectId
      ? merchantId
      : new Types.ObjectId(merchantId);
  const timezone = await getMerchantTimezone(mId, explicitTimezone);

  const dayStart = moment.tz(ymd, timezone).startOf("day").toDate();
  const dayEnd = moment.tz(ymd, timezone).endOf("day").toDate();

  // Separate attach-rate counts from financial processing. Attach-rate counts
  // include cancelled orders; financial metrics keep the active-order filters.
  const [
    totalCountsByHour,
    protectedCountsByHour,
    protectedOrdersForProcessing,
  ] = await Promise.all([
    runWithOptionalHint(
      (hintName) => {
        const agg = Models.Order.aggregate([
          {
            $match: {
              merchant: mId,
              app_id: ONLINE_STORE_APP_ID,
              order_created_at: { $gte: dayStart, $lte: dayEnd },
            },
          },
          {
            $group: {
              _id: { $hour: { date: "$order_created_at", timezone } },
              count: { $sum: 1 },
            },
          },
        ]).option({ allowDiskUse: true });
        return hintName ? agg.hint(hintName) : agg;
      },
      "merchant_created_idx",
      "cron/computeHourlyForDay total counts"
    ),
    runWithOptionalHint(
      (hintName) => {
        const agg = Models.Order.aggregate([
          {
            $match: {
              merchant: mId,
              is_protected: true,
              app_id: ONLINE_STORE_APP_ID,
              order_created_at: { $gte: dayStart, $lte: dayEnd },
            },
          },
          {
            $group: {
              _id: { $hour: { date: "$order_created_at", timezone } },
              count: { $sum: 1 },
            },
          },
        ]).option({ allowDiskUse: true });
        return hintName ? agg.hint(hintName) : agg;
      },
      "merchant_created_idx",
      "cron/computeHourlyForDay protected attach counts"
    ),
    runWithOptionalHint(
      (hintName) => {
        const q = Models.Order.find({
          merchant: mId,
          is_protected: true,
          tracking_status: { $ne: "cancelled" },
          cancelled_at: null,
          order_created_at: { $gte: dayStart, $lte: dayEnd },
        })
          .select({
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
            total_discounts: 1,
            total_discounts_set: 1,
          })
          .lean();
        return hintName ? q.hint(hintName) : q;
      },
      "merchant_created_idx",
      "cron/computeHourlyForDay protected orders"
    ),
  ]);

  const totalOrdersCountMap = new Map();
  for (const row of totalCountsByHour) {
    const h = row._id;
    if (h == null || h < 0 || h > 23) continue;
    totalOrdersCountMap.set(h, row.count);
  }

  const protectedOrdersCountMap = new Map();
  for (const row of protectedCountsByHour) {
    const h = row._id;
    if (h == null || h < 0 || h > 23) continue;
    protectedOrdersCountMap.set(h, row.count);
  }

  const protectedItemsCountMap = new Map();
  for (const order of protectedOrdersForProcessing) {
    const hour = moment(order.order_created_at).tz(timezone).hour();
    if (hour == null || hour < 0 || hour > 23) continue;
    order.hour = hour; // make available to downstream allocation step
    protectedItemsCountMap.set(
      hour,
      (protectedItemsCountMap.get(hour) || 0) + getProtectedItemQty(order)
    );
  }

  // Full allocation logic (same structure as daily; duplicated here on purpose)
  function allocateAllDiscountsToLines_HOURLY(order) {
    const roundCentsHalfAway = (x) => {
      if (!isFinite(x)) return 0;
      const sign = x < 0 ? -1 : 1;
      x = Math.abs(x);
      x = Math.round(x * 1e6) / 1e6;
      const scaled = x * 100;
      const flo = Math.floor(scaled);
      const frac = scaled - flo;
      const cents =
        frac > 0.5
          ? Math.ceil(scaled)
          : frac < 0.5
          ? flo
          : flo % 2 === 0
          ? flo
          : flo + 1;
      return cents * sign;
    };

    const orderLines = Array.isArray(order.line_items) ? order.line_items : [];

    // fulfillment-level alloc merge (same as daily)
    const fulfillmentAllocByLineIdC = new Map();
    for (const f of order.fulfillments || []) {
      for (const fli of f.line_items || []) {
        const id = fli?.id;
        if (!id) continue;
        const allocC = (fli.discount_allocations || []).reduce((s, a) => {
          const amt = Number(a.amount ?? a.amount_set?.shop_money?.amount ?? 0);
          return s + toCents(amt);
        }, 0);
        if (allocC > 0) {
          const prev = fulfillmentAllocByLineIdC.get(id) || 0;
          if (allocC > prev) fulfillmentAllocByLineIdC.set(id, allocC);
        }
      }
    }

    const swipeLines = [
      ...new Map(
        orderLines.filter(isSwipe).map((li) => [String(li.id), li])
      ).values(),
    ];

    const outZero = new Map(orderLines.map((li) => [li.id, 0]));

    const takeAllocFrom = (li) => {
      const directC = (li.discount_allocations || []).reduce((s, a) => {
        const amt = Number(a.amount ?? a.amount_set?.shop_money?.amount ?? 0);
        return s + toCents(amt);
      }, 0);
      if (directC > 0) return directC;

      const totalDiscC = toCents(
        Number(li.total_discount ?? li.discount_total ?? 0)
      );
      if (totalDiscC > 0) return totalDiscC;

      return fulfillmentAllocByLineIdC.get(li.id) || 0;
    };

    const direct = swipeLines.reduce((s, li) => s + takeAllocFrom(li), 0);
    if (direct > 0) {
      const out = new Map(outZero);
      for (const li of swipeLines) out.set(li.id, takeAllocFrom(li));
      return out;
    }

    let refundSwipeAlloc = 0;
    for (const r of order.refunds || []) {
      for (const rli of r.refund_line_items || []) {
        const li = rli.line_item;
        if (!li || !isSwipe(li)) continue;
        refundSwipeAlloc += takeAllocFrom(li);
      }
    }
    if (refundSwipeAlloc > 0) {
      const out = new Map(outZero);
      for (const r of order.refunds || []) {
        for (const rli of r.refund_line_items || []) {
          const li = rli.line_item;
          if (!li || !isSwipe(li)) continue;
          const key = li.id ?? rli.line_item_id;
          out.set(key, (out.get(key) || 0) + takeAllocFrom(li));
        }
      }
      return out;
    }

    const totalsSum = swipeLines.reduce((sum, li) => {
      const amt = Number(
        li.discount_total ??
          li.total_discount ??
          li.total_discount_set?.shop_money?.amount ??
          0
      );
      return sum + toCents(amt);
    }, 0);
    if (totalsSum > 0) {
      const out = new Map(outZero);
      for (const li of swipeLines) {
        const amt = Number(
          li.discount_total ??
            li.total_discount ??
            li.total_discount_set?.shop_money?.amount ??
            0
        );
        out.set(li.id, toCents(amt));
      }
      return out;
    }

    // proportional allocator (same as daily)
    const lines = orderLines.map((li, idx) => {
      const qty = Math.max(1, Number(li.quantity || 1));
      const unit = Number(
        li.price_set?.shop_money?.amount ??
          li.price_set?.presentment_money?.amount ??
          li.price ??
          0
      );
      const pre = unit * qty;
      return {
        id: li.id,
        pos: idx,
        qty,
        isSwipe: isSwipe(li),
        discountable: li.discountable !== false && li.gift_card !== true,
        baseC: Math.round(pre * 100),
        curC: Math.round(pre * 100),
        curD: pre,
      };
    });

    const apps = order.discount_applications || [];
    const allocatedC = new Map(lines.map((l) => [l.id, 0]));
    const swipeIdSet = new Set(swipeLines.map((l) => l.id));

    const hasPct = apps.some(
      (a) => String(a.value_type || "").toLowerCase() === "percentage"
    );
    const hasFixedAcross = apps.some(
      (a) =>
        String(a.value_type || "").toLowerCase() === "fixed_amount" &&
        String(a.allocation_method || "").toLowerCase() === "across"
    );

    const distributeAcrossUnitLevel = (eligible, totalDiscountC, opts) => {
      if (totalDiscountC <= 0) return [];
      const units = [];
      for (const l of eligible) {
        const perUnitC = Math.floor(l.curC / l.qty);
        const rem = l.curC - perUnitC * l.qty;
        for (let i = 0; i < l.qty; i++) {
          const uC = perUnitC + (i < rem ? 1 : 0);
          units.push({
            lineId: l.id,
            pos: l.pos,
            priceC: uC,
            isSwipe: swipeIdSet.has(l.id),
          });
        }
      }
      const base = units.reduce((s, u) => s + u.priceC, 0);
      if (!base) return [];

      const rows = units.map((u, idx) => {
        const raw = (totalDiscountC * u.priceC) / base;
        const flo = Math.floor(raw);
        return {
          idx,
          lineId: u.lineId,
          pos: u.pos,
          isSwipe: u.isSwipe,
          raw,
          flo,
          frac: raw - flo,
        };
      });

      let sumFlo = rows.reduce((s, r) => s + r.flo, 0);
      let remainder = totalDiscountC - sumFlo;
      rows.sort(
        (a, b) => b.frac - a.frac || a.pos - b.pos || a.idx - b.idx
      );
      for (let i = 0; i < remainder; i++) rows[i % rows.length].flo++;

      if (opts?.preferSwipe) {
        const swipeRow = rows.find((r) => r.isSwipe);
        if (swipeRow) {
          const gotRemainder =
            Math.ceil(swipeRow.raw) - swipeRow.flo === 0 &&
            swipeRow.raw - swipeRow.flo > 0;
          if (!gotRemainder && swipeRow.frac >= 0.25) {
            const donor = rows
              .filter((r) => !r.isSwipe && r.flo > Math.floor(r.raw))
              .sort((a, b) => a.frac - b.frac || a.pos - b.pos)[0];
            if (donor && donor.flo > 0) {
              donor.flo -= 1;
              swipeRow.flo += 1;
            }
          }
        }
      }

      const byLine = new Map();
      for (const r of rows)
        byLine.set(r.lineId, (byLine.get(r.lineId) || 0) + r.flo);
      return [...byLine.entries()].map(([id, c]) => ({ id, c }));
    };

    for (const [appIndex, app] of apps.entries?.() || Object.entries(apps)) {
      const type = app?.type != null ? String(app.type).toLowerCase() : null;
      if (!type || !["manual", "automatic", "discount_code"].includes(type))
        continue;

      const method = String(app.allocation_method || "").toLowerCase();
      const vt = String(app.value_type || "").toLowerCase();
      const v = parseFloat(app.value) || 0;
      if (!vt) continue;

      let eligible = lines.filter((l) => {
        if (!l.discountable) return false;
        const target = String(app.target_selection || "").toLowerCase();
        if (target === "all") return true;
        if (target === "explicit") {
          const li = orderLines.find((x) => x.id === l.id);
          const allocs = li?.discount_allocations || [];
          return allocs.some(
            (a) => a.discount_application_index === Number(appIndex)
          );
        }
        return target === "entitled";
      });

      if (type === "automatic" || method === "each")
        eligible = eligible.filter((l) => !l.isSwipe);
      if (!eligible.length) continue;

      if (vt === "percentage") {
        const target = String(app.target_selection || "").toLowerCase();
        for (const l of eligible) {
          if (l.isSwipe && target !== "all") continue;
          const cents = roundCentsHalfAway((l.curD * v) / 100);
          if (cents <= 0) continue;
          allocatedC.set(l.id, (allocatedC.get(l.id) || 0) + cents);
          l.curC = Math.max(0, l.curC - cents);
          l.curD = l.curC / 100;
        }
        continue;
      }

      if (vt === "fixed_amount" && method === "across") {
        const vC = toCents(v);
        const eligibleBase = eligible.reduce((s, x) => s + x.curC, 0);
        const totalDiscountC = Math.min(vC, eligibleBase);
        if (totalDiscountC <= 0) continue;

        const shares = distributeAcrossUnitLevel(eligible, totalDiscountC, {
          preferSwipe: hasPct && hasFixedAcross,
        });
        for (const r of shares) {
          allocatedC.set(r.id, (allocatedC.get(r.id) || 0) + r.c);
          const line = eligible.find((x) => x.id === r.id);
          if (line) {
            line.curC = Math.max(0, line.curC - r.c);
            line.curD = line.curC / 100;
          }
        }
        continue;
      }
    }

    const out = new Map(orderLines.map((li) => [li.id, 0]));
    for (const li of swipeLines) out.set(li.id, allocatedC.get(li.id) || 0);
    return out;
  }

  // per-unit discount map for refunds net
  const perUnitSwipeDiscountByOrder = new Map();
  for (const order of protectedOrdersForProcessing) {
    const swipeItems = getSwipeLinesFromOrder(order);
    if (!swipeItems.length) continue;
    const alloc = allocateAllDiscountsToLines_HOURLY(order);
    const lm = new Map();
    perUnitSwipeDiscountByOrder.set(String(order.order_number), lm);
    for (const li of swipeItems) {
      const qty = Math.max(1, Number(li.quantity || 1));
      const allocC = alloc.get(li.id) || 0;
      lm.set(li.id, Math.round(allocC / qty));
    }
  }

  // init 24 hours
  const hourlyData = new Array(24).fill(0).map((_, hour) => ({
    hour,
    ymdH: moment.tz(ymd, timezone).hour(hour).format("YYYY-MM-DD-HH"),
    total_price_c: 0,
    total_gross_sales_c: 0,
    swipe_discounts_c: 0,
    total_protected_orders: protectedItemsCountMap.get(hour) || 0,
    attach_rate_protected_orders: protectedOrdersCountMap.get(hour) || 0,
    total_orders_all: totalOrdersCountMap.get(hour) || 0,
    net_returns_amount_c: 0,
    gross_returns_amount_c: 0,
  }));

  // sales + discounts
  for (const order of protectedOrdersForProcessing) {
    const hourIndex = order.hour;
    if (hourIndex == null || hourIndex < 0 || hourIndex > 23) continue;

    const h = hourlyData[hourIndex];
    h.total_price_c += getProtectedOrderTotalCents(order);

    const swipeItems = getSwipeLinesFromOrder(order);
    if (!swipeItems.length) continue;

    const allocations = allocateAllDiscountsToLines_HOURLY(order);

    for (const li of swipeItems) {
      const qty = Math.max(1, Number(li.quantity || 1));
      const unit = Number(li.price || 0);
      h.total_gross_sales_c += toCents(qty * unit);
      h.swipe_discounts_c += allocations.get(li.id) || 0;
    }
  }

  // refunds by hour (SpecialOrder)
  const specials = await Models.SpecialOrder.aggregate([
    {
      $match: {
        merchant: mId,
        "payload.line_items.sku": "swipe",
      },
    },
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
    { $project: { payload: 1, createdAt: 1, refunds_in_range: 1 } },
  ]).option({ allowDiskUse: true });

  for (const so of specials) {
    const p = so.payload || {};
    const orderNum = String(p.order_number || so.order_number || "");

    for (const r of so.refunds_in_range || []) {
      const refundTime = moment(r.processed_at_d || r.created_at_d).tz(timezone);
      const hourIndex = refundTime.hour();
      if (hourIndex < 0 || hourIndex > 23) continue;

      const h = hourlyData[hourIndex];

      for (const rli of r.refund_line_items || []) {
        const li = rli.line_item || {};
        if (!isSwipe(li) && String(li?.sku || "").toLowerCase() !== "swipe")
          continue;

        const qty = Number(rli.quantity || 0);
        if (!qty) continue;

        const unit = Number(li.price || 0);
        const gross = toCents(unit * qty);
        h.gross_returns_amount_c += gross;

        let perUnitDiscC = perUnitSwipeDiscountByOrder.get(orderNum)?.get(li.id);

        if (perUnitDiscC == null) {
          const allocFromRefundLineC = (li.discount_allocations || []).reduce(
            (s, a) => {
              const amt = Number(a?.amount ?? a?.amount_set?.shop_money?.amount ?? 0);
              return s + toCents(amt);
            },
            0
          );
          const origQtyLine = Math.max(1, Number(li.quantity || 1));
          perUnitDiscC = Math.round(allocFromRefundLineC / origQtyLine);

          if (!perUnitDiscC) {
            const totalsC = toCents(
              Number(
                li.discount_total ??
                  li.total_discount ??
                  li.total_discount_set?.shop_money?.amount ??
                  0
              )
            );
            perUnitDiscC = Math.round(totalsC / origQtyLine);
          }
        }

        const net = Math.max(0, gross - (perUnitDiscC || 0) * qty);
        h.net_returns_amount_c += net;
      }
    }
  }

  return hourlyData.map((h) => {
    const protectedPct =
      h.total_orders_all > 0
        ? (h.attach_rate_protected_orders * 100) / h.total_orders_all
        : 0.0;

    return {
      ymdH: h.ymdH,
      hour: h.hour,
      net_items_sold: h.total_protected_orders,
      protected_order_percentage: `${protectedPct.toFixed(2)}%`,
      total_price: fmtUSD(h.total_price_c / 100),
      total_gross_sales: fmtUSD(h.total_gross_sales_c / 100),
      swipe_discounts: fmtUSD((h.swipe_discounts_c * -1) / 100),
      gross_returns_amount: fmtUSD((h.gross_returns_amount_c * -1) / 100),
      net_returns_amount: fmtUSD((h.net_returns_amount_c * -1) / 100),
      net_sales: fmtUSD(
        (h.total_gross_sales_c - h.swipe_discounts_c - h.net_returns_amount_c) /
          100
      ),
    };
  });
}

/* =========================================================
   YOUR CURRENT DAILY (UNCHANGED LOGIC) + HOURLY INTEGRATION
========================================================= */
async function computeDailyForDate(merchantId, ymd, explicitTimezone) {
  const mId =
    merchantId instanceof Types.ObjectId
      ? merchantId
      : new Types.ObjectId(merchantId);
  const timezone = await getMerchantTimezone(mId, explicitTimezone);

  const dayStart = moment.tz(ymd, timezone).startOf("day").toDate();
  const dayEnd = moment.tz(ymd, timezone).endOf("day").toDate();

  // ✅ NEW: compute hourly as part of daily cron (so graph doesn't freeze)
  const todayYmd = moment.tz(timezone).format("YYYY-MM-DD");

  const existingForHourly = await DailyReport.findOne({
    merchant: mId,
    date: ymd,
    timezone,
  })
    .select({ hourly_stats: 1, version: 1 })
    .lean();

  const shouldComputeHourly =
    ymd !== todayYmd
      ? true
      : ymd === todayYmd ||
        !existingForHourly ||
        existingForHourly.version !== REPORT_VERSION ||
        (existingForHourly.hourly_stats?.length || 0) < 24;

  let hourlyStats = existingForHourly?.hourly_stats || [];

  if (shouldComputeHourly) {
    hourlyStats = await computeHourlyForDay(mId, ymd, timezone);

    // ✅ Persist hourly immediately (even if daily later decides "no data")
    await DailyReport.updateOne(
      { merchant: mId, date: ymd },
      {
        $set: {
          timezone,
          hourly_stats: hourlyStats,
          computed_at: new Date(),
        },
      },
      { upsert: true }
    );
  }

  // ---- ORIGINAL HELPERS (kept as-is from your file) ----
  const fmtCentsLocal = (c) => (Number(c || 0) / 100).toFixed(2);
  const fmtNegLocal = (c) => (c > 0 ? `-${fmtCentsLocal(c)}` : "0.00");
  const fmtUSDLocal = (n) =>
    `$${Number(n || 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const isSwipeLocal = (li = {}) => {
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

  // ---------------------------------------------------
  // ORDERS: pull BOTH
  // ---------------------------------------------------
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
      "merchant_created_idx",
      "cron/computeDailySwipeReport created orders"
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
      "cron/computeDailySwipeReport refunded orders"
    ),
  ]);

  const ordersAllMap = new Map();
  for (const o of [...createdOrders, ...refundedOrders]) {
    const key = String(o?.order_number ?? o?._id ?? "");
    if (!key) continue;
    if (!ordersAllMap.has(key)) ordersAllMap.set(key, o);
  }
  const ordersAll = [...ordersAllMap.values()];

  function allocateAllDiscountsToLines(order) {
    const roundCentsHalfAway = (x) => {
      if (!isFinite(x)) return 0;
      const sign = x < 0 ? -1 : 1;
      x = Math.abs(x);
      x = Math.round(x * 1e6) / 1e6;
      const scaled = x * 100;
      const flo = Math.floor(scaled);
      const frac = scaled - flo;
      const cents =
        frac > 0.5
          ? Math.ceil(scaled)
          : frac < 0.5
          ? flo
          : flo % 2 === 0
          ? flo
          : flo + 1;
      return cents * sign;
    };

    const orderLines = Array.isArray(order.line_items) ? order.line_items : [];

    // ✅ merge fulfillment-level discount_allocations into order line_items
    const fulfillmentAllocByLineIdC = new Map();
    for (const f of order.fulfillments || []) {
      for (const fli of f.line_items || []) {
        const id = fli?.id;
        if (!id) continue;
        const allocC = (fli.discount_allocations || []).reduce((s, a) => {
          const amt = Number(a.amount ?? a.amount_set?.shop_money?.amount ?? 0);
          return s + toCents(amt);
        }, 0);
        if (allocC > 0) {
          const prev = fulfillmentAllocByLineIdC.get(id) || 0;
          if (allocC > prev) fulfillmentAllocByLineIdC.set(id, allocC);
        }
      }
    }

    const swipeLines = [
      ...new Map(orderLines.filter(isSwipeLocal).map((li) => [String(li.id), li]))
        .values(),
    ];

    const outZero = new Map(orderLines.map((li) => [li.id, 0]));

    const takeAllocFrom = (li) => {
      // 1) direct allocations on line item
      const directC = (li.discount_allocations || []).reduce((s, a) => {
        const amt = Number(a.amount ?? a.amount_set?.shop_money?.amount ?? 0);
        return s + toCents(amt);
      }, 0);
      if (directC > 0) return directC;

      // 2) line-level totals (Shopify truth)
      const totalDiscC = toCents(Number(li.total_discount ?? li.discount_total ?? 0));
      if (totalDiscC > 0) return totalDiscC;

      // 3) ONLY if neither exists, then fulfillment fallback
      return fulfillmentAllocByLineIdC.get(li.id) || 0;
    };

    const direct = swipeLines.reduce((s, li) => s + takeAllocFrom(li), 0);
    if (direct > 0) {
      const out = new Map(outZero);
      for (const li of swipeLines) out.set(li.id, takeAllocFrom(li));
      return out;
    }

    let refundSwipeAlloc = 0;
    for (const r of order.refunds || []) {
      for (const rli of r.refund_line_items || []) {
        const li = rli.line_item;
        if (!li || !isSwipeLocal(li)) continue;
        refundSwipeAlloc += takeAllocFrom(li);
      }
    }
    if (refundSwipeAlloc > 0) {
      const out = new Map(outZero);
      for (const r of order.refunds || []) {
        for (const rli of r.refund_line_items || []) {
          const li = rli.line_item;
          if (!li || !isSwipeLocal(li)) continue;
          const key = li.id ?? rli.line_item_id;
          out.set(key, (out.get(key) || 0) + takeAllocFrom(li));
        }
      }
      return out;
    }

    const totalsSum = swipeLines.reduce((sum, li) => {
      const amt = Number(
        li.discount_total ??
          li.total_discount ??
          li.total_discount_set?.shop_money?.amount ??
          0
      );
      return sum + toCents(amt);
    }, 0);
    if (totalsSum > 0) {
      const out = new Map(outZero);
      for (const li of swipeLines) {
        const amt = Number(
          li.discount_total ??
            li.total_discount ??
            li.total_discount_set?.shop_money?.amount ??
            0
        );
        out.set(li.id, toCents(amt));
      }
      return out;
    }

    const lines = orderLines.map((li, idx) => {
      const qty = Math.max(1, Number(li.quantity || 1));
      const unit = Number(
        li.price_set?.shop_money?.amount ??
          li.price_set?.presentment_money?.amount ??
          li.price ??
          0
      );
      const pre = unit * qty;
      return {
        id: li.id,
        pos: idx,
        qty,
        isSwipe: isSwipeLocal(li),
        discountable: li.discountable !== false && li.gift_card !== true,
        baseC: Math.round(pre * 100),
        curC: Math.round(pre * 100),
        curD: pre,
      };
    });

    const apps = order.discount_applications || [];
    const allocatedC = new Map(lines.map((l) => [l.id, 0]));
    const swipeIdSet = new Set(swipeLines.map((l) => l.id));

    const hasPct = apps.some(
      (a) => String(a.value_type || "").toLowerCase() === "percentage"
    );
    const hasFixedAcross = apps.some(
      (a) =>
        String(a.value_type || "").toLowerCase() === "fixed_amount" &&
        String(a.allocation_method || "").toLowerCase() === "across"
    );

    const distributeAcrossUnitLevel = (eligible, totalDiscountC, opts) => {
      if (totalDiscountC <= 0) return [];
      const units = [];
      for (const l of eligible) {
        const perUnitC = Math.floor(l.curC / l.qty);
        const rem = l.curC - perUnitC * l.qty;
        for (let i = 0; i < l.qty; i++) {
          const uC = perUnitC + (i < rem ? 1 : 0);
          units.push({
            lineId: l.id,
            pos: l.pos,
            priceC: uC,
            isSwipe: swipeIdSet.has(l.id),
          });
        }
      }
      const base = units.reduce((s, u) => s + u.priceC, 0);
      if (!base) return [];

      const rows = units.map((u, idx) => {
        const raw = (totalDiscountC * u.priceC) / base;
        const flo = Math.floor(raw);
        return {
          idx,
          lineId: u.lineId,
          pos: u.pos,
          isSwipe: u.isSwipe,
          raw,
          flo,
          frac: raw - flo,
        };
      });

      let sumFlo = rows.reduce((s, r) => s + r.flo, 0);
      let remainder = totalDiscountC - sumFlo;
      rows.sort(
        (a, b) => b.frac - a.frac || a.pos - b.pos || a.idx - b.idx
      );
      for (let i = 0; i < remainder; i++) rows[i % rows.length].flo++;

      if (opts?.preferSwipe) {
        const swipeRow = rows.find((r) => r.isSwipe);
        if (swipeRow) {
          const gotRemainder =
            Math.ceil(swipeRow.raw) - swipeRow.flo === 0 &&
            swipeRow.raw - swipeRow.flo > 0;
          if (!gotRemainder && swipeRow.frac >= 0.25) {
            const donor = rows
              .filter((r) => !r.isSwipe && r.flo > Math.floor(r.raw))
              .sort((a, b) => a.frac - b.frac || a.pos - b.pos)[0];
            if (donor && donor.flo > 0) {
              donor.flo -= 1;
              swipeRow.flo += 1;
            }
          }
        }
      }

      const byLine = new Map();
      for (const r of rows)
        byLine.set(r.lineId, (byLine.get(r.lineId) || 0) + r.flo);
      return [...byLine.entries()].map(([id, c]) => ({ id, c }));
    };

    for (const [appIndex, app] of apps.entries?.() || Object.entries(apps)) {
      const type = app?.type != null ? String(app.type).toLowerCase() : null;
      if (!type || !["manual", "automatic", "discount_code"].includes(type))
        continue;

      const method = String(app.allocation_method || "").toLowerCase();
      const vt = String(app.value_type || "").toLowerCase();
      const v = parseFloat(app.value) || 0;
      if (!vt) continue;

      let eligible = lines.filter((l) => {
        if (!l.discountable) return false;
        const target = String(app.target_selection || "").toLowerCase();
        if (target === "all") return true;
        if (target === "explicit") {
          const li = orderLines.find((x) => x.id === l.id);
          const allocs = li?.discount_allocations || [];
          return allocs.some(
            (a) => a.discount_application_index === Number(appIndex)
          );
        }
        return target === "entitled";
      });

      if (type === "automatic" || method === "each")
        eligible = eligible.filter((l) => !l.isSwipe);
      if (!eligible.length) continue;

      if (vt === "percentage") {
        const target = String(app.target_selection || "").toLowerCase();

        for (const l of eligible) {
          if (l.isSwipe && target !== "all") continue;

          const cents = roundCentsHalfAway((l.curD * v) / 100);
          if (cents <= 0) continue;

          allocatedC.set(l.id, (allocatedC.get(l.id) || 0) + cents);
          l.curC = Math.max(0, l.curC - cents);
          l.curD = l.curC / 100;
        }
        continue;
      }

      if (vt === "fixed_amount" && method === "across") {
        const vC = toCents(v);
        const eligibleBase = eligible.reduce((s, x) => s + x.curC, 0);
        const totalDiscountC = Math.min(vC, eligibleBase);
        if (totalDiscountC <= 0) continue;

        const shares = distributeAcrossUnitLevel(eligible, totalDiscountC, {
          preferSwipe: hasPct && hasFixedAcross,
        });

        for (const r of shares) {
          allocatedC.set(r.id, (allocatedC.get(r.id) || 0) + r.c);
          const line = eligible.find((x) => x.id === r.id);
          if (line) {
            line.curC = Math.max(0, line.curC - r.c);
            line.curD = line.curC / 100;
          }
        }
        continue;
      }
    }

    const out = new Map(orderLines.map((li) => [li.id, 0]));
    for (const li of swipeLines) out.set(li.id, allocatedC.get(li.id) || 0);
    return out;
  }

  let totalGrossSalesC = 0;
  let totalSwipeDiscountsC = 0;
  const totalProtectedItemsSold = createdOrders.reduce(
    (sum, order) => sum + getProtectedItemQty(order),
    0
  );
  const protectedOrderDetails = [];
  let totalProtectedPriceC = 0;
  const perUnitSwipeDiscountByOrder = new Map();

  for (const order of ordersAll) {
    const swipeItems = getSwipeLinesFromOrder(order);
    if (!swipeItems.length) continue;

    const isProtected = order.is_protected === true;

    const allocations = allocateAllDiscountsToLines(order);
    const lineMap = new Map();
    perUnitSwipeDiscountByOrder.set(order.order_number, lineMap);

    let orderSwipeGrossC = 0;
    let orderSwipeDiscC = 0;
    for (const li of swipeItems) {
      const qty = Math.max(1, Number(li.quantity || 1));
      const unit = Number(li.price || 0);

      const grossC = toCents(qty * unit);
      totalGrossSalesC += grossC;
      orderSwipeGrossC += grossC;

      const allocC = allocations.get(li.id) || 0;
      totalSwipeDiscountsC += allocC;
      orderSwipeDiscC += allocC;

      const perUnit = Math.round(allocC / qty);
      lineMap.set(li.id, perUnit);
    }

    if (isProtected) {
      const finalPaidAmountUSD = Number(
        order.total_price_set?.shop_money?.amount ||
          order.final_total_price ||
          order.total_price ||
          0
      );
      const finalPaidAmountC = toCents(finalPaidAmountUSD);
      totalProtectedPriceC += finalPaidAmountC;

      const netSwipeC = Math.max(0, orderSwipeGrossC - orderSwipeDiscC);

      // Table-ready row so /admin-details can skip the orders collection entirely.
      protectedOrderDetails.push({
        order_number: String(order.order_number),
        order_created_at: order.order_created_at,
        swipe_price: fmtCentsLocal(orderSwipeGrossC),
        swipe_discount:
          orderSwipeDiscC > 0 ? `-${fmtCentsLocal(orderSwipeDiscC)}` : "0.00",
        net_swipe: fmtCentsLocal(netSwipeC),
        refunded_amount_today: "$0.00",
        refunded_amount_previous: "$0.00",
        returned_qty_today: 0,
        returned_qty_previous: 0,
      });
    }
  }

  const specials = await Models.SpecialOrder.aggregate([
    {
      $match: {
        merchant: mId,
        "payload.line_items.sku": "swipe",
      },
    },
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
    { $project: { payload: 1, createdAt: 1, refunds_in_range: 1 } },
  ]).option({ allowDiskUse: true });

  let grossReturnAmountC = 0;
  let netReturnAmountC = 0;
  let todayReturns = 0;
  let previousReturns = 0;
  for (const so of specials) {
    const p = so.payload || {};
    const orderCreatedAt = moment(
      p.order_created_at || p.created_at || so.createdAt
    ).tz(timezone);
    for (const r of so.refunds_in_range || []) {
      const rt = moment(r.processed_at_d || r.created_at_d).tz(timezone);
      const sameDay =
        rt.format("YYYY-MM-DD") === orderCreatedAt.format("YYYY-MM-DD");

      for (const rli of r.refund_line_items || []) {
        const li = rli.line_item || {};
        const originalQty = Number(rli.quantity || 0);
        if (!originalQty) continue;
        const isNetItemSoldLine = isNetItemSoldSwipeItem(li);
        const isSwipeRefundLine =
          isSwipeLocal(li) || String(li?.sku || "").toLowerCase() === "swipe";
        if (!isSwipeRefundLine) continue;

        // Count
        if (isNetItemSoldLine && sameDay) {
          // refund_line_items already identifies the exact Shopify line item.
          // Do not subtract quantity from another active line that happens to
          // share the same variant (remove + re-add order edits).
          todayReturns += originalQty;
        } else if (isNetItemSoldLine) {
          previousReturns += originalQty;
        }

        // Amount
        const unit = Number(li.price || 0);
        const gross = toCents(unit * originalQty);

        const perLineMap = perUnitSwipeDiscountByOrder.get(
          String(p.order_number || so.order_number || "")
        );
        let perUnitDiscC = perLineMap?.get(li.id);

        if (perUnitDiscC == null) {
          const allocFromRefundLineC = (li.discount_allocations || []).reduce(
            (s, a) => {
              const amt = Number(a?.amount ?? a?.amount_set?.shop_money?.amount ?? 0);
              return s + toCents(amt);
            },
            0
          );
          const origQtyLine = Math.max(1, Number(li.quantity || 1));
          perUnitDiscC = Math.round(allocFromRefundLineC / origQtyLine);
          if (!perUnitDiscC) {
            const totalsC = toCents(
              Number(
                li.discount_total ??
                  li.total_discount ??
                  li.total_discount_set?.shop_money?.amount ??
                  0
              )
            );
            perUnitDiscC = Math.round(totalsC / origQtyLine);
          }
        }

        const net = Math.max(0, gross - perUnitDiscC * originalQty);

        grossReturnAmountC += gross;
        netReturnAmountC += net;
      }
    }
  }

  const grossReturnAmountStr = fmtNegLocal(grossReturnAmountC);
  const netReturnAmountStr = fmtNegLocal(netReturnAmountC);

  const totalRefundOrders = todayReturns + previousReturns;

  const netSalesC =
    Math.round(totalGrossSalesC) -
    Math.round(totalSwipeDiscountsC) -
    Math.round(netReturnAmountC);

  // --- AGGREGATION FIX ---
  const [orderStats] =
    (await Models.Order.aggregate([
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
          protected_order: {
            $sum: { $cond: [{ $eq: ["$is_protected", true] }, 1, 0] },
          },
          total_order: { $sum: 1 },
          total_price: {
            $sum: {
              $cond: [
                { $eq: ["$is_protected", true] },
                {
                  $toDouble: {
                    $ifNull: [
                      "$total_price_set.shop_money.amount",
                      "$final_total_price",
                      "$total_price",
                      "0",
                    ],
                  },
                },
                0,
              ],
            },
          },
          total_order_amount: {
            $sum: {
              $toDouble: { $ifNull: ["$total_line_items_price", "$total_price", "0"] },
            },
          },
        },
      },
    ]).option({ allowDiskUse: true })) || [
      { protected_order: 0, total_order: 0, total_price: 0, total_order_amount: 0 },
    ];

  const totalPriceC = toCents(orderStats?.total_price || 0);

  // Attach rate counts every order created in the period, including orders
  // that were later cancelled. Financial metrics keep their filters above.
  const [attachStats] =
    (await Models.Order.aggregate([
      {
        $match: {
          merchant: mId,
          app_id: ONLINE_STORE_APP_ID,
          order_created_at: { $gte: dayStart, $lte: dayEnd },
        },
      },
      {
        $group: {
          _id: null,
          protected_order: {
            $sum: { $cond: [{ $eq: ["$is_protected", true] }, 1, 0] },
          },
          total_order: { $sum: 1 },
        },
      },
    ]).option({ allowDiskUse: true })) || [
      { protected_order: 0, total_order: 0 },
    ];

  const [claimStats] =
    (await Models.Claim.aggregate([
      {
        $match: {
          merchant: mId,
          status: "RESOLVED",
          createdAt: { $gte: dayStart, $lte: dayEnd },
        },
      },
      {
        $group: {
          _id: null,
          saved_revenue: { $sum: { $toDouble: { $ifNull: ["$claim_total", "0"] } } },
        },
      },
    ]).option({ allowDiskUse: true })) || [{ saved_revenue: 0 }];

  const protectedPct =
    (attachStats?.total_order || 0) > 0
      ? `${((attachStats.protected_order * 100) / attachStats.total_order).toFixed(2)}%`
      : "0.00%";

  const savedRevenueC = toCents(claimStats?.saved_revenue || 0);
  const totalOrderAmountC = toCents(orderStats?.total_order_amount || 0);

  const hasData =
    ordersAll.length > 0 ||
    totalGrossSalesC !== 0 ||
    totalRefundOrders > 0 ||
    savedRevenueC > 0 ||
    totalProtectedPriceC > 0 ||
    (attachStats?.total_order || 0) > 0;

  // ✅ UPDATED: hourly already computed/saved above, so no freezing
  if (!hasData && ymd === todayYmd) {
    // Still mark this day at the current version with an empty
    // protected_order_list so admin-details treats it as a valid cached
    // miss (no protected orders) instead of re-triggering compute every
    // request.
    await DailyReport.updateOne(
      { merchant: mId, date: ymd },
      {
        $set: {
          timezone,
          protected_order_list: [],
          version: REPORT_VERSION,
          computed_at: new Date(),
        },
      },
      { upsert: true }
    );
    console.log(
      `ℹ️ NO DAILY DATA (hourly handled): Merchant ${mId} Date ${ymd}`
    );
    return;
  }

  await DailyReport.updateOne(
    { merchant: mId, date: ymd },
    {
      $set: {
        timezone,
        total_gross_sales_c: totalGrossSalesC,
        swipe_discounts_c: totalSwipeDiscountsC,
        gross_returns_amount_c: grossReturnAmountC,
        net_returns_amount_c: netReturnAmountC,
        net_sales_c: netSalesC,

        total_gross_sales: fmtCentsLocal(totalGrossSalesC),
        swipe_discounts: `-${fmtCentsLocal(Math.abs(totalSwipeDiscountsC))}`,
        gross_returns_amount: grossReturnAmountStr,
        net_returns_amount: netReturnAmountStr,
        net_sales: fmtCentsLocal(netSalesC),

        total_order_amount_c: totalOrderAmountC,
        total_order_amount: fmtUSDLocal(orderStats?.total_order_amount || 0),

        total_orders: attachStats?.total_order || 0,
        // Net items can be negative when this day has returns for orders sold
        // on an earlier day and no new protected-item sales of its own.
        net_items_sold: totalProtectedItemsSold - totalRefundOrders,
        total_returns_count: totalRefundOrders,
        today_returns_count: todayReturns,
        previous_returns_count: previousReturns,

        total_price_c: totalPriceC,
        total_price: fmtUSDLocal(orderStats?.total_price || 0),

        protected_order_percentage: protectedPct,

        saved_revenue_c: savedRevenueC,
        saved_revenue: fmtUSDLocal(claimStats?.saved_revenue || 0),

        // ✅ Ensure hourly is present on the final doc too
        hourly_stats: hourlyStats,

        protected_order_list: protectedOrderDetails,
        computed_at: new Date(),
        version: REPORT_VERSION,
      },
    },
    { upsert: true }
  );

  console.log(`✅ REPORT SAVED: Merchant ${mId} Date ${ymd}`);
}

// In-process compute dedupe — if /admin (top cards) and /admin-details both
// trigger compute for the same (merchant, day) at the same time, they share
// the same Promise instead of doubling MongoDB load.
const _computeInflight = new Map();
async function computeDailyForDateDedup(merchantId, ymd, explicitTimezone) {
  const timezone = await getMerchantTimezone(merchantId, explicitTimezone);
  const key = `${String(merchantId)}|${ymd}|${timezone}`;
  const existing = _computeInflight.get(key);
  if (existing) return existing;
  const p = computeDailyForDate(merchantId, ymd, timezone).finally(() => {
    _computeInflight.delete(key);
  });
  _computeInflight.set(key, p);
  return p;
}

router.computeDailyForDate = computeDailyForDateDedup;
router._computeDailyForDateRaw = computeDailyForDate;
module.exports = router;
