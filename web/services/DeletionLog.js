const DeletionLogSchema = Models.DeletionLog;

const DeletionLog = {};

DeletionLog.insert = async (data) => {
    return new DeletionLogSchema(data).save();
};

DeletionLog.get = async (condition, projection, options = { lean: true }) => {
    return DeletionLogSchema.findOne(condition, projection, options);
};

DeletionLog.count = async (condition) => {
    return DeletionLogSchema.countDocuments(condition);
};

DeletionLog.getAll = async (condition, projection) => {
    return DeletionLogSchema.find(condition, projection);
};

DeletionLog.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse)
        return DeletionLogSchema.aggregate(pipeline).allowDiskUse(true);
    return DeletionLogSchema.aggregate(pipeline);
};

DeletionLog.updateOne = async (condition, info) => {
    return DeletionLogSchema.updateOne(condition, info);
};

DeletionLog.findOneAndUpdate = async (condition, info, options) => {
    return DeletionLogSchema.findOneAndUpdate(condition, info, options);
};

DeletionLog.deleteOne = async (condition) => {
    return DeletionLogSchema.deleteOne(condition);
};

module.exports = DeletionLog;
