const subscriptionModels = Models.Subscription;
const Subscription = {};

Subscription.insert = async (data) => {
    return new subscriptionModels(data).save();
};

Subscription.get = async (condition, projection, options) => {
    return subscriptionModels.findOne(condition, projection, options);
};

Subscription.getAll = async (condition) => {
    return subscriptionModels.find(condition);
};

Subscription.aggregate = async (pipeline, allowDiskUse  = false) => {
    if(allowDiskUse) return subscriptionModels.aggregate(pipeline).allowDiskUse(true);
    return subscriptionModels.aggregate(pipeline);
};

Subscription.findByIdAndUpdate = async (user_id, info) => {
    return subscriptionModels.findByIdAndUpdate(user_id, info, { new: true });
}

Subscription.updateOne = async (condition, info) => {
    return subscriptionModels.updateOne(condition, info)
};

Subscription.findByIdAndDelete = async (user_id, info) => {
    return subscriptionModels.findByIdAndDelete(user_id);
}

module.exports = Subscription;