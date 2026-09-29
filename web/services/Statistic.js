const StatisticSchema = Models.Statistics;
const Statistic = {};
const CronTask = require("../models/cron");
const Moment = require("moment-timezone");
const mongoose = require("mongoose");
const DailyReport = require("../models/DailyReport");

const TZ = "America/Chicago";

const moneyStrToNumber = (value) => {
    if (value == null) return 0;
    const numeric = Number(String(value).replace(/[$,\s]/g, ""));
    return Number.isFinite(numeric) ? numeric : 0;
};

const formatUsd = (amount) =>
    "$" +
    Number(amount || 0).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
Statistic.insert = async (data) => {
    return new StatisticSchema(data).save();
};

Statistic.get = async (condition, projection, options = { lean: true }) => {
    return StatisticSchema.findOne(condition, projection, options);
};

Statistic.count = async (condition) => {
    return StatisticSchema.countDocuments(condition);
};

Statistic.getAll = async (condition, projection, options = { lean: true }) => {
    return StatisticSchema.find(condition, projection, options);
};

Statistic.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse)
        return StatisticSchema.aggregate(pipeline).allowDiskUse(true);
    return StatisticSchema.aggregate(pipeline);
};

Statistic.updateOne = async (condition, info) => {
    return StatisticSchema.updateOne(condition, info);
};

Statistic.findOneAndUpdate = async (condition, info, options) => {
    return StatisticSchema.findOneAndUpdate(condition, info, options);
};

Statistic.calculateRevenueForRange = async (condition) => {
    const usagesRecords = await Services.UsageRecord.aggregate([
        { $match: condition },
        {
            $group: {
                _id: 1,
                fees_collected: {
                    $sum: {
                        $cond: [{ $eq: ["$type", "usages"] }, "$amount", 0],
                    },
                },
                paid_out: {
                    $sum: {
                        $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0],
                    },
                },
            },
        },
        { $project: { _id: 0 } },
    ]);
    if (usagesRecords.length) {
        const stats = usagesRecords[0];
        return {
            fees_collected: Math.round(stats.fees_collected),
            paid_out: Math.round(stats.paid_out),
            net_revenue: Math.round(stats.fees_collected - stats.paid_out),
        };
    }
    return { fees_collected: 0, paid_out: 0, net_revenue: 0 };
};

Statistic.adminDashboard = async (payload) => {
    try {
        const monthlyStatistic = await Statistic.aggregate([
            {
                $sort: {
                    createdAt: -1
                }
            },

            // Step 3: Project to exclude fields
            {
                $project: {
                    _id: 0,
                    __v: 0,
                    createdAt: 0,
                    updatedAt: 0
                }
            }
        ]);

        const allClaimList = await Services.Claim.AllClaimCount();

        // Calculate current month statistics on the fly
        const currentMonthStart = Moment().startOf("month").toDate();
        const currentMonthEnd = Moment().endOf("month").toDate();
        const currentMonthQuery = { createdAt: { $gte: currentMonthStart, $lte: currentMonthEnd } };
        
        const currentMonthInstall = await Services.Merchant.count(currentMonthQuery);
        const currentMonthRevenue = await Statistic.calculateRevenueForRange(currentMonthQuery);
        
        // Add current month to monthly statistics if not there (at the top)
        const currentMonth = Number(Moment().format("MM"));
        const currentYear = Number(Moment().format("YYYY"));
        const currentMonthStat = {
            month: currentMonth,
            year: currentYear,
            new_install: currentMonthInstall,
            ...currentMonthRevenue
        };

        const enrichedMonthly = [currentMonthStat, ...monthlyStatistic];

        const overallStatistic = enrichedMonthly.reduce(
            (accumulate, currentValue) => ({
                fees_collected: Math.round(
                    (currentValue.fees_collected || 0) + accumulate.fees_collected
                ),
                paid_out: Math.round(
                    (currentValue.paid_out || 0) + accumulate.paid_out
                ),
                total_install: Math.round(
                    (currentValue.new_install || 0) + accumulate.total_install
                ),
                net_revenue: Math.round(
                    (currentValue.net_revenue || 0) + accumulate.net_revenue
                ),
            }),
            {
                fees_collected: 0,
                paid_out: 0,
                total_install: 0,
                net_revenue: 0,
            }
        );

        return {
            data: {
                total: overallStatistic,
                monthly: enrichedMonthly,
                claim_count: allClaimList,
            },
            message: "Data Found",
        };
    } catch (err) {
        throwError(err);
    }
};

