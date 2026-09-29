const express = require("express");
const router = express.Router();
const orderSchema = Models.Order;
const Order = require("../../services/Order");
const mongoose = require("mongoose");
const { Types } = require("mongoose");
const ObjectId = Types.ObjectId;
const moment = require('moment-timezone');
const DailyReport = require("../../models/DailyReport");
const { computeDailyForDate } = require("../cron/computeDailySwipeReport");
const SwipeOrderDetail = require("../../models/SwipeOrderDetail");
const { runWithOptionalHint } = require("../../utils/mongooseHint");
const { getMerchantTimezone } = require("../../utils/merchantTimezone");
const REPORT_VERSION = 8;
const ONLINE_STORE_APP_ID = 580111;
const DashboardDetails = async (req, res, next) => {
  try {
    const claimsInfo = await Services.Claim.getAll(
      {
        _id: req.merchant._id,
        status: {
          $in: [
            CLAIM_STATUS.REVIEWING,
            CLAIM_STATUS.APPROVED,
            CLAIM_STATUS.CLOSED,
          ],
        },
      },
      { status: 1 }
    );
    const response = { in_review: 0, approved: 0, closed: 0 };
    response["total"] = claimsInfo.length;
    for (let { status } of claimsInfo) {
      response[CLAIM_STATUS_OBJECT[status]] += 1;
    }
    return res.send({ data: response });
  } catch (error) {
    return next(error);
  }
};

const ProtectDetails = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;

    const parsedStartDate = new Date(startDate);
    const parsedEndDate = new Date(endDate);
    const dateRangeCriteria = {
      $match: {
        createdAt: { $gte: parsedStartDate, $lte: parsedEndDate },
      },
    };

    const result = await Services.Claim.aggregate([
      dateRangeCriteria,
      {
        $group: {
          _id: 0,
          resolvedClaimsCount: {
            $sum: {
              $cond: [{ $gt: ["$resolved_date", null] }, 1, 0],
            },
          },
          approvedClaimsCount: {
            $sum: {
              $cond: [{ $eq: ["$status", "APPROVED"] }, 1, 0],
            },
          },
          savedRevenueCount: { $sum: 0 },
          orderShippingProtectionCount: { $sum: 0 },
          presenceOfOrderWithProtectionCount: { $sum: 0 },
          totalRevenueProtectedCount: { $sum: 0 },
          averageTimeToFirstResponseCount: { $sum: 0 },
          reviewsWrittenCount: { $sum: 0 },
          customerSatisfactionScoreCount: { $sum: 0 },
          trackEmailsSentCount: { $sum: 0 },
          trackEmailsOpenedCount: { $sum: 0 },
          trackEmailsClickedCount: { $sum: 0 },
          totalShipmentsCount: { $sum: 0 },
          shipmentsWithValidTrackingDataCount: { $sum: 0 },
          shipmentsDeliveredSuccessfullyCount: { $sum: 0 },
        },
      },
      {
        $project: {
          _id: 0,
          resolvedClaimsCount: 1,
          approvedClaimsCount: 1,
          savedRevenueCount: 1,
          orderShippingProtectionCount: 1,
          presenceOfOrderWithProtectionCount: 1,
          totalRevenueProtectedCount: 1,
          averageTimeToFirstResponseCount: 1,
          reviewsWrittenCount: 1,
          customerSatisfactionScoreCount: 1,
          trackEmailsSentCount: 1,
          trackEmailsOpenedCount: 1,
          trackEmailsClickedCount: 1,
          totalShipmentsCount: 1,
          shipmentsWithValidTrackingDataCount: 1,
          shipmentsDeliveredSuccessfullyCount: 1,
        },
      },
    ]);

    return res.send({
      data: {
        resolvedClaimsCount: 0,
        approvedClaimsCount: 0,
        savedRevenueCount: 0,
        orderShippingProtectionCount: 0,
        presenceOfOrderWithProtectionCount: 0,
        totalRevenueProtectedCount: 0,
        averageTimeToFirstResponseCount: 0,
        reviewsWrittenCount: 0,
        customerSatisfactionScoreCount: 0,
        trackEmailsSentCount: 0,
        trackEmailsOpenedCount: 0,
        trackEmailsClickedCount: 0,
        totalShipmentsCount: 0,
        shipmentsWithValidTrackingDataCount: 0,
        shipmentsDeliveredSuccessfullyCount: 0,
      },
    });
  } catch (error) {
    return next(error);
  }
};

const RevenueStatistic = async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const response = await Services.UsageRecord.RevenueStatisticList(
      req.merchant._id,
      start_date,
      end_date,
      req.merchant.iana_timezone
    );
    res.send(response);
  } catch (error) {
    return next(error);
  }
};

const Statistic = async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const response = await Services.Claim.StatisticList({
      merchant_id: req.merchant._id,
      start_date,
      end_date,
      timezone: req.merchant.iana_timezone,
    });
    return res.send(response);
  } catch (error) {
    return next(error);
  }
};

const ClaimGraph = async (req, res, next) => {
  try {
    const response = await Services.Claim.ClaimGraphisList(
      req.merchant._id,
      req.merchant.iana_timezone
    );
    res.send(response);
  } catch (error) {
    return next(error);
  }
};

const ListComment = async (req, res, next) => {
  try {
    const comments = await Services.Event.aggregate([
      {
        $match: {
          merchant: ObjectId(req.params.merchant),
          type: {
            $in: [EVENT_TYPE.STORE_COMMENT],
          },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "created_by",
          foreignField: "_id",
          as: "created_by",
        },
      },
      {
        $unwind: {
          path: "$created_by",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 1,
          merchant: 1,
          ts: 1,
          type: 1,
          content: 1,
          attachments: 1,
          claim: 1,
          created_by: "$created_by.display_name",
          createdAt: 1,
        },
      },
      { $sort: { createdAt: -1 } },
    ]);
    comments.forEach((comment) => {
      comment.image_attachments = [];
      comment.pdf_attachments = [];

      if (Array.isArray(comment.attachments)) {
        comment.attachments.forEach((file) => {
          const fileName = file.split("/").pop().split("?")[0];
          const extension = file
            .split(".")
            .pop()
            .split("?")[0]
            .toLowerCase();

          if (
            ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff",
              "heic", "heif", "svg", "eps", "ai", "ico", "psd", "xcf",
              "raw", "cr2", "nef", "arw"].includes(
                extension
              )
          ) {
            comment.image_attachments.push({
              url: file,
              fileName: fileName,
            });
          } else if (["txt", "md", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
            "pdf", "epub", "mobi", "odt", "ods", "odp"]) {
            comment.pdf_attachments.push({
              url: file,
              fileName: fileName,
            });
          }
        });
      }
    });
    return res.send({
      message: MSG.DATA_FOUND,
      data: comments,
    });
  } catch (error) {
    next(error);
  }
};







