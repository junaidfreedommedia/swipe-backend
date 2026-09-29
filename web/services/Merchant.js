const Models = require("../models");
const MerchantSchema = Models.Merchant;
const {
    DEFAULT_MERCHANT_TIMEZONE,
    normalizeTimezone,
    validateTimezoneSetting,
} = require("../utils/merchantTimezone");

const Merchant = {};
const ALLOWED_BILLING_TYPES = new Set(["stripe", "shopify", "manual"]);

const normalizeBillingType = (value) => {
    if (empty(value)) return undefined;
    const normalized = String(value).trim().toLowerCase();
    return ALLOWED_BILLING_TYPES.has(normalized) ? normalized : "stripe";
};

const normalizeMerchantPayload = (data = {}) => {
    if (!data || typeof data !== "object") return data;

    const nextData = { ...data };

    if (Object.prototype.hasOwnProperty.call(nextData, "billing_type")) {
        nextData.billing_type = normalizeBillingType(nextData.billing_type);
    }

    if (Object.prototype.hasOwnProperty.call(nextData, "iana_timezone")) {
        nextData.iana_timezone = validateTimezoneSetting(nextData.iana_timezone);
    }

    return nextData;
};

Merchant.insert = async (data) => {
    const normalizedPayload = normalizeMerchantPayload(data || {});
    if (!normalizedPayload.billing_type) {
        normalizedPayload.billing_type = 'stripe';
    }
    if (!normalizedPayload.iana_timezone) {
        normalizedPayload.iana_timezone = DEFAULT_MERCHANT_TIMEZONE;
    }
    data = normalizedPayload;
    return new MerchantSchema(data).save();
};

Merchant.get = async (condition, projection, options = { lean: true }) => {
    return MerchantSchema.findOne(condition, projection, options);
};

Merchant.count = async (condition) => {
    return MerchantSchema.countDocuments(condition);
};

Merchant.getAll = async (condition, projection) => {
    return MerchantSchema.find(condition, projection);
};

Merchant.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse)
        return MerchantSchema.aggregate(pipeline).allowDiskUse(true);
    return MerchantSchema.aggregate(pipeline);
};

Merchant.updateOne = async (condition, info) => {
    const timezoneUpdate = Object.prototype.hasOwnProperty.call(
        info?.$set || {},
        "iana_timezone"
    );
    const previous = timezoneUpdate
        ? await MerchantSchema.findOne(condition, { iana_timezone: 1 }).lean()
        : null;

    if (info?.$set) {
        info = { ...info, $set: normalizeMerchantPayload(info.$set) };
    }
    const result = await MerchantSchema.updateOne(condition, info);

    if (
        timezoneUpdate &&
        previous?._id &&
        normalizeTimezone(previous.iana_timezone) !== info.$set.iana_timezone
    ) {
        await Models.DailyReport.deleteMany({ merchant: previous._id });
    }

    return result;
};

Merchant.findOneAndUpdate = async (condition, info, options) => {
    const resolvedOptions = options || {};
    const timezoneUpdate = Object.prototype.hasOwnProperty.call(
        info?.$set || {},
        "iana_timezone"
    );
    const previous = timezoneUpdate
        ? await MerchantSchema.findOne(condition, { iana_timezone: 1 }).lean()
        : null;

    if (info?.$set) {
        info = { ...info, $set: normalizeMerchantPayload(info.$set) };
    }
    if (resolvedOptions.upsert) {
        info = {
            ...info,
            $setOnInsert: {
                ...(info.$setOnInsert || {}),
                billing_type: normalizeBillingType(info?.$setOnInsert?.billing_type) || 'stripe',
            },
        };
    }
    const result = await MerchantSchema.findOneAndUpdate(
        condition,
        info,
        resolvedOptions
    );

    if (
        timezoneUpdate &&
        previous?._id &&
        normalizeTimezone(previous.iana_timezone) !== info.$set.iana_timezone
    ) {
        await Models.DailyReport.deleteMany({ merchant: previous._id });
    }

    return result;
};

Merchant.deleteOne = async (condition) => {
    return MerchantSchema.deleteOne(condition);
};

Merchant.UpsertSetting = async (merchantId, body) => {
    try {
        if (empty(body)) throwError("Invalid Payload");
        const normalizedBody = normalizeMerchantPayload(body);
        const shouldProvisionGoogleSheet =
            normalizedBody.google_sheet_claim_sync_enabled === true;
        const previousMerchant = shouldProvisionGoogleSheet
            ? await Merchant.get(
                { _id: merchantId },
                { google_sheet_claim_sync_enabled: 1 }
            )
            : null;
        
        let data = await Merchant.findOneAndUpdate(
            { _id: merchantId },
            { $set: normalizedBody },
            { new: true, upsert: true }
        );

        if (shouldProvisionGoogleSheet) {
            try {
                await Services.GoogleSheet.ensureMerchantSpreadsheet(data);
                data = await Merchant.get({ _id: merchantId });
            } catch (error) {
                if (previousMerchant?.google_sheet_claim_sync_enabled !== true) {
                    await Merchant.updateOne(
                        { _id: merchantId },
                        { $set: { google_sheet_claim_sync_enabled: false } }
                    ).catch(() => {});
                }
                throw error;
            }
        }

        const task = await Services.Task.get({ merchant: merchantId });
        
        if (task?.admin?.merchant_communication_email !== 'Completed'){
            const merchantData = await Services.Merchant.get({ _id: merchantId });

            if ( merchantData?.billing_contact_email?.length > 0 && 
                 merchantData?.reimbursement_contact_email?.length > 0 &&
                 merchantData?.claims_contact_email?.length > 0) {
                await Services.Task.findOneAndUpdate(
                    { merchant: merchantId },
                    { $set: { 'admin.merchant_communication_email': 'Completed' } },
                );
            } 
            
            const updated_task = await Services.Task.get({ merchant : merchantId });
            
            if (updated_task && updated_task.admin && 
                updated_task.admin.add_your_team == 'Completed' &&
                updated_task.admin.merchant_communication_email == 'Completed'){
                    await Services.Task.findOneAndUpdate(
                        { merchant: merchantId },
                        { $set: { 'admin.done': true } },
                    );
                }
        }
        
        return {
            message: data ? MSG.DATA_UPDATED : MSG.DATA_ADDED,
            data: data,
        };
    } catch (error) {
        throwError(error);
    }
}

Merchant.SettingList = async (merchantId) => {
    try {
        const data = await Merchant.get({ _id : merchantId});
        if (data && !data.iana_timezone) {
            data.iana_timezone = DEFAULT_MERCHANT_TIMEZONE;
        }
        return {
            message: data ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: data,
        };
    } catch (error) {
        throwError(error);
    }
};

module.exports = Merchant;
