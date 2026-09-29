const mongoose = require("mongoose");
const { MongoCron } = require("mongodb-cron");
const moment = require("moment-timezone");
const {
  getMerchantDayEndReportDate,
  normalizeTimezone,
} = require("../utils/merchantTimezone");
const Schema = mongoose.Schema;
const runningActions = new Set();

function shouldStartMongoCron() {
  if (global.IS_APP_PROCESS === true) return true;
  if (global.IS_APP_PROCESS === false) return false;

  if (String(process.env.DISABLE_MONGO_CRON).toLowerCase() === "true") return false;
  if (String(process.env.ENABLE_MONGO_CRON).toLowerCase() === "true") return true;

  const identity = [
    process.env.name,
    process.env.pm_exec_path,
    process.argv[1],
    process.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  // Run cron on app process only; skip queue/worker runtimes.
  if (identity.includes("worker-orders-updated")) return false;
  if (/\bworker\b/.test(identity)) return false;
  if (/\bqueue\b/.test(identity)) return false;

  return true;
}

function getService(name) {
  if (global.Services && global.Services[name]) {
    return global.Services[name];
  }
  try {
    return require(`../services/${name}`);
  } catch (_err) {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function processMerchantsInBatches(merchants, batchSize, delayMs, handler) {
  for (let i = 0; i < merchants.length; i += batchSize) {
    const batch = merchants.slice(i, i + batchSize);
    await Promise.all(batch.map((merchant) => handler(merchant)));
    if (delayMs > 0) await sleep(delayMs);
  }
}

function isMongoTimeoutError(error) {
  const message = String(error?.message || error || "");
  return (
    error?.name === "MongoNetworkTimeoutError" ||
    error?.code === "ETIMEDOUT" ||
    /connection.*timed out|ETIMEDOUT/i.test(message)
  );
}


async function runDailyMerchantComputation() {
  const { computeDailyForDate } = require("../controllers/cron/computeDailySwipeReport");
  console.log("[DAILY] Computing each merchant's previous local day");

  const merchants = await global.Models.Merchant.find({})
    .select("_id iana_timezone")
    .lean();

  const BATCH_SIZE = 2;
  const DELAY_MS = 800;
  const RETRY_DELAYS_MS = [5000, 15000, 30000];
  const failedMerchants = [];

  await processMerchantsInBatches(merchants, BATCH_SIZE, DELAY_MS, async (m) => {
    const timezone = normalizeTimezone(m.iana_timezone);
    const ymd = moment.tz(timezone).subtract(1, "day").format("YYYY-MM-DD");
    try {
      await computeDailyForDate(m._id, ymd, timezone);
    } catch (error) {
      console.error(`[DAILY ERROR ${m._id}]`, error.message);
      if (isMongoTimeoutError(error)) {
        failedMerchants.push({ ...m, timezone, ymd });
      }
    }
  });

  for (const merchant of failedMerchants) {
    const merchantId = merchant._id;
    const { timezone, ymd } = merchant;
    let succeeded = false;
    let lastError;

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      console.log(
        `[DAILY RETRY ${attempt + 1}/3 ${merchantId}] waiting ${delayMs / 1000}s`
      );
      await sleep(delayMs);

      try {
        await computeDailyForDate(merchantId, ymd, timezone);
        console.log(
          `[DAILY RETRY SUCCESS ${merchantId}] attempt=${attempt + 1}`
        );
        succeeded = true;
        break;
      } catch (error) {
        lastError = error;
        if (!isMongoTimeoutError(error)) {
          break;
        }
      }
    }

    if (!succeeded) {
      console.error(
        `[DAILY FINAL FAILURE ${merchantId}]`,
        lastError?.message || lastError
      );
    }
  }
  console.log("✅ DailyMerchantComputation DONE");
}

async function runMerchantLocalDayEndComputation(scheduledAt) {
  const { computeDailyForDate } = require("../controllers/cron/computeDailySwipeReport");
  const referenceTime = moment(scheduledAt).isValid()
    ? moment(scheduledAt).toDate()
    : new Date();

  const merchants = await global.Models.Merchant.find({})
    .select("_id iana_timezone")
    .lean();

  const dueMerchants = merchants.reduce((due, merchant) => {
    const timezone = normalizeTimezone(merchant.iana_timezone);
    const ymd = getMerchantDayEndReportDate(timezone, referenceTime);

    if (ymd) due.push({ merchantId: merchant._id, timezone, ymd });
    return due;
  }, []);

  if (!dueMerchants.length) return;

  console.log(
    `[DAY END] Computing ${dueMerchants.length} merchant report(s) at local 00:20`
  );

  const BATCH_SIZE = 2;
  const DELAY_MS = 800;

  await processMerchantsInBatches(
    dueMerchants,
    BATCH_SIZE,
    DELAY_MS,
    async ({ merchantId, timezone, ymd }) => {
      try {
        await computeDailyForDate(merchantId, ymd, timezone);
      } catch (error) {
        console.error(
          `[DAY END ERROR ${merchantId} ${ymd} ${timezone}]`,
          error.message
        );
      }
    }
  );

  console.log("✅ Merchant-local day-end computation DONE");
}

// ============================================================
// 1. SCHEMA DEFINITION (UNCHANGED)
// ============================================================
const CronSchema = Schema(
  {
    sleepUntil: { type: Date, default: Date.now },
    isEnabled: { type: Boolean, default: true },
    interval: String,
    repeatUntil: Date,
    autoRemove: Boolean,
    alertNo: String,
    action: {
      type: String,
      default: "SendAlert",
    },
  },
  {
    collection: "cron_jobs",
    timestamps: true,
    id: false,
    toObject: { virtuals: true, getters: true },
    toJSON: { virtuals: true, getters: true },
  }
);

const CronTask = mongoose.model("CronJob", CronSchema);
module.exports = CronTask;

// ============================================================
// 2. ENSURE DAILY (YESTERDAY) JOB
// ============================================================
async function ensureDailyJobExists(Model) {
  const actionName = "DailyMerchantComputation";
  const correctInterval = "0 5,6,15 * * *"; // Chicago aligned
  const legacyMidnightIntervals = [
    "15 6 * * *",
    "45 2 * * *",
    "55 2 * * *",
    "20 3 * * *",
    "35 3 * * *",
    "55 3 * * *",
    "55 4 * * *",
    "20 5 * * *",
    "40 5 * * *",
    "50 5 * * *",
    "55 5 * * *",
    "20 0 * * *",
  ];

  if (mongoose.connection.readyState !== 1) return;

  const chicagoNow = moment.tz("America/Chicago");
  const nextRegularRun = [5, 6, 15]
    .map((hour) =>
      chicagoNow.clone().hour(hour).minute(0).second(0).millisecond(0)
    )
    .find((runAt) => runAt.isAfter(chicagoNow)) ||
    chicagoNow.clone().add(1, "day").hour(5).minute(0).second(0).millisecond(0);

  await Model.findOneAndUpdate(
    { action: actionName, interval: { $nin: legacyMidnightIntervals } },
    {
      $set: {
        interval: correctInterval,
        isEnabled: true,
        sleepUntil: nextRegularRun.toDate(),
      },
      $setOnInsert: {
        lastRunAt: null,
        lastRunStatus: "Pending",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Retire all historical fixed-time midnight jobs. A null sleepUntil is
  // ignored by mongodb-cron, so these records cannot run alongside the
  // merchant-local dispatcher.
  await Model.updateMany(
    { action: actionName, interval: { $in: legacyMidnightIntervals } },
    { $set: { isEnabled: false, sleepUntil: null } }
  );

  console.log("✅ DailyMerchantComputation cron ensured");
}

async function ensureMerchantDayEndJobExists(Model) {
  const actionName = "DailyMerchantDayEnd";
  const nextMinute = moment().add(1, "minute").startOf("minute").toDate();

  const job = await Model.findOneAndUpdate(
    { action: actionName },
    {
      $set: {
        interval: "*/1 * * * *",
        isEnabled: true,
      },
      $setOnInsert: {
        sleepUntil: nextMinute,
        lastRunAt: null,
        lastRunStatus: "Pending",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Restore the canonical job if it was previously paused, and neutralize any
  // duplicate records that may have been created by concurrent app startups.
  if (!job.sleepUntil) {
    await Model.updateOne(
      { _id: job._id },
      { $set: { sleepUntil: nextMinute, isEnabled: true } }
    );
  }
  await Model.updateMany(
    { action: actionName, _id: { $ne: job._id } },
    { $set: { isEnabled: false, sleepUntil: null } }
  );

  console.log("✅ Merchant-local day-end cron ensured");
}

// ============================================================
// 3. ENSURE TODAY JOB (EVERY MINUTE)
// ============================================================
async function ensureTodayJobExists(Model) {
  const actionName = "DailyMerchantToday";

  await Model.findOneAndUpdate(
    { action: actionName },
    {
      $set: {
        interval: "*/1 * * * *", // every 1 minute
        isEnabled: true,
      },
      $setOnInsert: {
        lastRunAt: null,
        lastRunStatus: "Pending",
      },
    },
    { upsert: true, new: true }
  );

  console.log("✅ DailyMerchantToday cron ensured");
}

async function ensureRegisterWebhookJobExists(Model) {
  const actionName = "RegisterWebhook";

  await Model.findOneAndUpdate(
    { action: actionName },
    {
      $set: {
        interval: "0 */6 * * *", // every 6 hours
        isEnabled: true,
      },
      $setOnInsert: {
        lastRunAt: null,
        lastRunStatus: "Pending",
      },
    },
    { upsert: true, new: true }
  );

  console.log("✅ RegisterWebhook cron ensured");
}

async function ensureSendDailyReportJobExists(Model) {
  const actionName = "SendDailyReport";

  await Model.findOneAndUpdate(
    { action: actionName },
    {
      $set: {
        interval: "0 2 * * *",
        isEnabled: true,
      },
      $setOnInsert: {
        lastRunAt: null,
        lastRunStatus: "Pending",
      },
    },
    { upsert: true, new: true }
  );

  console.log("✅ SendDailyReport cron ensured");
}

async function ensureStatisticsJobExists(Model) {
  const actionName = "Statistics";

  await Model.findOneAndUpdate(
    { action: actionName },
    {
      $set: {
        interval: "0 0 1 * *", // Monthly at midnight on the 1st
        isEnabled: true,
      },
      $setOnInsert: {
        lastRunAt: null,
        lastRunStatus: "Pending",
      },
    },
    { upsert: true, new: true }
  );

  console.log("✅ Statistics cron ensured");
}

// Runs at the start of every month and retries/catches up after downtime.
// The service chooses the month using the same timezone as claim sheet rows.
async function ensureSheetPendingJobExists(Model) {
  const job = await Model.findOneAndUpdate(
    { action: "GoogleSheetPendingClaims" },
    {
      $set: { interval: "*/15 * * * *", isEnabled: true },
      $setOnInsert: { sleepUntil: new Date() },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (!job.sleepUntil) {
    await Model.updateOne({ _id: job._id }, { $set: { sleepUntil: new Date() } });
  }
  await Model.updateMany(
    { action: "GoogleSheetPendingClaims", _id: { $ne: job._id } },
    { $set: { isEnabled: false, sleepUntil: null } }
  );
}

async function autoRecreateTodayJob(Model) {
  const exists = await Model.findOne({ action: "DailyMerchantToday" }).lean();
  if (!exists) {
    console.log("⚠️ Today cron missing — recreating");
    await ensureTodayJobExists(Model);
  }
}

async function autoRecreateMerchantDayEndJob(Model) {
  const exists = await Model.findOne({ action: "DailyMerchantDayEnd" }).lean();
  if (!exists) {
    console.log("⚠️ Merchant-local day-end cron missing — recreating");
    await ensureMerchantDayEndJobExists(Model);
  }
}

async function autoRecreateRegisterWebhookJob(Model) {
  const exists = await Model.findOne({ action: "RegisterWebhook" }).lean();
  if (!exists) {
    console.log("⚠️ RegisterWebhook cron missing — recreating");
    await ensureRegisterWebhookJobExists(Model);
  }
}

async function autoRecreateSendDailyReportJob(Model) {
  const exists = await Model.findOne({ action: "SendDailyReport" }).lean();
  if (!exists) {
    console.log("⚠️ SendDailyReport cron missing — recreating");
    await ensureSendDailyReportJobExists(Model);
  }
}

async function autoRecreateStatisticsJob(Model) {
  const exists = await Model.findOne({ action: "Statistics" }).lean();
  if (!exists) {
    console.log("⚠️ Statistics cron missing — recreating");
    await ensureStatisticsJobExists(Model);
  }
}

// ============================================================
// 4. INIT + START CRON (🔥 CPU SAFE VERSION 🔥)
// ============================================================
const initAndStartCron = async () => {
  if (
    global.Cron ||
    global.DailyComputationCron ||
    global.MerchantDayEndCron
  ) {
    return;
  }

  try {
    console.log("🔌 Initializing MongoCron...");

    await ensureDailyJobExists(CronTask);
    await ensureMerchantDayEndJobExists(CronTask);
    await ensureTodayJobExists(CronTask);
    await ensureRegisterWebhookJobExists(CronTask);
    await ensureSendDailyReportJobExists(CronTask);
    await ensureStatisticsJobExists(CronTask);
    await ensureSheetPendingJobExists(CronTask);

    const collection = mongoose.connection.collection("cron_jobs");

    global.Cron = new MongoCron({
      collection,
      condition: {
        action: {
          $nin: ["DailyMerchantComputation", "DailyMerchantDayEnd"],
        },
      },
      nextDelay: 1000,
      idleDelay: 5000,
      timezone: "America/Chicago",

      onDocument: async (doc) => {
        if (runningActions.has(doc.action)) {
          console.log(`⏭️ Skipping Cron (${doc.action}) because previous run is still active`);
          return;
        }
        runningActions.add(doc.action);

        console.log(`🔄 Executing Cron: ${doc.action}`);

        try {
          // =====================================================
          // DAILY (YESTERDAY) — BATCHED
          // =====================================================
          // DailyMerchantComputation is handled by DailyComputationCron
          // via runDailyMerchantComputation().

          // =====================================================
          // TODAY — VERY SAFE (1 merchant at a time)
          // =====================================================
          if (doc.action === "DailyMerchantToday") {
            const { computeDailyForDate } = require("../controllers/cron/computeDailySwipeReport");
            console.log("[TODAY] Computing each merchant's current local day");

            const merchants = await global.Models.Merchant.find({})
              .select("_id iana_timezone")
              .lean();

            const BATCH_SIZE = 1;
            const DELAY_MS = 1000;

            await processMerchantsInBatches(merchants, BATCH_SIZE, DELAY_MS, async (merchant) => {
              try {
                const timezone = normalizeTimezone(merchant.iana_timezone);
                const todayYmd = moment.tz(timezone).format("YYYY-MM-DD");
                await computeDailyForDate(merchant._id, todayYmd, timezone);
              } catch (e) {
                console.error(`[TODAY ERROR ${merchant._id}]`, e.message);
              }
            });

            console.log("✅ DailyMerchantToday DONE");
          }

          // =====================================================
          // OTHER ACTIONS (UNCHANGED)
          // =====================================================
          else if (doc.action === "GoogleSheetPendingClaims") {
            const sheetService = getService("GoogleSheet");
            if (!sheetService?.refreshMonthlyPendingClaims) {
              throw new Error("Google Sheet pending service is unavailable");
            }
            await sheetService.refreshMonthlyPendingClaims();
          } else if (doc.action === "SendDailyReport") {
            const statisticService = getService("Statistic");
            if (!statisticService?.sendDailyRevenueReport) {
              console.warn("⚠️ SendDailyReport skipped: Statistic service not available");
            } else {
              await statisticService.sendDailyRevenueReport();
            }
          } else if (doc.action === "RegisterWebhook") {
            const merchantService = getService("Merchant");
            const webhookService = getService("Webhook");
            if (!merchantService?.getAll || !webhookService?.registerWebhooksForCron) {
              console.warn("⚠️ RegisterWebhook skipped: required services not available");
              return;
            }

            const merchants = await merchantService.getAll({ is_active: true }, { shop_id: 1 });
            console.log(`[Cron] Verifying webhooks for ${merchants.length} active merchants...`);

            const BATCH_SIZE = 3;
            const DELAY_MS = 500;

            await processMerchantsInBatches(merchants, BATCH_SIZE, DELAY_MS, async (merchant) => {
              try {
                const result = await webhookService.registerWebhooksForCron(merchant.shop_id);
                const fixedCount = (result?.missingRegistered?.length || 0) + (result?.repairedAddress?.length || 0);
                if (fixedCount > 0) {
                  console.log(
                    `[Cron] Self-healed ${merchant.shop_id}: missing=${result.missingRegistered.length}, repaired=${result.repairedAddress.length}`
                  );
                }
              } catch (mwErr) {
                console.error(`[Cron] Failed to register webhooks for ${merchant.shop_id}:`, mwErr.message);
              }
            });
          } else if (doc.action === "Statement") {
            const statementService = getService("Statement");
            if (!statementService?.CreatePdf) {
              console.warn("⚠️ Statement skipped: Statement service not available");
            } else {
              await statementService.CreatePdf();
            }
          } else if (doc.action === "Statistics") {
            const statisticService = getService("Statistic");
            if (!statisticService?.generateReport) {
              console.warn("⚠️ Statistics skipped: Statistic service not available");
            } else {
              await statisticService.generateReport();
            }
          }

        } catch (err) {
          console.error(`❌ Cron Error (${doc.action})`, err);
        } finally {
          runningActions.delete(doc.action);
        }
      },

      onError: async (err) => {
        console.error("❌ MongoCron System Error:", err);
      },
    });

    global.DailyComputationCron = new MongoCron({
      collection,
      condition: { action: "DailyMerchantComputation" },
      nextDelay: 1000,
      idleDelay: 5000,
      timezone: "America/Chicago",

      onDocument: async (doc) => {
        if (runningActions.has(doc.action)) {
          console.log(
            `Skipping Cron (${doc.action}) because previous run is still active`
          );
          return;
        }

        runningActions.add(doc.action);
        console.log(`Executing Cron: ${doc.action}`);

        try {
          await runDailyMerchantComputation();
        } catch (err) {
          console.error(`Cron Error (${doc.action})`, err);
        } finally {
          runningActions.delete(doc.action);
        }
      },

      onError: async (err) => {
        console.error("Daily MongoCron System Error:", err);
      },
    });

    global.MerchantDayEndCron = new MongoCron({
      collection,
      condition: { action: "DailyMerchantDayEnd" },
      nextDelay: 1000,
      idleDelay: 5000,

      onDocument: async (doc) => {
        if (runningActions.has(doc.action)) {
          console.log(
            `Skipping Cron (${doc.action}) because previous run is still active`
          );
          return;
        }

        runningActions.add(doc.action);
        console.log(`Executing Cron: ${doc.action}`);

        try {
          // Use the persisted scheduled tick so a short queue delay does not
          // cause merchants in the 00:20 local minute to be missed.
          await runMerchantLocalDayEndComputation(doc.sleepUntil);
        } catch (err) {
          console.error(`Cron Error (${doc.action})`, err);
        } finally {
          runningActions.delete(doc.action);
        }
      },

      onError: async (err) => {
        console.error("Merchant-local day-end MongoCron System Error:", err);
      },
    });

    global.MerchantDayEndCron.start();
    global.DailyComputationCron.start();
    global.Cron.start();
    console.log("🚀 MongoCron Started");

    setInterval(async () => {
      await autoRecreateMerchantDayEndJob(CronTask);
      await autoRecreateTodayJob(CronTask);
      await autoRecreateRegisterWebhookJob(CronTask);
      await autoRecreateSendDailyReportJob(CronTask);
      await autoRecreateStatisticsJob(CronTask);
      const sheetJob = await CronTask.findOne({ action: "GoogleSheetPendingClaims", isEnabled: true }).lean();
      if (!sheetJob) await ensureSheetPendingJobExists(CronTask);
    }, 30000);
  } catch (err) {
    console.error("❌ Failed to start cron:", err);
  }
};

// ============================================================
// 5. DB CONNECTION HANDLER
// ============================================================
if (!shouldStartMongoCron()) {
  console.log("⏭️ MongoCron disabled for this process");
} else {
  if (mongoose.connection.readyState === 1) {
    initAndStartCron();
  } else {
    mongoose.connection.once("open", () => {
      console.log("✅ Mongo connected — starting cron");
      initAndStartCron();
    });
  }
}