const TZ = "America/Chicago";
const REPORT_FRESH_MS = 2 * 60 * 1000;
const formatCurrency = (value) =>
  value === undefined || value === null || isNaN(value)
    ? "$0.00"
    : `$${Number(value).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

const isSwipeItem = (li = {}) => {
  const sku = String(li.sku || "").toLowerCase();
  const title = String(li.title || "").toLowerCase();
  const vendor = String(li.vendor || "").toLowerCase();
  const ptype = String(li.product_type || "").toLowerCase();

  const tHit = title.includes("package protection") || title.includes("shipping protection") || title.includes("route protection") || title.includes("swipe");
  const sHit = sku === "swipe" || sku.includes("swipe") || sku.includes("protect");
  const vHit = vendor.includes("swipe");
  const pHit = ptype.includes("protection");
  return tHit || sHit || vHit || pHit;
};

const isNetItemSoldSwipeItem = (li = {}) => {
  const title = String(li.title || "").toLowerCase();
  const sku = String(li.sku || "").toLowerCase();
  return title.includes("swipe package protection") || sku === "swipe";
};

const getProtectedOrderTotalCents = (order = {}) => {
  const paidTotal = Number(
    order.total_price_set?.shop_money?.amount ??
    order.final_total_price ??
    order.total_price ??
    0
  );

  return toCents(paidTotal);
};

function getSwipeLinesFromOrder(order = {}) {
  const raw = Array.isArray(order.line_items) ? order.line_items : [];
  const lines = raw.filter(isSwipeItem);
  if (lines.length) return lines;

  const protectionItem = order.protection_item || {};
  const fallbackQty = Math.max(
    1,
    Number(protectionItem.quantity || order.protection_quantity || 1)
  );
  const protAmt = Number(order.protection_amount || order.protection_fee || 0);
  const fallbackUnit = Number(
    protectionItem.price ??
      protectionItem.price_set?.shop_money?.amount ??
      (fallbackQty > 0 ? protAmt / fallbackQty : protAmt)
  );
  const hasProt = order.is_protected || !!order.protection_item || protAmt > 0;

  if (hasProt) {
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
  }
  return [];
}

function getProtectedItemQty(order = {}) {
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
}

function buildPerUnitSwipeDiscountMap(orders) {
  const byOrder = new Map();
  for (const o of (orders || [])) {
    const swipeItems = getSwipeLinesFromOrder(o);
    if (!swipeItems.length) continue;
    const alloc = allocateAllDiscountsToLines(o);
    const lineMap = new Map();
    for (const li of swipeItems) {
      const qty = Math.max(1, Number(li.quantity || 1));
      const allocC = alloc.get(li.id) || 0;
      const perUnit = Math.round(allocC / qty);
      lineMap.set(li.id, perUnit);
    }
    byOrder.set(String(o.order_number), lineMap);
  }
  return byOrder;
}
async function liveEdgeTotals(Models, merchantId, edge, momentLib) {
  const zero = { gross: 0, disc: 0, gRet: 0, nRet: 0, net: 0, orders: 0, tR: 0, tdy: 0, prv: 0 };
  if (!edge || !edge.start || !edge.end) return zero;

  const dayStart = momentLib.tz(edge.start, TZ).toDate();
  const dayEnd = momentLib.tz(edge.end, TZ).toDate();

  const orders = await Models.Order.aggregate([
    {
      $match: {
        merchant: new ObjectId(merchantId),
        order_created_at: { $gte: dayStart, $lte: dayEnd },
      },
    },
    {
      $project: {
        order_number: 1,
        order_created_at: 1,
        discount_applications: 1,
          fulfillments: 1,          // ✅ ADD THIS

        line_items: 1,
        refunds: 1,
        protection_item: 1,
        protection_amount: 1,
      },
    },
  ]).option({ allowDiskUse: true, maxTimeMS: 12000 });

  const perUnitSwipeDiscountByOrder = buildPerUnitSwipeDiscountMap(orders);

  let grossC = 0, discC = 0;

  for (const o of orders) {
    const swipeItems = getSwipeLinesFromOrder(o)
    if (!swipeItems.length) continue;

    const hasApps = (o.discount_applications || []).length > 0;
    const allocations = hasApps ? allocateAllDiscountsToLines(o) : null;

    for (const li of swipeItems) {
      const qty = Math.max(1, Number(li.quantity || 1));
      const unit = Number(li.price || 0);
      grossC += toCents(qty * unit);

      const allocC = hasApps
        ? (allocations.get(li.id) || 0)
        : toCents(Number(li.total_discount ?? li.discount_total ?? 0));
      discC += allocC;
    }
  }

  const specials = await Models.SpecialOrder.aggregate([
    {
      $match: {
        merchant: new ObjectId(merchantId),
        $or: [
          { "payload.line_items.sku": "swipe" },
          { "payload.line_items.title": { $regex: /swipe package protection/i } },
        ],
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
                { $gte: [{ $ifNull: ["$$r.processed_at_d", "$$r.created_at_d"] }, dayStart] },
                { $lte: [{ $ifNull: ["$$r.processed_at_d", "$$r.created_at_d"] }, dayEnd] },
              ],
            },
          },
        },
      },
    },
    { $match: { "refunds_in_range.0": { $exists: true } } },
    { $project: { payload: 1, createdAt: 1, refunds_in_range: 1 } },
  ]).option({ allowDiskUse: true, maxTimeMS: 12000 });

  let gRetC = 0, nRetC = 0, todayR = 0, prevR = 0;

  for (const so of specials) {
    const p = so.payload || {};
    const rs = so.refunds_in_range || [];
    const orderCreatedAt = momentLib(p.order_created_at || p.created_at || so.createdAt).tz(TZ);

    for (const r of rs) {
      const rt = momentLib(r.processed_at_d || r.created_at_d).tz(TZ);
      const sameDay = rt.format("YYYY-MM-DD") === orderCreatedAt.format("YYYY-MM-DD");

      for (const rli of r.refund_line_items || []) {
        const li = rli.line_item || {};
        if (!isSwipeItem(li)) continue;

        const qty = Number(rli.quantity || 0);
        if (!qty) continue;

        const unit = Number(li.price || 0);
        const gross = toCents(unit * qty);
        const orderNum = String(p.order_number || so.order_number || "");
        const perLineMap = perUnitSwipeDiscountByOrder.get(orderNum);
        let perUnitDiscC = perLineMap?.get(li.id);
        if (perUnitDiscC == null) {
          const allocFromRefundLineC = (li.discount_allocations || []).reduce((s, a) => {
            const amt = Number(a?.amount ?? a?.amount_set?.shop_money?.amount ?? 0);
            return s + toCents(amt);
          }, 0);
          const origQty = Math.max(1, Number(li.quantity || 1));
          perUnitDiscC = Math.round(allocFromRefundLineC / origQty);
        }
        if (!perUnitDiscC) {
          const totalsC = toCents(
            Number(li.discount_total ?? li.total_discount ?? li.total_discount_set?.shop_money?.amount ?? 0)
          );
          const origQty = Math.max(1, Number(li.quantity || 1));
          perUnitDiscC = Math.round(totalsC / origQty);
        }

        const net = Math.max(0, gross - perUnitDiscC * qty);

        gRetC += gross;
        nRetC += net;
        if (sameDay) todayR += qty; else prevR += qty;
      }
    }
  }

  return {
    gross: grossC,
    disc: discC,
    gRet: gRetC,
    nRet: nRetC,
    net: grossC - discC - nRetC,
    orders: orders.length,
    tR: todayR + prevR,
    tdy: todayR,
    prv: prevR,
  };
}

function allocateAllDiscountsToLines(order) {
  const roundCentsHalfAway = (x) => {
    if (!isFinite(x)) return 0;
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    x = Math.round(x * 1e6) / 1e6;
    const scaled = x * 100;
    const flo = Math.floor(scaled);
    const frac = scaled - flo;
    const cents = frac > 0.5 ? Math.ceil(scaled) : frac < 0.5 ? flo : flo % 2 === 0 ? flo : flo + 1;
    return cents * sign;
  };

  const orderLines = Array.isArray(order.line_items) ? order.line_items : [];
  // ✅ collect fulfillment-level allocations
const fulfillmentAllocByLineIdC = new Map();
for (const f of (order.fulfillments || [])) {
  for (const fli of (f.line_items || [])) {
    const id = fli?.id;
    if (!id) continue;
    const allocC = (fli.discount_allocations || []).reduce((s, a) => {
      const amt = Number(a.amount ?? a.amount_set?.shop_money?.amount ?? 0);
      return s + toCents(amt);
    }, 0);
    
    if (allocC > 0) {
    if (!fulfillmentAllocByLineIdC.has(id)) {
  fulfillmentAllocByLineIdC.set(id, allocC);
}

    }
  }
}
const swipeLines = [
  ...new Map(
    orderLines
      .filter(isSwipeItem)
      .map(li => [li.id, li])
  ).values()
];


const takeAllocFrom = (li) => {
  const directC = (li.discount_allocations || []).reduce((s, a) => {
    const amt = Number(a.amount ?? a.amount_set?.shop_money?.amount ?? 0);
    return s + toCents(amt);
  }, 0);

  if (directC > 0) return directC;

  // 👇 If line has total_discount, use that
  const totalDiscC = toCents(
    Number(li.total_discount ?? li.discount_total ?? 0)
  );

  if (totalDiscC > 0) return totalDiscC;

  // ❌ DO NOT fallback to fulfillment for swipe
  return 0;
};


  const swipeAllocFromLine = swipeLines.reduce((s, li) => s + takeAllocFrom(li), 0);
  if (swipeAllocFromLine > 0) {
    const out = new Map(orderLines.map((li) => [li.id, 0]));
    for (const li of swipeLines) out.set(li.id, takeAllocFrom(li));
    return out;
  }
  let refundSwipeAlloc = 0;
  for (const r of order.refunds || []) {
    for (const rli of r.refund_line_items || []) {
      const li = rli.line_item;
      if (!li || !isSwipeItem(li)) continue;
      refundSwipeAlloc += takeAllocFrom(li);
    }
  }
  if (refundSwipeAlloc > 0) {
    const out = new Map(orderLines.map((li) => [li.id, 0]));
    for (const r of order.refunds || []) {
      for (const rli of r.refund_line_items || []) {
        const li = rli.line_item;
        if (!li || !isSwipeItem(li)) continue;
        const key = li.id ?? rli.line_item_id;
        out.set(key, (out.get(key) || 0) + takeAllocFrom(li));
      }
    }
    return out;
  }
  const swipeTotalsSum = swipeLines.reduce((sum, li) => {
    const amt = Number(
      li.discount_total ?? li.total_discount ?? li.total_discount_set?.shop_money?.amount ?? 0
    );
    return sum + toCents(amt);
  }, 0);
  if (swipeTotalsSum > 0) {
    const out = new Map(orderLines.map((li) => [li.id, 0]));
    for (const li of swipeLines) {
      const amt = Number(
        li.discount_total ?? li.total_discount ?? li.total_discount_set?.shop_money?.amount ?? 0
      );
      out.set(li.id, toCents(amt));
    }
    return out;
  }
  const lines = orderLines.map((li, idx) => {
    const qty = Math.max(1, Number(li.quantity || 1));
    const unit =
      Number(li.price_set?.shop_money?.amount ??
        li.price_set?.presentment_money?.amount ??
        li.price ?? 0);
    const pre = unit * qty;
    return {
      id: li.id,
      pos: idx,
      qty,
      isSwipe: isSwipeItem(li),
      discountable: li.discountable !== false && li.gift_card !== true,
      baseC: Math.round(pre * 100),
      curC: Math.round(pre * 100),
      curD: pre,
    };
  });

  const apps = order.discount_applications || [];
  const allocatedC = new Map(lines.map((l) => [l.id, 0]));
  const swipeIdSet = new Set(swipeLines.map((l) => l.id));

  const distributeAcrossUnitLevel = (eligibleLines, totalDiscountC, opts) => {
    if (totalDiscountC <= 0) return [];
    const units = [];
    for (const l of eligibleLines) {
      const perUnitC = Math.floor(l.curC / l.qty);
      const rem = l.curC - perUnitC * l.qty;
      for (let i = 0; i < l.qty; i++) {
        const uC = perUnitC + (i < rem ? 1 : 0);
        units.push({ lineId: l.id, pos: l.pos, priceC: uC, isSwipe: swipeIdSet.has(l.id) });
      }
    }
    const base = units.reduce((s, u) => s + u.priceC, 0);
    if (!base) return [];

    const rows = units.map((u, idx) => {
      const raw = (totalDiscountC * u.priceC) / base;
      const flo = Math.floor(raw);
      return { idx, lineId: u.lineId, pos: u.pos, isSwipe: u.isSwipe, raw, flo, frac: raw - flo };
    });

    let sumFlo = rows.reduce((s, r) => s + r.flo, 0);
    let remainder = totalDiscountC - sumFlo;
    rows.sort((a, b) => b.frac - a.frac || a.pos - b.pos || a.idx - b.idx);
    for (let i = 0; i < remainder; i++) rows[i % rows.length].flo++;

    if (opts?.preferSwipe) {
      const swipeRow = rows.find((r) => r.isSwipe);
      if (swipeRow) {
        const gotRemainder = Math.ceil(swipeRow.raw) - swipeRow.flo === 0 && swipeRow.raw - swipeRow.flo > 0;
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
    for (const r of rows) byLine.set(r.lineId, (byLine.get(r.lineId) || 0) + r.flo);
    return [...byLine.entries()].map(([id, c]) => ({ id, c }));
  };

  const hasPct = apps.some((a) => String(a.value_type || "").toLowerCase() === "percentage");
  const hasFixedAcross = apps.some(
    (a) =>
      String(a.value_type || "").toLowerCase() === "fixed_amount" &&
      String(a.allocation_method || "").toLowerCase() === "across"
  );

  for (const [appIndex, app] of (apps.entries?.() || Object.entries(apps))) {
    const type = app?.type != null ? String(app.type).toLowerCase() : null;
    if (!type || !["manual", "automatic", "discount_code"].includes(type)) continue;

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
        return allocs.some((a) => a.discount_application_index === Number(appIndex));
      }
      return target === "entitled";
    });

    if (type === "automatic" || method === "each") eligible = eligible.filter((l) => !l.isSwipe);
    if (!eligible.length) continue;

    // if (vt === "percentage") {
    //   for (const l of eligible) {
    //     const cents = roundCentsHalfAway((l.curD * v) / 100);
    //     if (cents <= 0) continue;
    //     allocatedC.set(l.id, (allocatedC.get(l.id) || 0) + cents);
    //     l.curC = Math.max(0, l.curC - cents);
    //     l.curD = l.curC / 100;
    //   }
    //   continue;
    // }
if (vt === "percentage") {
  const target = String(app.target_selection || "").toLowerCase();

  for (const l of eligible) {
    // 🚫 Respect Shopify entitlement rules
    if (l.isSwipe && target !== "all") {
      continue; // ❌ skip swipe
    }

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



const toOID = (v) =>
  v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(v);

const normYmd = (s) => moment.tz(s, TZ).format("YYYY-MM-DD");

const asStr = (v) => (v == null ? "" : String(v));

const moneyStrToCents = (s) => {
  if (s == null) return 0;
  const n = Number(String(s).replace(/[,$\s]/g, "").replace(/^USD/i, "").replace(/^\$/, ""));
  if (!isFinite(n)) return 0;
  return Math.round(n * 100);
};

const fromCents = (c) => (Number(c || 0) / 100).toFixed(2);

const toUSD = (cents) =>
  "$" + (Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function pickDailyFields(doc) {
  const cleanedList = (doc.protected_order_list || []).map(item => {
    const { _id, price_usd_c, ...rest } = item;
    return rest;
  });
  return {
    merchant: asStr(doc.merchant),
    date: doc.date,
    gross_returns_amount: asStr(doc.gross_returns_amount),
    net_items_sold: Number(doc.net_items_sold || 0),
    net_returns_amount: asStr(doc.net_returns_amount),
    net_sales: asStr(doc.net_sales),
    previous_returns_count: Number(doc.previous_returns_count || 0),
    protected_order_percentage: asStr(doc.protected_order_percentage),
    swipe_discounts: asStr(doc.swipe_discounts),
    today_returns_count: Number(doc.today_returns_count),
    total_gross_sales: asStr(doc.total_gross_sales),
    total_price: asStr(doc.total_price),
    total_returns_count: Number(doc.total_returns_count),
    total_orders: Number(doc.total_orders || 0),
    total_price: toUSD(doc.total_price_c || moneyStrToCents(doc.total_price)),
    total_order_amount: toUSD(doc.total_order_amount_c || moneyStrToCents(doc.total_order_amount)),
    saved_revenue: toUSD(doc.saved_revenue_c || moneyStrToCents(doc.saved_revenue)),
    protected_order_list: cleanedList,
    grand_total_usd: fromCents(doc.total_price_c || moneyStrToCents(doc.total_price)),
  };
}

function sumDailyToSingleObject(merchantId, docs) {
  let grossReturnsC = 0;
  let netReturnsC = 0;
  let netSalesC = 0;
  let totalGrossSalesC = 0;
  let swipeDiscountsC = 0;
  let totalPriceC = 0;
  let totalOrderAmountC = 0;
  let netItemsSold = 0;
  let prevReturns = 0;
  let todayReturns = 0;
  let totalReturns = 0;
  let totalOrders = 0;
  let weightedProt = 0;
  let ordersForWeight = 0;
  let savedRevenueC = 0;
  let protectedOrderList = [];

  for (const d of docs) {
    grossReturnsC += moneyStrToCents(d.gross_returns_amount);
    netReturnsC += moneyStrToCents(d.net_returns_amount);
    netSalesC += moneyStrToCents(d.net_sales);
    totalGrossSalesC += moneyStrToCents(d.total_gross_sales);
    swipeDiscountsC += moneyStrToCents(d.swipe_discounts);
    savedRevenueC += (d.saved_revenue_c || moneyStrToCents(d.saved_revenue));
    netItemsSold += Number(d.net_items_sold || 0);
    prevReturns += Number(d.previous_returns_count || 0);
    todayReturns += Number(d.today_returns_count || 0);
    totalReturns += Number(d.total_returns_count || 0);
    const o = Number(d.total_orders || 0);
    totalOrders += o;

    const pctStr = String(d.protected_order_percentage || "0").replace("%", "").trim();
    const pctNum = Number(pctStr) || 0;
    weightedProt += pctNum * o;
    ordersForWeight += o;

    totalPriceC += (d.total_price_c || moneyStrToCents(d.total_price));
    totalOrderAmountC += (d.total_order_amount_c || moneyStrToCents(d.total_order_amount));

    if (docs.length === 1) {
      protectedOrderList = d.protected_order_list || [];
    }
  }

  const protectedPct =
    ordersForWeight > 0 ? (weightedProt / ordersForWeight).toFixed(2) + "%" : "0.00%";

  const cleanedList = (protectedOrderList || []).map(item => {
    const { _id, price_usd_c, ...rest } = item;
    return rest;
  });

  return {
    merchant: String(merchantId),
    gross_returns_amount: fromCents(grossReturnsC),
    net_items_sold: netItemsSold,
    net_returns_amount: fromCents(netReturnsC),
    net_sales: fromCents(netSalesC),
    previous_returns_count: prevReturns,
    protected_order_percentage: protectedPct,
    swipe_discounts: fromCents(swipeDiscountsC),
    today_returns_count: todayReturns,
    total_gross_sales: fromCents(totalGrossSalesC),
    total_returns_count: totalReturns,
    total_orders: totalOrders,
    total_price: toUSD(totalPriceC),
    total_order_amount: toUSD(totalOrderAmountC),
    saved_revenue: toUSD(savedRevenueC),
    protected_order_list: cleanedList
  };
}

function emptyDailyResponse(merchantId, date) {
  return {
    merchant: String(merchantId),
    date,
    total_gross_sales: "$0.00",
    swipe_discounts: "$0.00",
    gross_returns_amount: "$0.00",
    net_returns_amount: "$0.00",
    net_sales: "$0.00",
    total_price: "$0.00",
    total_order_amount: "$0.00",
    saved_revenue: "$0.00",
    net_items_sold: 0,
    total_orders: 0,
    total_returns_count: 0,
    today_returns_count: 0,
    previous_returns_count: 0,
    protected_order_percentage: "0.00%",
    protected_order_list: [],
  };
}

async function computeHourlyForDay(merchantId, ymd, explicitTimezone) {
  const mId = merchantId instanceof mongoose.Types.ObjectId ? merchantId : new mongoose.Types.ObjectId(merchantId);
  const timezone = await getMerchantTimezone(mId, explicitTimezone);
  const dayStart = moment.tz(ymd, timezone).startOf("day").toDate();
  const dayEnd = moment.tz(ymd, timezone).endOf("day").toDate();

  const ordersStats = await Models.Order.aggregate([
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
        hour: { $hour: { date: "$order_created_at", timezone } },
        is_protected_bool: { $eq: ["$is_protected", true] },
      },
    },
    {
      $group: {
        _id: "$_id",
        doc: { $first: "$$ROOT" },
        is_protected_hourly: { $first: "$is_protected_bool" },
        hour: { $first: "$hour" },
      },
    },
    { $replaceRoot: { newRoot: "$doc" } },
    { $sort: { order_created_at: 1 } },
  ]).option({ allowDiskUse: true });

  // Attach rate includes orders that were later cancelled. The existing
  // active-order query above still drives sales, returns, and net items.
  const attachCountsByHour = await Models.Order.aggregate([
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
        total_orders: { $sum: 1 },
        protected_orders: {
          $sum: { $cond: [{ $eq: ["$is_protected", true] }, 1, 0] },
        },
      },
    },
  ]).option({ allowDiskUse: true });

  const protectedItemsCountMap = new Map();
  const ordersProtectedForProcessing = [];

  const attachTotalOrdersCountMap = new Map();
  const attachProtectedOrdersCountMap = new Map();
  attachCountsByHour.forEach((row) => {
    attachTotalOrdersCountMap.set(row._id, row.total_orders || 0);
    attachProtectedOrdersCountMap.set(row._id, row.protected_orders || 0);
  });

  ordersStats.forEach(order => {
    const hour = order.hour;

    if (order.is_protected === true) {
      protectedItemsCountMap.set(
        hour,
        (protectedItemsCountMap.get(hour) || 0) + getProtectedItemQty(order)
      );
      ordersProtectedForProcessing.push(order);
    }
  });

  const perUnitSwipeDiscountByOrder = buildPerUnitSwipeDiscountMap(ordersProtectedForProcessing);

  const hourlyData = new Array(24).fill(0).map((_, hour) => ({
    hour,
    ymdH: moment.tz(ymd, timezone).hour(hour).format("YYYY-MM-DD-HH"),
    total_price_c: 0,
    total_gross_sales_c: 0,
    swipe_discounts_c: 0,
    total_protected_orders: protectedItemsCountMap.get(hour) || 0,
    attach_rate_protected_orders: attachProtectedOrdersCountMap.get(hour) || 0,
    total_orders_all: attachTotalOrdersCountMap.get(hour) || 0,
    net_returns_amount_c: 0,
    gross_returns_amount_c: 0,
  }));

  for (const order of ordersProtectedForProcessing) {
    const hourIndex = order.hour;
    if (hourIndex < 0 || hourIndex >= 24) continue;

    const hourlyStat = hourlyData[hourIndex];
    hourlyStat.total_price_c += getProtectedOrderTotalCents(order);
    const swipeItems = getSwipeLinesFromOrder(order);

    const allocations = allocateAllDiscountsToLines(order);

    for (const li of swipeItems) {
      const qty = Math.max(1, Number(li.quantity || 1));
      const unit = Number(li.price || 0);

      const grossC = toCents(qty * unit);
      hourlyStat.total_gross_sales_c += grossC;

      const allocC = allocations.get(li.id) || 0;
      hourlyStat.swipe_discounts_c += allocC;
    }
  }

  const specials = await Models.SpecialOrder.aggregate([
    { $match: { merchant: mId, "payload.line_items.sku": "swipe" } },
    {
      $addFields: {
        refunds_cast: {
          $map: {
            input: { $ifNull: ["$payload.refunds", []] },
            as: "r",
            in: {
              processed_at_d: { $cond: [{ $eq: [{ $type: "$$r.processed_at" }, "string"] }, { $toDate: "$$r.processed_at" }, "$$r.processed_at"] },
              created_at_d: { $cond: [{ $eq: [{ $type: "$$r.created_at" }, "string"] }, { $toDate: "$$r.created_at" }, "$$r.created_at"] },
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
                { $gte: [{ $ifNull: ["$$r.processed_at_d", "$$r.created_at_d"] }, dayStart] },
                { $lte: [{ $ifNull: ["$$r.processed_at_d", "$$r.created_at_d"] }, dayEnd] },
              ],
            },
          },
        },
      },
    },
    { $match: { "refunds_in_range.0": { $exists: true } } },
    { $project: { payload: 1, refunds_in_range: 1 } },
  ]).option({ allowDiskUse: true });

  for (const so of specials) {
    const p = so.payload || {};
    for (const r of so.refunds_in_range || []) {
      const refundTime = moment(r.processed_at_d || r.created_at_d).tz(timezone);
      const hourIndex = refundTime.hour();
      if (hourIndex < 0 || hourIndex >= 24) continue;
      const hourlyStat = hourlyData[hourIndex];
      const orderNum = String(p.order_number || "");

      for (const rli of r.refund_line_items || []) {
        const li = rli.line_item || {};
        if (!isSwipeItem(li)) continue;
        const qty = Number(rli.quantity || 0);
        if (!qty) continue;
        const unit = Number(li.price || 0);
        const gross = toCents(unit * qty);
        hourlyStat.gross_returns_amount_c += gross;

        let perUnitDiscC = perUnitSwipeDiscountByOrder.get(orderNum)?.get(li.id);
        if (perUnitDiscC == null) {
          const totalsC = toCents(Number(li.discount_total ?? li.total_discount ?? 0));
          const origQty = Math.max(1, Number(li.quantity || 1));
          perUnitDiscC = Math.round(totalsC / origQty);
        }

        const net = Math.max(0, gross - (perUnitDiscC || 0) * qty);
        hourlyStat.net_returns_amount_c += net;
      }
    }
  }

  return hourlyData.map(h => {
    const protectedPct = h.total_orders_all > 0
      ? (h.attach_rate_protected_orders * 100) / h.total_orders_all
      : 0.00;

    return {
      ymdH: h.ymdH,
      hour: h.hour,
      net_items_sold: h.total_protected_orders,
      protected_order_percentage: `${protectedPct.toFixed(2)}%`,
      total_price: toUSD(h.total_price_c),
      total_gross_sales: toUSD(h.total_gross_sales_c),
      swipe_discounts: toUSD(h.swipe_discounts_c * -1),
      gross_returns_amount: toUSD(h.gross_returns_amount_c * -1),
      net_returns_amount: toUSD(h.net_returns_amount_c * -1),
      net_sales: toUSD(h.total_gross_sales_c - h.swipe_discounts_c - h.net_returns_amount_c),
    };
  });
}

router.get("/discounted-swipe-revenue/recompute", async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const moment = require("moment-timezone");
    const ObjectId = require("mongoose").Types.ObjectId;

    const isCronCall =
      req.query.fromCron === "true" ||
      req.headers["x-cron-job"] === "true";

    const merchantId =
      (req.merchant && req.merchant._id) ||
      (ObjectId.isValid(req.query.merchantId) ? req.query.merchantId : null);

    if (!merchantId) {
      return res.status(400).json({ message: "Invalid merchantId" });
    }

    const timezone = await getMerchantTimezone(merchantId);
    const fast = req.query.fast === "true";
    const todayYmd = moment.tz(timezone).format("YYYY-MM-DD");

    let s = moment.tz(req.query.startDate || req.query.date || new Date(), timezone).format("YYYY-MM-DD");
    let e = moment.tz(req.query.endDate || req.query.date || new Date(), timezone).format("YYYY-MM-DD");
    if (e < s) [s, e] = [e, s];

    const days = [];
    for (let d = moment.tz(s, timezone); !d.isAfter(moment.tz(e, timezone), "day"); d.add(1, "day")) {
      days.push(d.format("YYYY-MM-DD"));
    }

    const isSingleDay = days.length === 1;
    const requestedDayYmd = days[0];

    if (isSingleDay) {
      const singleDayStartedAt = Date.now();
      let doc = await DailyReport.findOne({
        merchant: merchantId,
        date: requestedDayYmd,
        timezone,
      }).lean();

      const isToday = requestedDayYmd === todayYmd;
      const hasFreshTodayDoc = isToday && isFreshReport(doc);

      const force = req.query.force === "true";
      if (force) {
        await DailyReport.deleteOne({
          merchant: merchantId,
          date: requestedDayYmd,
          timezone,
        });
      }

      
      const isOutdatedVersion = Number(doc?.version || 0) !== REPORT_VERSION;

      const shouldComputeHourly =
        force ||
        !doc ||
        isOutdatedVersion ||
        (doc.hourly_stats?.length || 0) < 24 ||
        (doc.hourly_stats || []).some((h) => h?.total_price == null) ||
        (isToday && !fast && !hasFreshTodayDoc);

      const shouldComputeDaily =
        force ||
        !doc ||
        isOutdatedVersion ||
        (isToday && !fast && !hasFreshTodayDoc);


      if (shouldComputeHourly) {
        const hourlyStartedAt = Date.now();
        const hourly = await computeHourlyForDay(
          merchantId,
          requestedDayYmd,
          timezone
        );
        
        const hasActivity = hourly.some(h => 
          h.net_items_sold > 0 || 
          (h.total_price && h.total_price !== "$0.00") ||
          (h.total_gross_sales && h.total_gross_sales !== "$0.00")
        );

        if (hasActivity || doc) {
          await DailyReport.updateOne(
            { merchant: merchantId, date: requestedDayYmd },
            { 
              $set: { 
                timezone,
                hourly_stats: hourly, 
                computed_at: new Date() 
              } 
            },
            { upsert: true }
          );
        }
        console.log(
          `[perf] GET /merchant/dashboard/discounted-swipe-revenue/recompute hourly merchant=${merchantId} date=${requestedDayYmd} fast=${fast} duration_ms=${Date.now() - hourlyStartedAt}`
        );
      }

      if (shouldComputeDaily) {
        const dailyStartedAt = Date.now();
        await computeDailyForDate(merchantId, requestedDayYmd, timezone);
        console.log(
          `[perf] GET /merchant/dashboard/discounted-swipe-revenue/recompute daily merchant=${merchantId} date=${requestedDayYmd} fast=${fast} duration_ms=${Date.now() - dailyStartedAt}`
        );
      }

      doc = await DailyReport.findOne({
        merchant: merchantId,
        date: requestedDayYmd,
        timezone,
      }).lean();

 const safeDaily = doc
  ? pickDailyFields(doc)
  : emptyDailyResponse(merchantId, requestedDayYmd);

const safeHourly =
  doc?.hourly_stats?.length
    ? doc.hourly_stats
    : new Array(24).fill(0).map((_, hour) => ({
        hour,
        ymdH: `${requestedDayYmd}-${String(hour).padStart(2, "0")}`,
        net_items_sold: 0,
        protected_order_percentage: "0.00%",
        total_price: "$0.00",
        total_gross_sales: "$0.00",
        swipe_discounts: "$0.00",
        gross_returns_amount: "$0.00",
        net_returns_amount: "$0.00",
        net_sales: "$0.00",
      }));

      console.log(
        `[perf] GET /merchant/dashboard/discounted-swipe-revenue/recompute merchant=${merchantId} mode=single-day date=${requestedDayYmd} fast=${fast} fromCron=${isCronCall} duration_ms=${Date.now() - singleDayStartedAt}`
      );

      return res.json({
        status: "ok",
        data: safeDaily,
        hourly_stats: safeHourly,
        daily_stats: [safeDaily],
      });

    }

    const existing = await DailyReport.find(
      { merchant: merchantId, date: { $in: days }, timezone },
      { date: 1, version: 1 }
    ).lean();

    const upToDateDays = new Set(
      existing
        .filter((d) => Number(d.version || 0) === REPORT_VERSION)
        .map((d) => d.date)
    );
    
    const toCompute = days.filter(d => !upToDateDays.has(d));

    if (toCompute.length) {
      const BATCH = 3;
      for (let i = 0; i < toCompute.length; i += BATCH) {
        await Promise.all(
          toCompute.slice(i, i + BATCH).map(d =>
            computeDailyForDate(merchantId, d, timezone)
          )
        );
      }
    }

    const docs = await DailyReport.find(
      { merchant: merchantId, date: { $in: days }, timezone }
    ).sort({ date: 1 }).lean();

    console.log(
      `[perf] GET /merchant/dashboard/discounted-swipe-revenue/recompute merchant=${merchantId} mode=range days=${days.length} fast=${fast} fromCron=${isCronCall} duration_ms=${Date.now() - startedAt}`
    );

    return res.json({
      status: "ok",
      data: sumDailyToSingleObject(merchantId, docs),
      daily_stats: docs.map(d => pickDailyFields(d)),
    });

  } catch (err) {
    console.log(
      `[perf] GET /merchant/dashboard/discounted-swipe-revenue/recompute failed merchant=${req.query.merchantId || req.merchant?._id || "unknown"} startDate=${req.query.startDate || req.query.date || "n/a"} endDate=${req.query.endDate || req.query.date || "n/a"} fast=${req.query.fast === "true"} duration_ms=${Date.now() - startedAt} error=${err?.message || err}`
    );
    next(err);
  }
});


async function getAllActiveMerchantIds() {
    const allMerchants = await Services.Merchant.getAll(
        { is_active: true }, 
        { _id: 1 }
    );
    return allMerchants.map(m => String(m._id));
}



const ymdFromEnd = (endDate) => require("moment-timezone")
  .tz(endDate, TZ)
  .format("YYYY-MM-DD");

const toCents = (n) => Math.round((Number(n) || 0) * 100);
const isFreshReport = (doc, freshnessMs = REPORT_FRESH_MS) => {
  if (!doc?.computed_at) return false;
  const computedAt = new Date(doc.computed_at).getTime();
  return Number.isFinite(computedAt) && (Date.now() - computedAt) < freshnessMs;
};

router.get("/discounted-swipe-revenue/details", async (req, res, next) => {
  try {
    const mongoose = require("mongoose");
    const moment = require("moment-timezone");
    const ObjectId = mongoose.Types.ObjectId;
    const merchantId = req.query.merchantId || (req.merchant && req.merchant._id);

    if (!merchantId || !ObjectId.isValid(merchantId)) {
      return res.status(400).json({ message: "Invalid merchantId" });
    }
    const timezone = await getMerchantTimezone(merchantId);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(25, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;
    const startDate = req.query.startDate
      ? moment.tz(req.query.startDate, timezone).startOf("day").toDate()
      : moment.tz(timezone).startOf("day").toDate();
    const endDate = req.query.endDate
      ? moment.tz(req.query.endDate, timezone).endOf("day").toDate()
      : moment.tz(timezone).endOf("day").toDate();
    const search = (req.query.order_number || "").trim();
    const baseMatch = {
      merchant: new ObjectId(merchantId),
      is_protected: true,
      order_created_at: { $gte: startDate, $lte: endDate }
    };
    if (search) {
      const num = Number(search);
      baseMatch.order_number = Number.isFinite(num)
        ? num
        : { $regex: search, $options: "i" };
    }

    const [orders, totalDocs] = await Promise.all([
      runWithOptionalHint(
        (hintName) => {
          const query = Models.Order.find(baseMatch)
            .select({
              order_number: 1,
              order_created_at: 1,
              line_items: 1,
              refunds: 1,
              discount_applications: 1,
              protection_amount: 1,
              protection_item: 1,
            })
            .sort({ order_created_at: -1 })
            .skip(skip)
            .limit(limit)
            .lean();
          return hintName ? query.hint(hintName) : query;
        },
        "merchant_protected_created_idx",
        "merchant/dashboard protected order list"
      ),
      Models.Order.countDocuments(baseMatch)
    ]);
    const allocMapFn = allocateAllDiscountsToLines;
    const findSwipeLines = getSwipeLinesFromOrder;
    const toCents = (n) => Math.round((Number(n) || 0) * 100);
    const fmt = (c) => (Number(c || 0) / 100).toFixed(2);

    const rows = [];

    for (const order of orders) {
      const swipeItems = findSwipeLines(order);
      if (!swipeItems.length) continue;
      const allocMap = allocMapFn(order);
      const discounted_variant_ids = new Set();
      const explicit_entitled_variant_ids = new Set();

      for (const app of (order.discount_applications || [])) {
        if (Array.isArray(app.entitled_product_variant_ids)) {
          app.entitled_product_variant_ids.forEach(v => explicit_entitled_variant_ids.add(String(v)));
        }
        if (String(app.target_selection || "").toLowerCase() === "all") {
          (order.line_items || []).forEach(li => discounted_variant_ids.add(String(li.variant_id)));
        }
      }

      for (const li of swipeItems) {
        const qty = Math.max(1, Number(li.quantity || 1));
        const unit = Number(li.price ?? li.price_set?.shop_money?.amount ?? 0);
        const grossC = toCents(unit * qty);
        const allocC = allocMap.get(li.id) || 0;
        const net = Math.max(0, grossC - allocC);

        rows.push({
          order_number: order.order_number,
          order_created_at: order.order_created_at,
          product_id: li.product_id,
          variant_id: li.variant_id,
          title: li.title,
          sku: li.sku,
          quantity: qty,
          price: fmt(toCents(unit)),
          swipe_price: fmt(grossC),
          swipe_discount: fmt(allocC),
          net_swipe: fmt(net),
          swipe_refunded: "0.00",
          discount_applications: order.discount_applications || [],
          discounted_variant_ids: [...discounted_variant_ids],
          explicit_entitled_variant_ids: [...explicit_entitled_variant_ids],
        });
      }
    }

    return res.json({
      message: "Data found (LIVE ACCURATE MODE).",
      meta: { page, limit, total: totalDocs },
      data: { order_details: rows }
    });

  } catch (err) {
    console.error("❌ Error /discounted-swipe-revenue/details:", err);
    next(err);
  }
});

// Admin swipe-revenue Protected
router.get("/discounted-swipe-revenue/admin", async (req, res, next) => {
  try {
    const requestedMerchantId = req.query.merchantId;
if (!requestedMerchantId || !mongoose.Types.ObjectId.isValid(requestedMerchantId)) {
  return res.json({
    status: "ok",
    data: {
      total_gross_sales: "$0.00",
      swipe_discounts: "$0.00",
      net_returns_amount: "$0.00",
      net_sales: "$0.00",
      total_orders: 0,
      net_items_sold: 0,
      saved_revenue: "$0.00"
    },
    meta: {
      merchants_count: 0,
      orders_by_merchant: [],
      startDate: req.query.startDate,
      endDate: req.query.endDate
    }
  });
}

const merchantIdsToProcess = [requestedMerchantId];


const merchantIdForTotal =
      merchantIdsToProcess.length > 1 ? "AGGREGATED_TOTAL" : merchantIdsToProcess[0];

    const timezone = await getMerchantTimezone(requestedMerchantId);
    const todayYmd = moment.tz(new Date(), timezone).format("YYYY-MM-DD");
    let s = moment.tz(req.query.startDate || req.query.date || new Date(), timezone).format("YYYY-MM-DD");
    let e = moment.tz(req.query.endDate || req.query.date || new Date(), timezone).format("YYYY-MM-DD");
    if (e < s) [s, e] = [e, s];

    const days = [];
    for (let cur = moment.tz(s, timezone); !cur.isAfter(moment.tz(e, timezone), "day"); cur.add(1, "day")) {
      if (days.length >= 1100)
        return res.status(413).json({ message: "Range too large (max 1100 days)" });
      days.push(cur.format("YYYY-MM-DD"));
    }

    const existing = await DailyReport.find({
      merchant: { $in: merchantIdsToProcess.map(toOID) },
      date: { $in: days },
      timezone,
    }).select("date merchant computed_at version").lean();

    const have = new Map();
    const freshTodayByMerchant = new Set();
    existing.forEach(d => {
      const mIdStr = String(d.merchant);
      if (!have.has(mIdStr)) have.set(mIdStr, new Set());
      if (Number(d.version || 0) === REPORT_VERSION) {
        have.get(mIdStr).add(d.date);
      }
      if (
        Number(d.version || 0) === REPORT_VERSION &&
        d.date === todayYmd &&
        isFreshReport(d)
      ) {
        freshTodayByMerchant.add(mIdStr);
      }
    });

    // Build the (merchant, day) pairs that need compute, then run them in
    // small batches. Firing 30+ concurrent computeDailyForDate calls hits
    // MongoDB with ~150 simultaneous queries (each compute fans out) — slower
    // than batched, and risks hitting connection / cursor limits.
    const pairsToCompute = [];
    for (const merchantId of merchantIdsToProcess) {
      const merchantHave = have.get(merchantId) || new Set();
      const missingPastDays = days.filter(d => d < todayYmd && !merchantHave.has(d));
      const daysToProcess = new Set(missingPastDays);
      if (days.includes(todayYmd) && !freshTodayByMerchant.has(String(merchantId))) {
        daysToProcess.add(todayYmd);
      }
      for (const ymd of daysToProcess) pairsToCompute.push({ merchantId, ymd });
    }

    const ADMIN_COMPUTE_BATCH = 5;
    for (let i = 0; i < pairsToCompute.length; i += ADMIN_COMPUTE_BATCH) {
      await Promise.all(
        pairsToCompute
          .slice(i, i + ADMIN_COMPUTE_BATCH)
          .map(({ merchantId, ymd }) =>
            computeDailyForDate(merchantId, ymd, timezone).catch((err) => {
              console.error(
                `[admin] computeDailyForDate failed merchant=${merchantId} date=${ymd}:`,
                err?.message || err
              );
              return null;
            })
          )
      );
    }

    const docs = await DailyReport.find({
  merchant: { $in: merchantIdsToProcess.map(toOID) },
  date: { $in: days },
  timezone,
})
  .sort({ date: 1 })
  .lean();


    const aggregatedResult = sumDailyToSingleObject(merchantIdForTotal, docs);
    const merchantSwipeTotals = aggregatedResult.swipe_total_by_merchant || new Map();

    const merchantData = await Models.Merchant.find({
      _id: { $in: merchantIdsToProcess.map(toOID) }
    })
      .select("name domain")
      .lean();

    const merchantMap = new Map();
    merchantData.forEach(m => {
      merchantMap.set(String(m._id), m.name || m.domain);
    });

    const merchantOrderCounts = {};
    docs.forEach(doc => {
      const mId = String(doc.merchant);
      const orders = Number(doc.total_orders || 0);
      merchantOrderCounts[mId] = (merchantOrderCounts[mId] || 0) + orders;
    });

    const ordersByMerchant = [];
    let merchantsWithOrdersCount = 0;

    for (const [merchantId, totalOrders] of Object.entries(merchantOrderCounts)) {
      if (totalOrders > 0) {
        const swipeCents = merchantSwipeTotals.get(merchantId) || 0;
        ordersByMerchant.push({
          merchant_id: merchantId,
          store_name: merchantMap.get(merchantId) || "N/A",
          total_orders: totalOrders,
          swipe_total: toUSD(swipeCents)
        });
        merchantsWithOrdersCount++;
      }
    }

    if (docs.length === 0)
      return res.json({
        status: "ok",
        data: null,
        meta: { tz: timezone, startDate: s, endDate: e, merchants_count: 0 }
      });

    const aggregated = { ...aggregatedResult };
    delete aggregated.swipe_total_by_merchant;

    const finalTotalOrders = ordersByMerchant.reduce((sum, item) => sum + item.total_orders, 0);

    const meta = {
      tz: timezone,
      startDate: s,
      endDate: e,
      merchants_count: merchantsWithOrdersCount,
      orders_by_merchant: ordersByMerchant
    };

    aggregated.total_orders = finalTotalOrders;

    return res.json({ status: "ok", meta, data: aggregated });
  } catch (e) {
    next(e);
  }
});

router.get("/discounted-swipe-revenue/admin-details", async (req, res, next) => {
  try {
    const mongoose = require("mongoose");
    const moment = require("moment-timezone");
    const ObjectId = mongoose.Types.ObjectId;

    const requestedMerchantId = req.query.merchantId;
if (!requestedMerchantId || !ObjectId.isValid(requestedMerchantId)) {
  return res.json({
    message: "No merchant selected.",
    meta: {
      page: 1,
      limit: Number(req.query.limit || 25),
      total: 0,
      merchants_fetched: 0,
      orders_by_merchant: []
    },
    data: {
      order_details: []
    }
  });
}

const merchantIdsToFetch = [requestedMerchantId];

    

    const merchantOIdsToFetch = merchantIdsToFetch.map(toOID);

    const timezone = await getMerchantTimezone(requestedMerchantId);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(25, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;
    const startDate = req.query.startDate
      ? moment.tz(req.query.startDate, timezone).startOf("day").toDate()
      : moment.tz(timezone).startOf("day").toDate();
    const endDate = req.query.endDate
      ? moment.tz(req.query.endDate, timezone).endOf("day").toDate()
      : moment.tz(timezone).endOf("day").toDate();

    const search = (req.query.order_number || "").trim();

    const baseMatch = {
      merchant: { $in: merchantOIdsToFetch },
      is_protected: true,
      order_created_at: { $gte: startDate, $lte: endDate }
    };

    if (search) {
      const num = Number(search);
      baseMatch.order_number = Number.isFinite(num)
        ? num
        : { $regex: search, $options: "i" };
    }

    // ============================================================
    // FAST PATH — read pre-computed protected_order_list from DailyReport
    // (populated by computeDailyForDate). Skips the orders collection entirely.
    // Falls back to live query if any day in range is missing or stale.
    // ============================================================
    const startYmd = moment.tz(startDate, timezone).format("YYYY-MM-DD");
    const endYmd = moment.tz(endDate, timezone).format("YYYY-MM-DD");

    const expectedDays = [];
    for (
      let cur = moment.tz(startYmd, timezone);
      !cur.isAfter(moment.tz(endYmd, timezone), "day");
      cur.add(1, "day")
    ) {
      expectedDays.push(cur.format("YYYY-MM-DD"));
    }

    const merchantDataPromise = Models.Merchant.find({
      _id: { $in: merchantOIdsToFetch },
    })
      .select("name domain")
      .lean();

    const cachedDocs = await DailyReport.find({
      merchant: { $in: merchantOIdsToFetch },
      date: { $in: expectedDays },
      timezone,
    })
      .select({
        merchant: 1,
        date: 1,
        version: 1,
        protected_order_list: 1,
        net_items_sold: 1,
        total_orders: 1,
      })
      .lean();

    // A cached doc is usable when it's at REPORT_VERSION AND either
    // (a) protected_order_list has rows, or
    // (b) the day had no protected activity (nothing to list).
    // Otherwise the doc is stale (pre-fix) — needs a quick compute pass
    // to populate the list. Note: the hourly recompute step is skipped
    // because the existing doc is already at REPORT_VERSION, so this
    // compute pass is FAST (no full-day orders aggregation).
    const expectedKeys = new Set();
    for (const oid of merchantOIdsToFetch) {
      for (const d of expectedDays) expectedKeys.add(`${String(oid)}|${d}`);
    }
    const haveKeys = new Set();
    for (const d of cachedDocs) {
      if (Number(d.version || 0) !== REPORT_VERSION) continue;
      const listLen = (d.protected_order_list || []).length;
      const hadProtectedActivity =
        Number(d.net_items_sold || 0) > 0 ||
        Number(d.total_orders || 0) > 0;
      if (listLen === 0 && hadProtectedActivity) continue; // stale
      haveKeys.add(`${String(d.merchant)}|${d.date}`);
    }
    const cacheComplete =
      haveKeys.size === expectedKeys.size &&
      [...expectedKeys].every((k) => haveKeys.has(k));

    // If cache is incomplete, trigger computeDailyForDate for missing
    // (merchant × day) pairs. Idempotent + populates protected_order_list at
    // REPORT_VERSION. After this, we re-read from DailyReport — no more
    // expensive live scans of the orders collection from this endpoint.
    let docsForResponse = cachedDocs;
    if (!cacheComplete) {
      const missing = [];
      for (const oid of merchantOIdsToFetch) {
        for (const d of expectedDays) {
          if (!haveKeys.has(`${String(oid)}|${d}`)) {
            missing.push({ oid, d });
          }
        }
      }

      const BATCH = 5;
      for (let i = 0; i < missing.length; i += BATCH) {
        await Promise.all(
          missing.slice(i, i + BATCH).map(({ oid, d }) =>
            computeDailyForDate(oid, d, timezone).catch((err) => {
              console.error(
                `[admin-details] computeDailyForDate failed merchant=${oid} date=${d}:`,
                err?.message || err
              );
              return null;
            })
          )
        );
      }

      docsForResponse = await DailyReport.find({
        merchant: { $in: merchantOIdsToFetch },
        date: { $in: expectedDays },
        timezone,
      })
        .select({ merchant: 1, date: 1, version: 1, protected_order_list: 1 })
        .lean();
    }

    const merchantData = await merchantDataPromise;
    const merchantMap = new Map();
    merchantData.forEach((m) =>
      merchantMap.set(String(m._id), m.name || m.domain)
    );

    // Flatten + filter by search (if any) and paginate in memory.
    const allRows = [];
    for (const doc of docsForResponse) {
      const mId = String(doc.merchant);
      const storeName = merchantMap.get(mId) || "N/A";
      for (const item of doc.protected_order_list || []) {
        if (search) {
          const num = Number(search);
          const orderNumStr = String(item.order_number || "");
          const matches = Number.isFinite(num)
            ? orderNumStr === String(num)
            : orderNumStr.toLowerCase().includes(search.toLowerCase());
          if (!matches) continue;
        }
        allRows.push({
          merchant_id: mId,
          store_name: storeName,
          order_number: item.order_number,
          order_created_at: item.order_created_at,
          quantity: 1,
          price: item.swipe_price || "0.00",
          swipe_price: item.swipe_price || "0.00",
          swipe_discount: item.swipe_discount || "0.00",
          net_swipe: item.net_swipe || "0.00",
          swipe_refunded: "0.00",
        });
      }
    }

    const totalDocs = allRows.length;
    const pagedRows = allRows.slice(skip, skip + limit);

    const ordersByMerchant = merchantOIdsToFetch.map((mOId) => {
      const mIdStr = String(mOId);
      const merchantTotal = docsForResponse
        .filter((d) => String(d.merchant) === mIdStr)
        .reduce(
          (sum, d) => sum + (d.protected_order_list?.length || 0),
          0
        );
      return {
        merchant_id: mIdStr,
        store_name: merchantMap.get(mIdStr) || "N/A",
        total_orders: merchantTotal,
      };
    });

    return res.json({
      message: `Data found for ${merchantIdsToFetch.length} merchant(s).`,
      meta: {
        page,
        limit,
        total: totalDocs,
        merchants_fetched: merchantIdsToFetch.length,
        orders_by_merchant: ordersByMerchant,
        source: cacheComplete ? "cache" : "computed",
      },
      data: { order_details: pagedRows },
    });

  } catch (err) {
    console.error("❌ Error /admindetails:", err);
    next(err);
  }
});


router.get("/statistics", Auth.check, Auth.checkPermission, DashboardDetails);
router.get("/protect", Auth.check, Auth.checkPermission, ProtectDetails);
router.get("/statistic/revenue", Auth.check, RevenueStatistic);
router.get("/claim/statistic", Auth.check, Statistic);
router.get("/claim/graph", Auth.check, ClaimGraph);
router.get("/comment/:merchant", Auth.check, ListComment);

module.exports = router;
module.exports.computeDailyForDate = computeDailyForDate;
