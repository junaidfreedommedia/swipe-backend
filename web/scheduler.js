// Yeh code app.js ya scheduler.js mein daalein

const cron = require("node-cron");
const moment = require("moment-timezone");
const Models = require("./models");
const { computeDailyForDate } = require("./controllers/cron/computeDailySwipeReport");
const { autoFixDailyReports } = require("./controllers/cron/computeDailySwipeReport");
const { normalizeTimezone } = require("./utils/merchantTimezone");


const TZ = "America/Chicago";

console.log("⏰ Daily Report Cron Job scheduled!");

// '0 1 * * *' ka matlab hai har din raat 1:00 baje (minute 0, ghanta 1)
cron.schedule(
  "0 1 * * *",
  async () => {
    console.log(`[Cron Job] Daily computation shuru ho raha hai... (Time: ${moment().tz(TZ).format()})`);
    
    try {
      // 2. Saare active merchants ki list nikaalein
      // (Aap yahaan 'Models.Merchant' ya jo bhi aapka merchant model hai, use karein)
      const allMerchants = await Models.Merchant.find({ 
          // status: "active" // Agar active merchants hain toh yeh filter lagayein
      }).select("_id iana_timezone").lean();

      console.log(`[Cron Job] ${allMerchants.length} merchants ke liye data process hoga.`);

      // 3. Har merchant ke liye pichle din ka data compute karein
      for (const merchant of allMerchants) {
        try {
          const timezone = normalizeTimezone(merchant.iana_timezone);
          const yesterdayYmd = moment
            .tz(timezone)
            .subtract(1, "day")
            .format("YYYY-MM-DD");
          await computeDailyForDate(merchant._id, yesterdayYmd, timezone);
          console.log(`[Cron Job] Merchant ${merchant._id} ke liye ${yesterdayYmd} ka data compute ho gaya.`);
        } catch (merchantError) {
          console.error(`[Cron Job] Merchant ${merchant._id} ke liye Error:`, merchantError.message);
        }
      }

      console.log("[Cron Job] Saare merchants ki local-day reports process ho gayi hain.");
    } catch (err) {
      console.error("[Cron Job] FATAL ERROR:", err);
    }
  },
  {
    scheduled: true,
    timezone: TZ, // Yeh sabse zaroori hai!
  }
);

// AUTO-FIX CRON (Every 10 minutes)

cron.schedule(
  "*/10 * * * *",
  async () => {
    console.log(`[Auto-Fix Cron] Start @ ${moment().tz(TZ).format()}`);

    try {
      await autoFixDailyReports();
      console.log("[Auto-Fix Cron] Completed");
    } catch (err) {
      console.error("[Auto-Fix Cron] ERROR", err);
    }
  },
  {
    scheduled: true,
    timezone: TZ,
  }
);

