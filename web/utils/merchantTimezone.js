const moment = require("moment-timezone");

const DEFAULT_MERCHANT_TIMEZONE = "America/Chicago";

const isValidTimezone = (timezone) =>
  typeof timezone === "string" && Boolean(moment.tz.zone(timezone.trim()));

const normalizeTimezone = (timezone) =>
  isValidTimezone(timezone)
    ? timezone.trim()
    : DEFAULT_MERCHANT_TIMEZONE;

const validateTimezoneSetting = (timezone) => {
  if (timezone === undefined || timezone === null || timezone === "") {
    return DEFAULT_MERCHANT_TIMEZONE;
  }

  if (!isValidTimezone(timezone)) {
    const error = new Error("Invalid IANA timezone.");
    error.status = 400;
    throw error;
  }

  return timezone.trim();
};

const getMerchantTimezone = async (merchantOrId, explicitTimezone) => {
  if (explicitTimezone !== undefined) {
    return normalizeTimezone(explicitTimezone);
  }

  if (merchantOrId && typeof merchantOrId === "object") {
    return normalizeTimezone(merchantOrId.iana_timezone);
  }

  if (!merchantOrId) return DEFAULT_MERCHANT_TIMEZONE;

  const Merchant = require("../models/Merchant");
  const merchant = await Merchant.findById(merchantOrId)
    .select({ iana_timezone: 1 })
    .lean();

  return normalizeTimezone(merchant?.iana_timezone);
};

const getMerchantDayEndReportDate = (timezone, referenceTime = new Date()) => {
  const localTime = moment(referenceTime).tz(normalizeTimezone(timezone));

  if (
    !localTime.isValid() ||
    localTime.hour() !== 0 ||
    localTime.minute() !== 20
  ) {
    return null;
  }

  return localTime.subtract(1, "day").format("YYYY-MM-DD");
};

module.exports = {
  DEFAULT_MERCHANT_TIMEZONE,
  getMerchantDayEndReportDate,
  getMerchantTimezone,
  isValidTimezone,
  normalizeTimezone,
  validateTimezoneSetting,
};
