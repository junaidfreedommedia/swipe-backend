const Models = require("../models");  

const brandingModels = Models.Branding;
const Branding = {};

Branding.insert = async (data) => {
    return new brandingModels(data).save();
};

Branding.get = async (condition, projection, options) => {
    return brandingModels.findOne(condition, projection, options);
};

Branding.getAll = async (condition, projection, options = { lean: true }) => {
    return brandingModels.find(condition, projection, options);
};

Branding.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse)
        return brandingModels.aggregate(pipeline).allowDiskUse(true);
    return brandingModels.aggregate(pipeline);
};

Branding.findByIdAndUpdate = async (user_id, info) => {
    return brandingModels.findByIdAndUpdate(user_id, info, { new: true });
};

Branding.updateOne = async (condition, info) => {
    return brandingModels.updateOne(condition, info);
};

Branding.findByIdAndDelete = async (user_id, info) => {
    return brandingModels.findByIdAndDelete(user_id);
};

Branding.findOneAndUpdate = async (condition, info, options) => {
    return brandingModels.findOneAndUpdate(condition, info, options);
};

Branding.deleteMany = async (condition) => {
    return brandingModels.deleteMany(condition);
};
module.exports = Branding;