Statistic.generateReport = async (monthNumber = 1) => {
    try {
        let statistics = {
            fees_collected: 0,
            fees_collected_per: "0%",
            net_revenue: 0,
            net_revenue_per: "0%",
            paid_out: 0,
            paid_out_per: "0%",
            new_install_per: "0%",
        };
        // Use provided monthNumber or default to 1 (last month)
        const monthStartDate = Moment()
            .subtract(monthNumber, "months")
            .startOf("month")
            .toDate();
        const monthEndDate = Moment()
            .subtract(monthNumber, "months")
            .endOf("month")
            .toDate();
        const lastMonth = Moment().subtract(monthNumber, "month");
        const statisticsMonth = lastMonth.format("YYYY-MM");
        const lastPreviousMonth = Moment()
            .subtract(monthNumber + 1, "month")
            .format("YYYY-MM");
        const month = Number(lastMonth.format("MM"));
        const year = Number(lastMonth.format("YYYY"));
        const queryCondition = {
            createdAt: { $gte: monthStartDate, $lte: monthEndDate },
        };

        console.log({
            monthStartDate,
            monthEndDate,
            lastMonth,
            month,
            year,
            statisticsMonth,
            lastPreviousMonth,
        });

        const newInstall = await Services.Merchant.count(queryCondition);
        const revenueStats = await Statistic.calculateRevenueForRange(queryCondition);
        statistics = { ...statistics, ...revenueStats };
        statistics.new_install = newInstall;
        statistics.month = month;
        statistics.year = year;
        statistics.statistics_month = statisticsMonth;
        const previousMonthStatistics = await Statistic.get({
            statistics_month: lastPreviousMonth,
        });
        if (previousMonthStatistics) {
            statistics.new_install_per = Func.calculatePercentageDifference(
                statistics.new_install,
                previousMonthStatistics.new_install
            );
            statistics.fees_collected_per = Func.calculatePercentageDifference(
                statistics.fees_collected,
                previousMonthStatistics.fees_collected
            );
            statistics.net_revenue_per = Func.calculatePercentageDifference(
                statistics.net_revenue,
                previousMonthStatistics.net_revenue
            );
            statistics.paid_out = Math.round(statistics.paid_out);
            statistics.paid_out_per = Func.calculatePercentageDifference(
                statistics.paid_out,
                previousMonthStatistics.paid_out
            );
        }
        await Statistic.findOneAndUpdate(
            { statistics_month: statisticsMonth },
            { $set: statistics },
            { upsert: true }
        );
        console.log({ previousMonthStatistics });
        console.log(statistics);
    } catch (error) {
        console.log(error);
    }
};

