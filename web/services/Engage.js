const EngageSchema = Models.Engage;
const Engage = {};

Engage.insert = async (data) => {
    return new EngageSchema(data).save();
};

Engage.get = async (condition, projection, options = { lean: true }) => {
    return EngageSchema.findOne(condition, projection, options);
};

Engage.count = async (condition) => {
    return EngageSchema.countDocuments(condition);
};

Engage.getAll = async (condition, projection, options = { lean: true }) => {
    return EngageSchema.find(condition, projection, options);
};

Engage.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse)
        return EngageSchema.aggregate(pipeline).allowDiskUse(true);
    return EngageSchema.aggregate(pipeline);
};

Engage.updateOne = async (condition, info) => {
    return EngageSchema.updateOne(condition, info);
};

Engage.findOneAndUpdate = async (condition, info, options) => {
    return EngageSchema.findOneAndUpdate(condition, info, options);
};

Engage.upsertEngage = async (req, merchantId) => {
    try {
        const {
            store_name,
            website,
            bio,
            causes,
            logo,
            category,
            cover_image,
            company_contact_email,
            company_contact_phone,
            company_contact_link,
            support_contact_email,
            support_contact_phone,
            support_contact_link,
            returns_contact_email,
            returns_contact_phone,
            returns_contact_link,
            merchant_categories,
            merchant_categories_age,
            merchant_categories_gender,
            feed_image,
        } = req.body;

        const engageList = await Engage.findOneAndUpdate(
            { merchant: merchantId },
            {
                $set: {
                    store_name,
                    website,
                    bio,
                    causes,
                    logo,
                    category,
                    cover_image,
                    company_contact_email,
                    company_contact_phone,
                    company_contact_link,
                    support_contact_email,
                    support_contact_phone,
                    support_contact_link,
                    returns_contact_email,
                    returns_contact_phone,
                    returns_contact_link,
                    merchant_categories,
                    merchant_categories_age,
                    merchant_categories_gender,
                    feed_image,
                },
            },
            { new: true, upsert: true }
        );

        const task = await Services.Task.get({ merchant: merchantId });
        if (task.branding_and_profile.branding_and_merchant_profile !== 'Completed'){
            if ( engageList.store_name.length > 0 &&
                engageList.website.length > 0 &&
                engageList.bio.length > 0 &&
                engageList.cover_image.length > 0 &&
                engageList.website.length > 0 &&
                engageList.logo.length > 0
                ) {
                    await Services.Task.findOneAndUpdate(
                        { merchant: merchantId },
                        { $set: { 'branding_and_profile.branding_and_merchant_profile': 'Completed' } },
                    );
            }
        }

        if (task.branding_and_profile.setup_merchant_categories !== 'Completed'){
            if ( engageList.merchant_categories.length > 0 &&
                engageList.merchant_categories_age.length > 0 &&
                engageList.merchant_categories_gender.length > 0) {
                    await Services.Task.findOneAndUpdate(
                        { merchant: merchantId },
                        { $set: { 'branding_and_profile.setup_merchant_categories': 'Completed' } },
                    );
            }
        }
        const updated_task = await Services.Task.get({ merchant: merchantId });
        if (updated_task.branding_and_profile.setup_merchant_categories == 'Completed' &&
        updated_task.branding_and_profile.branding_and_merchant_profile == 'Completed'){
                await Services.Task.findOneAndUpdate(
                    { merchant: merchantId },
                    { $set: { 'branding_and_profile.done': true } },
                );
            }
        return {
            message: engageList.length ? MSG.DATA_UPDATED : MSG.DATA_ADDED,
            data: engageList,
        };
    } catch (error) {
        throwError(error);
    }
};

Engage.EngageList = async (merchantId) => {
    try {
        const engageInfo = await Engage.get({ merchant: merchantId });
        return {
            message: engageInfo ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: engageInfo,
        };
    } catch (error) {
        throwError(error);
    }
};

module.exports = Engage;
