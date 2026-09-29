const Models = require("../models");  
const regionModel = Models.Region;
const Region = {};

Region.get = async function ({ condition = {}, projection = {}, options = {} }) {
    return regionModel.findOne(condition, projection, options);
};
  
Region.getAll = async function ({ condition = {}, projection = {}, options = {} }) {
    return  regionModel.find(condition, projection, options);
};

Region.updateOne = async (condition, info) => {
    return regionModel.updateOne(condition, info)
};

Region.findByIdAndDelete = async (user_id, info) => {
    return regionModel.findByIdAndDelete(user_id);
};

Region.aggregate = async (pipeLine) => {
    return regionModel.aggregate(pipeLine);
};

Region.getResource = async (options) => {
    let condition = [];
    if (!empty(options.city)) {
        condition.push({
            "areas.type": "city",
            "areas.city": options.city,
            "areas.state": options.state,
        });
    }
    if (!empty(options.county)) {
        condition.push({
            "areas.type": "county",
            "areas.county": options.county,
            "areas.state": options.state,
        });
    }
    if (!empty(options.state)) {
        condition.push({
            "areas.type": "state",
            "areas.value": options.state,
        });
    }
    if (!empty(options.default)) {
        condition.push({
            "areas.type": "state",
            "areas.value": "default"
        });
    }
    const regions = await Region.aggregate([
        { $match: { $or: condition } },
        { $unwind: "$resources" },
        { $sort: { "resources.seq": 1 } },
        {
            $lookup: {
                from: "users",
                let: { userIds: "$resources.user" },
                pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$userIds"] } } }],
                as: "userInfo",
            },
        },
        { $unwind: "$userInfo" },
        { $match: { "userInfo.disabled": false } },
        { $project: { userInfo: 0 } },
        {
            $group: {
                _id: "$_id",
                resources: { $push: "$$ROOT.resources" },
                areas: { $first: "$areas" },
                name: { $first: "$name" },
            },
        },
    ]);
  
    if (regions.length > 0) {
        let region = regions[0];
        let assignMgrIndex = 0;
        let managers = region.resources.filter(o => o.is_account_manager);
        let lastManagerIndex = managers.findIndex(o => o.is_last_assign_manager);

        if (lastManagerIndex >= 0) {
            assignMgrIndex = (lastManagerIndex + 1) % managers.length;
        }
        let manager = managers[assignMgrIndex];
        return { _id: region._id, manager };
    } else {
        return { manager: {} };
    }
};

Region.updateLastAssign = async (options) => {
    if (options.type === "manager") {
        await Region.updateOne(
            { _id: ObjectId(options._id), "resources.is_last_assign_manager": true },
            { $set: {"resources.$.is_last_assign_manager": false } }
        );
        await Region.updateOne(
            { _id: ObjectId(options._id), "resources.user": options.user },
            { $set: {"resources.$.is_last_assign_manager": true } }
        );
    }
};

module.exports = Region;