Statistic.sendDailyRevenueReport = async () => {
    const ymd = Moment.tz(TZ).format("YYYY-MM-DD");
    const reportDateYmd = Moment.tz(TZ).subtract(1, "day").format("YYYY-MM-DD");

    const locks = mongoose.connection.collection("job_locks");
    const lockFilter = { key: "DAILY_REVENUE_REPORT", ymd };

    const lockResult = await locks.updateOne(
        lockFilter,
        { $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
    );

    if (!lockResult.upsertedCount) {
        console.log(`[DailyReport] Already sent for ${ymd}. Skipping duplicate email.`);
        return { message: "ALREADY_SENT_TODAY", report: null };
    }

    try {
        const { computeDailyForDate } = require("../controllers/cron/computeDailySwipeReport");
        const merchants = await Models.Merchant.find({})
            .select("_id")
            .lean();

        const existingReports = await DailyReport.find({
            date: reportDateYmd,
        })
            .select("merchant")
            .lean();

        const existingMerchantIds = new Set(
            existingReports.map((doc) => String(doc.merchant))
        );

        const missingMerchants = merchants.filter(
            (merchant) => !existingMerchantIds.has(String(merchant._id))
        );

        for (const merchant of missingMerchants) {
            try {
                await computeDailyForDate(merchant._id, reportDateYmd);
            } catch (merchantError) {
                console.error(
                    `[DailyReport] Failed to compute ${reportDateYmd} for merchant ${merchant._id}:`,
                    merchantError.message
                );
            }
        }

        const reports = await DailyReport.find({
            date: reportDateYmd,
        })
            .select("total_orders net_items_sold net_sales")
            .lean();

       // ✅ REAL TOTAL ORDERS (protected + non-protected)
const totalOrderCount = await Models.Order.countDocuments({
    createdAt: {
        $gte: Moment.tz(reportDateYmd, TZ).startOf("day").toDate(),
        $lte: Moment.tz(reportDateYmd, TZ).endOf("day").toDate(),
    }
});
        const protectedOrderCount = reports.reduce(
            
            (sum, report) => sum + Number(report.net_items_sold || 0),
            0
        );
        // Protection Rate %
const protectionRate = totalOrderCount > 0
    ? ((protectedOrderCount / totalOrderCount) * 100).toFixed(2) + "%"
    : "0%";
        const totalRevenueValue = reports.reduce(
            (sum, report) => sum + moneyStrToNumber(report.net_sales),
            0
        );
        const totalRevenue = formatUsd(totalRevenueValue);
        
        // Total Active Stores
const totalActiveStores = await Models.Merchant.countDocuments({});
        // Claims (Refund + Reorder) — same logic as dashboard report (merchant/claims/list)
        const dayStart = Moment.tz(reportDateYmd, TZ).startOf("day").toDate();
        const dayEnd = Moment.tz(reportDateYmd, TZ).endOf("day").toDate();
        const [resolvedClaimTotals] = await Models.Claim.aggregate([
            {
                $match: {
                    status: { $in: ["RESOLVED", "APPROVED"] },
                    resolved_date: { $gte: dayStart, $lte: dayEnd },
                },
            },
            {
                $addFields: {
                    total_val: { $convert: { input: "$swipe_by_refunded", to: "double", onError: 0, onNull: 0 } },
                    ref_raw: { $convert: { input: "$refund_total", to: "double", onError: 0, onNull: 0 } },
                    reo_raw: { $convert: { input: "$reorder_total", to: "double", onError: 0, onNull: 0 } },
                },
            },
            {
                $addFields: {
                    refund_total_numeric: {
                        $cond: [
                            { $gt: [{ $add: ["$ref_raw", "$reo_raw"] }, 0] },
                            { $multiply: ["$total_val", { $divide: ["$ref_raw", { $add: ["$ref_raw", "$reo_raw"] }] }] },
                            { $cond: [{ $in: ["$refund_status", ["REFUND", "refund"]] }, "$total_val", 0] },
                        ],
                    },
                    reorder_total_numeric: {
                        $cond: [
                            { $gt: [{ $add: ["$ref_raw", "$reo_raw"] }, 0] },
                            { $multiply: ["$total_val", { $divide: ["$reo_raw", { $add: ["$ref_raw", "$reo_raw"] }] }] },
                            { $cond: [{ $in: ["$refund_status", ["REPLACE", "reorder"]] }, "$total_val", 0] },
                        ],
                    },
                },
            },
            {
                $group: {
                    _id: null,
                    totalRefundValue: {
                        $sum: {
                            $cond: [
                                { $gt: ["$refund_total_numeric", 0] },
                                "$refund_total_numeric",
                                0,
                            ],
                        },
                    },
                    totalReorderValue: {
                        $sum: {
                            $cond: [
                                { $gt: ["$reorder_total_numeric", 0] },
                                "$reorder_total_numeric",
                                0,
                            ],
                        },
                    },
                },
            },
            {
                $addFields: {
                    claimsAmount: { $add: ["$totalRefundValue", "$totalReorderValue"] },
                },
            },
        ]);

        const claimsAmount = formatUsd(resolvedClaimTotals?.claimsAmount || 0);
        const subjectDate = Moment.tz(reportDateYmd, TZ).format("ddd, MM/DD/YYYY");
        const reportDateLabel = Moment.tz(reportDateYmd, TZ).format("MMMM D, YYYY");

        await Notifications.sendNotification({
            subject: `Swipe Revenue Report - ${subjectDate}`,
            to: [
                "swipe@swipe.ai",
                "junaid@freedommedia.com",
                "angeli@freedommediax.com",
                "james@freedommediax.com",
                "pk@freedommedia.com",
                "matt@freedommedia.com"

            ],
            template: "DAILY_REVENUE_REPORT",
            totalOrder: totalOrderCount,
            protectedOrder: protectedOrderCount,
            totalRevenue: totalRevenue,
            totalActiveStores: totalActiveStores,
protectionRate: protectionRate,
claimsAmount: claimsAmount,
            dashboard_url: "https://dashboard.swipe.ai/dashboard",
            reportDate: reportDateLabel,
            reportWindowNote:
                `This report covers ${reportDateLabel} in Central Time and is sent 2 hours after the day ends.`,
        });

        const report = {
            reportDate: reportDateYmd,
            totalOrder: totalOrderCount,
            protectedOrder: protectedOrderCount,
            totalRevenue: totalRevenue,
        };

        return { message: MSG.REPORT_SEND, report };
    } catch (err) {
        // If this run failed, release today's lock so cron/manual retry can send again.
        try {
            await locks.deleteOne(lockFilter);
            console.error(`[DailyReport] Failed. Released lock for ${ymd}.`, err?.message || err);
        } catch (unlockErr) {
            console.error(
                `[DailyReport] Failed and lock release also failed for ${ymd}.`,
                unlockErr?.message || unlockErr
            );
        }
        throw err;
    }
};

module.exports = Statistic;
