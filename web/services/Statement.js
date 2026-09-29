const statementModels = Models.Statement;
const Statement = {};
const { snapshotAmount } = require('../utils/merchantBillingPolicy');

const moneyStrToCents = (value) => {
  if (value == null) return 0;
  const normalized = String(value)
    .replace(/[,$\s]/g, "")
    .replace(/^USD/i, "")
    .replace(/^\$/, "");
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
};

const centsToNumber = (value) => Number((Number(value || 0) / 100).toFixed(2));

Statement.getUsageSummary = async ({
  merchantId,
  startDate,
  endDate,
}) => {
  // 1. Get Fees from UsageRecords
  const [usageStats] = await Services.UsageRecord.aggregate([
    {
      $match: {
        merchant: ObjectId(merchantId),
        type: "usages",
        $or: [
          { record_date: { $gte: startDate, $lte: endDate } },
          { createdAt: { $gte: startDate, $lte: endDate } }
        ]
      },
    },
    {
      $group: {
        _id: null,
        fees_collected: { $sum: "$amount" },
        usages: { $push: "$$ROOT" }
      },
    },
  ]);

  // 2. Get Credits from Claims (Exact Dashboard Logic)
  const claimStatsAgg = await Models.Claim.aggregate([
    {
      $match: {
        merchant: ObjectId(merchantId),
        status: { $in: ["RESOLVED", "APPROVED"] },
        $or: [
          { resolved_date: { $gte: startDate, $lte: endDate } },
          { updatedAt: { $gte: startDate, $lte: endDate } }
        ]
      }
    },
    {
      $addFields: {
        total_val: { $convert: { input: "$swipe_by_refunded", to: "double", onError: 0, onNull: 0 } },
        ref_raw: { $convert: { input: "$refund_total", to: "double", onError: 0, onNull: 0 } },
        reo_raw: { $convert: { input: "$reorder_total", to: "double", onError: 0, onNull: 0 } }
      }
    },
    {
      $group: {
        _id: null,
        total_refunds: {
          $sum: {
            $cond: [
              { $gt: [{ $add: ["$ref_raw", "$reo_raw"] }, 0] },
              { $multiply: ["$total_val", { $divide: ["$ref_raw", { $add: ["$ref_raw", "$reo_raw"] }] }] },
              { $cond: [{ $in: ["$refund_status", ["REFUND", "refund"]] }, "$total_val", 0] }
            ]
          }
        },
        total_reorders: {
          $sum: {
            $cond: [
              { $gt: [{ $add: ["$ref_raw", "$reo_raw"] }, 0] },
              { $multiply: ["$total_val", { $divide: ["$reo_raw", { $add: ["$ref_raw", "$reo_raw"] }] }] },
              { $cond: [{ $in: ["$refund_status", ["REPLACE", "reorder"]] }, "$total_val", 0] }
            ]
          }
        }
      }
    }
  ]);

  const claimStats = claimStatsAgg[0] || { total_refunds: 0, total_reorders: 0 };

  return {
    fees_collected: usageStats?.fees_collected || 0,
    total_refunds: Number(claimStats.total_refunds || 0),
    total_reorders: Number(claimStats.total_reorders || 0),
    usages: usageStats?.usages || [],
    credits: [] // For details we might need more, but for summary this is enough
  };
};

Statement.getDailyReportSummary = async ({
  merchantId,
  startDate,
  endDate,
}) => {
  const startYmd = Moment(startDate).tz("America/Chicago").format("YYYY-MM-DD");
  const endYmd = Moment(endDate).tz("America/Chicago").format("YYYY-MM-DD");

  const dailyReports = await Models.DailyReport.find({
    merchant: ObjectId(merchantId),
    date: { $gte: startYmd, $lte: endYmd },
  }).lean();

  return dailyReports.reduce(
    (acc, report) => {
      acc.total_gross_sales_c += moneyStrToCents(report.total_gross_sales);
      acc.swipe_discounts_c += moneyStrToCents(report.swipe_discounts);
      acc.gross_returns_amount_c += moneyStrToCents(report.gross_returns_amount);
      acc.net_returns_amount_c += moneyStrToCents(report.net_returns_amount);
      acc.net_sales_c += moneyStrToCents(report.net_sales);
      acc.total_price_c += (report.total_price_c || moneyStrToCents(report.total_price));
      acc.net_items_sold += Number(report.net_items_sold || 0);
      const o = Number(report.total_orders || 0);
      acc.total_orders += o;

      const pctStr = String(report.protected_order_percentage || "0").replace("%", "").trim();
      const pctNum = Number(pctStr) || 0;
      acc.weighted_prot += pctNum * o;

      acc.total_returns_count += Number(report.total_returns_count || 0);
      return acc;
    },
    {
      total_gross_sales_c: 0,
      swipe_discounts_c: 0,
      gross_returns_amount_c: 0,
      net_returns_amount_c: 0,
      net_sales_c: 0,
      total_price_c: 0,
      net_items_sold: 0,
      total_orders: 0,
      weighted_prot: 0,
      total_returns_count: 0,
      report_days: dailyReports.length,
    }
  );
};

