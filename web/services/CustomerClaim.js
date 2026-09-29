const CustomerClaimModels = Models.CustomerClaim;
const CustomerClaim = {};

CustomerClaim.insert = async (data) => {
    return new CustomerClaimModels(data).save();
};

CustomerClaim.get = async (condition, projection, options) => {
    return CustomerClaimModels.findOne(condition, projection, options);
};

CustomerClaim.getAll = async (condition, projection, options = { lean: true }) => {
    return CustomerClaimModels.find(condition, projection, options);
};

CustomerClaim.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse) await CustomerClaimModels.aggregate(pipeline).allowDiskUse(true);
    return CustomerClaimModels.aggregate(pipeline);
};

CustomerClaim.updateOne = async (condition, info) => {
    return CustomerClaimModels.updateOne(condition, info);
};

CustomerClaim.findOneAndUpdate = async (condition, info, options) => {
    return CustomerClaimModels.findOneAndUpdate(condition, info, options);
};

CustomerClaim.distinct = async (field, condition) => {
    return CustomerClaimModels.distinct(field, condition);
};

CustomerClaim.count = async (condition) => {
    return CustomerClaimModels.countDocuments(condition);
};

module.exports = CustomerClaim;
