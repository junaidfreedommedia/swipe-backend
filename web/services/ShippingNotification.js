const ShippingNotificationsSchema = Models.ShippingNotification;
const ShippingNotification = {};

ShippingNotification.insert = async (data) => {
    return new ShippingNotificationsSchema(data).save();
};

ShippingNotification.get = async (
    condition,
    projection,
    options = { lean: true }
) => {
    return ShippingNotificationsSchema.findOne(condition, projection, options);
};

ShippingNotification.count = async (condition) => {
    return ShippingNotificationsSchema.countDocuments(condition);
};

ShippingNotification.getAll = async (condition, projection) => {
    return ShippingNotificationsSchema.find(condition, projection);
};

ShippingNotification.updateOne = async (condition, info) => {
    return ShippingNotificationsSchema.updateOne(condition, info);
};

ShippingNotification.findOneAndUpdate = async (condition, info, options) => {
    return ShippingNotificationsSchema.findOneAndUpdate(
        condition,
        info,
        options
    );
};

ShippingNotification.upsertList = async (merchantId, body) => {
    try {
        if (empty(body)) return throwError("Invalid Payload");
        const upsertData = await ShippingNotification.findOneAndUpdate(
            { merchant: merchantId },
            { $set: body },
            { new: true, upsert: true }
        );
        return { message: MSG.DATA_UPDATED, data: upsertData };
    } catch (error) {
        return error;
    }
};

ShippingNotification.list = async (merchantId) => {
    try {
        const shippingInfo = await ShippingNotification.get({
            merchant: merchantId,
        });
        return { message: MSG.DATA_UPDATED, data: shippingInfo };
    } catch (error) {
        return error;
    }
};

module.exports = ShippingNotification;