Statement.insert = async (data) => {
    return new statementModels(data).save();
};

Statement.get = async (condition, projection, options) => {
    return statementModels.findOne(condition, projection, options);
};

Statement.getAll = async (
  condition,
  sort = { year: -1, month: -1 }
) => {
  return statementModels.find(condition).sort(sort);
};


Statement.findOneAndUpdate = async (condition, info) => {
    return statementModels.findOneAndUpdate(condition, info, { new: true });
};

Statement.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse)
        return statementModels.aggregate(pipeline).allowDiskUse(true);
    return statementModels.aggregate(pipeline);
};

Statement.CreatePdf = async (payload = {}) => {
  try {
    const { merchantIds, month, year, captureOnly = false } = payload;
    const billingSnapshots = [];
    const TZ = "America/Chicago";
    let targetMoment;
    if (month && year) {
      targetMoment = Moment.tz(`${year}-${month}`, "YYYY-M", TZ);
    } else {
      targetMoment = Moment.tz(TZ).subtract(1, "month");
    }

    const monthStartDate = targetMoment.clone().startOf("month").toDate();
    const monthEndDate   = targetMoment.clone().endOf("month").toDate();
    const lastMonth = targetMoment.format("YYYY-MM");

    const startDateStr = targetMoment.clone().startOf("month").format("YYYY-MM-DD");
    const endDateStr   = targetMoment.clone().endOf("month").format("YYYY-MM-DD");

    const condition = {
      createdAt: { $gte: monthStartDate, $lte: monthEndDate },
    };

    if (merchantIds?.length) {
      condition.merchant = { $in: ObjectIds(merchantIds) };
    }

  
    const usagesRecords = await Services.UsageRecord.aggregate([
      { $match: condition },
      {
        $lookup: {
          from: "merchants",
          localField: "merchant",
          foreignField: "_id",
          as: "merchant",
        },
      },
      {
        $match: {
          $or: [{ "merchant.is_billing": true }, { "merchant.billing_controls.version": 1 }],
          "merchant.is_active": true,
        },
      },
      { $unwind: "$merchant" },
      {
        $lookup: {
          from: "claims",
          localField: "claim",
          foreignField: "_id",
          as: "claim",
        },
      },
      {
        $unwind: {
          path: "$claim",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $group: {
          _id: "$merchant._id",
          merchantData: { $first: "$merchant" },
          credit: {
            $push: {
              $cond: [{ $eq: ["$type", "credit"] }, "$$ROOT", "$$REMOVE"],
            },
          },
        },
      },
    ]);

    if (!usagesRecords.length) {
      return { merchantsProcessed: 0, message: "No records found." };
    }

    const tasks = usagesRecords.map(async (merchantGroup) => {
      const merchantDetail = merchantGroup.merchantData;

      const usageSummary = await Statement.getUsageSummary({
        merchantId: merchantDetail._id,
        startDate: monthStartDate,
        endDate: monthEndDate,
      });

      const dailySummary = await Statement.getDailyReportSummary({
        merchantId: merchantDetail._id,
        startDate: monthStartDate,
        endDate: monthEndDate,
      });

      merchantDetail.total_gross_sales = centsToNumber(
        dailySummary.total_gross_sales_c
      );
      merchantDetail.swipe_discounts = centsToNumber(
        dailySummary.swipe_discounts_c
      );
      merchantDetail.net_returns_amount = centsToNumber(
        dailySummary.net_returns_amount_c
      );
      merchantDetail.gross_returns_amount = centsToNumber(
        dailySummary.gross_returns_amount_c
      );
      merchantDetail.fees_collected =
        dailySummary.report_days > 0
          ? centsToNumber(dailySummary.net_sales_c)
          : Number(usageSummary.fees_collected || 0);

      merchantDetail.total_price = centsToNumber(dailySummary.total_price_c);
      merchantDetail.net_items_sold = dailySummary.net_items_sold;
      merchantDetail.attach_rate = dailySummary.total_orders > 0 
        ? (dailySummary.weighted_prot / dailySummary.total_orders).toFixed(2) + "%"
        : "0.00%";



let statement = await Services.Statement.get({
  merchant: merchantDetail._id,
  statement_month: lastMonth,
});

const [stmtYear, stmtMonth] = lastMonth.split("-").map(Number);

if (captureOnly) {
  statement = statement || { month: stmtMonth, year: stmtYear, createdAt: new Date() };
} else if (!statement) {
  statement = await Services.Statement.insert({
    merchant: merchantDetail._id,
    statement_month: lastMonth,
    month: stmtMonth,
    year: stmtYear,
  });
} else {
  if (statement.month !== stmtMonth || statement.year !== stmtYear) {
    statement = await Services.Statement.findOneAndUpdate(
      { _id: statement._id },
      { month: stmtMonth, year: stmtYear }
    );
  }
}


      const processedClaims = await Promise.all(
        merchantGroup.credit.map(async (claimDetail) => {
          let claim = null;
          let finalOrderName = "N/A";

          try {
            const cId = claimDetail.claim?._id || claimDetail.claim;
            if (cId && String(cId).match(/^[0-9a-fA-F]{24}$/)) {
              claim = await Services.Claim.get({ _id: cId });
            }
          } catch {}

          if (!claim || !claim.createdAt) return null;

          finalOrderName = claim.order_name || "N/A";

          const amount =
            claim.combined_refund_total && Number(claim.combined_refund_total) > 0
              ? Number(claim.combined_refund_total)
              : Number(claimDetail.amount || 0);

          const type =
            claimDetail?.credit_type === "reorder" ? "Re-Order" : "Refund";

          return {
            createdAt: claim.createdAt,
            resolved_date: claim.createdAt,
            reason: type,
            raw_amount: amount,
            raw_type: type,
            claim_total: `$${amount.toFixed(2)}`,
            order_name: finalOrderName,
            uniqueKey: finalOrderName,
          };
        })
      );

      const uniqueClaims = Array.from(
        new Map(
          processedClaims.filter(Boolean).map(c => [c.uniqueKey, c])
        ).values()
      );

      if (!uniqueClaims.length && usageSummary.credits?.length) {
        uniqueClaims.push(
          ...usageSummary.credits.map((credit, index) => ({
            createdAt: credit.effective_date || credit.record_date || credit.createdAt,
            resolved_date:
              credit.effective_date || credit.record_date || credit.createdAt,
            reason: credit.credit_type === "reorder" ? "Re-Order" : "Refund",
            raw_amount: Number(credit.amount || 0),
            raw_type: credit.credit_type === "reorder" ? "Re-Order" : "Refund",
            claim_total: `$${Number(credit.amount || 0).toFixed(2)}`,
            order_name: credit.order_name || `Usage Credit ${index + 1}`,
            uniqueKey: `${credit.order_name || "usage-credit"}-${index}`,
          }))
        );
      }

      // Totals are derived from the same rows shown in the PDF table so the
      // header summary and the per-row Claim Total column always reconcile.
      const sumRefunds = uniqueClaims.reduce(
        (acc, c) => acc + (c.raw_type === "Refund" ? Number(c.raw_amount || 0) : 0),
        0
      );
      const sumReorders = uniqueClaims.reduce(
        (acc, c) => acc + (c.raw_type === "Re-Order" ? Number(c.raw_amount || 0) : 0),
        0
      );

      merchantDetail.total_refunds = Number(sumRefunds.toFixed(2));
      merchantDetail.total_reorders = Number(sumReorders.toFixed(2));
      merchantDetail.total_claims = Number((sumRefunds + sumReorders).toFixed(2));
      merchantDetail.claim = uniqueClaims;
      const finalTotal =
        merchantDetail.fees_collected - merchantDetail.total_claims;

      merchantDetail.current_month_total = finalTotal.toFixed(2);
      merchantDetail.total_billed_amount = finalTotal.toFixed(2);
      merchantDetail.final_net_shopify_bill = Number(
        merchantDetail.total_after_commission || finalTotal
      );
      merchantDetail.first_date = Moment(monthStartDate).format("MM/DD/YYYY");
      merchantDetail.last_date = Moment(monthEndDate).format("MM/DD/YYYY");
      merchantDetail.statement_id = statement._id;
      merchantDetail.statement_date = targetMoment
        .clone()
        .endOf("month")
        .format("MM-DD-YYYY");
      merchantDetail.generated_on = Moment(statement.createdAt).format("MM-DD-YYYY");
      merchantDetail.statement_month_label = targetMoment.format("MMMM YYYY");
      merchantDetail.usage_count = usageSummary.usages?.length || 0;
      merchantDetail.credit_count = usageSummary.credits?.length || 0;

      merchantDetail.statement_details = statement;

      // Use precisely the same rows and commission rounding as the statement PDF.
      // Preview does not create a statement, send email or contact a billing provider.
      if (captureOnly) {
        billingSnapshots.push({ ...snapshotAmount({
          fees: Number(merchantDetail.fees_collected),
          credits: Number(merchantDetail.total_claims),
          commission: Number(merchantDetail.competition || 0),
        }), merchant: String(merchantDetail._id), claims: uniqueClaims });
        return;
      }

      if (merchantDetail.billing_controls?.version === 1) {
        const billed = await Models.MerchantBillingRun.findById(`${merchantDetail._id}:${lastMonth}`).lean();
        if (billed) {
          // Regeneration must not change the amount/claim rows of an already frozen bill.
          merchantDetail.fees_collected = billed.snapshot.fees;
          merchantDetail.total_claims = billed.snapshot.credits;
          merchantDetail.claim = billed.snapshot.claims;
          merchantDetail.total_refunds = billed.snapshot.claims.filter(c => c.raw_type === 'Refund').reduce((n, c) => n + c.raw_amount, 0);
          merchantDetail.total_reorders = billed.snapshot.credits - merchantDetail.total_refunds;
          merchantDetail.competition = billed.snapshot.commission;
          merchantDetail.current_month_total = (billed.snapshot.fees - billed.snapshot.credits).toFixed(2);
          merchantDetail.total_billed_amount = merchantDetail.current_month_total;
          await Services.Statement.findOneAndUpdate({ _id: statement._id }, { $set: {
            billing_run_id: billed._id, billing_status: billed.status,
            billing_provider: billed.provider, billing_amount_cents: billed.snapshot.amount_cents,
            ...(billed.invoice_url ? { payment_link: billed.invoice_url } : {}),
          } });
        }
      }

      if (merchantDetail.billing_type === "shopify" && !merchantDetail.billing_controls?.version) {
        try {
          const totalDueToSwipe = parseFloat(
            merchantDetail.total_due_to_swipe ||
              merchantDetail.total_billed_amount ||
              merchantDetail.current_month_total ||
              0
          );
          const commissionPercent = Number(merchantDetail.competition || 0);
          const finalNetBill = Number(
            (
              totalDueToSwipe -
              (totalDueToSwipe * commissionPercent) / 100
            ).toFixed(2)
          );

          await Services.Billing.chargeStatementOnShopify({
            shop: merchantDetail.shop_id,
            statementId: statement._id,
            statementMonth: merchantDetail.statement_month_label,
            amount: finalNetBill,
          });
        } catch (billingError) {
          Logger.error(
            `Failed Shopify final net billing for statement ${statement._id}: ${billingError.message}`
          );
        }
      }

     await Func.createStatementPdf(
  merchantDetail,
  lastMonth,
  targetMoment.clone()   // ✅ pass billing context
);

    });

    await Promise.all(tasks);

    return {
      merchantsProcessed: usagesRecords.length,
      ...(captureOnly ? { billingSnapshots } : {}),
      message: "PDF generation successful.",
    };

  } catch (error) {
    Logger.error(error.stack);
    throw error;
  }
};


module.exports = Statement;
