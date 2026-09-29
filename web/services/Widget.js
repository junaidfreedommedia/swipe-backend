const Models = require("../models");  
const widgetModels = Models.Widgets;
const Widget = {};

Widget.insert = async (data) => {
    return new widgetModels(data).save();
};

Widget.get = async (condition, projection, options = { lean: true }) => {
    return widgetModels.findOne(condition, projection, options);
};

Widget.getAll = async (condition, projection, options = { lean: true }) => {
    return widgetModels.find(condition, projection, options);
};

Widget.count = async (condition) => {
    return widgetModels.count(condition);
};

Widget.aggregate = async (pipeline, allowDiskUse = false) => {
    return widgetModels.aggregate(pipeline).allowDiskUse(allowDiskUse);
};

Widget.findOneAndUpdate = async (condition, info, options) => {
    return widgetModels.findOneAndUpdate(condition, info, options);
};

Widget.findByIdAndUpdate = async (user_id, info) => {
    return widgetModels.findByIdAndUpdate(user_id, info, { new: true });
};

Widget.updateOne = async (condition, info) => {
    return widgetModels.updateOne(condition, info);
};

Widget.deleteMany = async (condition) => {
    return widgetModels.deleteMany(condition);
};

Widget.getAllWidget = async (shopId, widgetKey) => {
    try {
        const merchantInfo = await Services.Merchant.get(
            { id: shopId },
            { _id: 1 }
        );
        if (!merchantInfo) throwError(MSG.MERCHANT_NOT_FOUND);

        const list = await Widget.get(
            { merchant: merchantInfo._id },
            { __v: 0, createdAt: 0, updatedAt: 0 }
        );

        let backgroundColor = '#fdf399'; 
        let textColor = '#000000'; 

        if (!widgetKey) {
            if (!list.configure_bar.banner_background_color) {
                list.configure_bar.banner_background_color = backgroundColor;
            }
            if(!list.configure_bar.font_color){
                list.configure_bar.font_color = textColor;
            }
            return {
                message: MSG.DATA_FOUND,
                data: list,
            };
        }

        if (widgetKey === "configure_bar" || widgetKey === "cart_page") {
            const keyData = list[widgetKey];
            if (keyData) {
                if (!keyData.banner_background_color) {
                    keyData.banner_background_color = backgroundColor;
                }
                if(!keyData.font_color){
                    keyData.font_color = textColor;
                }
                return {
                    message: MSG.DATA_FOUND,
                    data: keyData,
                };
            }
        }
        return {
            message: MSG.INVALID_KEY,
            data: null,
        };
    } catch (error) {
        return error;
    }
};

Widget.postAllWidget = async (merchantId, payload) => {
    const { key, data } = payload;
    try {
        let allowedKeys = ["configure_bar", "cart_page"];
        if (allowedKeys.includes(key)) {
            const query = { merchant: merchantId };
            const update = { $set: {} };
            for (const field in data) {
                update.$set[`${key}.${field}`] = data[field];
            }
            const options = { new: true, upsert: true };
            const updatedWidget = await Widget.findOneAndUpdate(
                query,
                update,
                options
            );

            const task = await Services.Task.get({ merchant: merchantId });
            if (task.protect_and_resolve.setup_shipping_protection_banner !== 'Completed') {
                if (key === 'configure_bar' && data['is_active'] === true) {
                    await Services.Task.findOneAndUpdate(
                        { merchant: merchantId },
                        { $set: { 'protect_and_resolve.setup_shipping_protection_banner' : 'Completed' } }
                    );
                }
                const updated_task = await Services.Task.get({ merchant: merchantId });
                if (updated_task.protect_and_resolve.setup_shipping_protection_banner == 'Completed' &&
                updated_task.protect_and_resolve.implement_swipe_protect_widget == 'Completed'){
                        await Services.Task.findOneAndUpdate(
                            { merchant: merchantId },
                            { $set: { 'protect_and_resolve.done': true } },
                        );
                    }
            }
            return { message: MSG.DATA_UPDATED, data: updatedWidget };
        }
    } catch (error) {
        throwError(error);
    }
};

module.exports = Widget;
