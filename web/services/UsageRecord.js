const usageRecordModels = Models.UsageRecord;
const UsageRecord = {};

UsageRecord.insert = async (data) => {
  return new usageRecordModels(data).save();
};

UsageRecord.createLedgerEntry = async (data) => {
  try {
    const record = await new usageRecordModels(data).save();
    return { record, duplicate: false };
  } catch (error) {
    const isDuplicate =
      error?.code === 11000 ||
      String(error?.message || "").includes("E11000 duplicate key");

    if (!isDuplicate || !data?.adjustment_key) {
      throw error;
    }

    const record = await usageRecordModels.findOne(
      { adjustment_key: data.adjustment_key },
      null,
      { lean: true }
    );

    return { record, duplicate: true };
  }
};

UsageRecord.findByAdjustmentKey = async (adjustmentKey) => {
  return usageRecordModels.findOne(
    { adjustment_key: adjustmentKey },
    null,
    { lean: true }
  );
};

UsageRecord.get = async (condition, projection, options = { lean: true }) => {
  return usageRecordModels.findOne(condition, projection, options);
};

UsageRecord.getAll = async (condition) => {
  return usageRecordModels.find(condition);
};

UsageRecord.aggregate = async (pipeline, allowDiskUse = false) => {
  if (allowDiskUse)
    return usageRecordModels.aggregate(pipeline).allowDiskUse(true);
  return usageRecordModels.aggregate(pipeline);
};

UsageRecord.findByIdAndUpdate = async (user_id, info) => {
  return usageRecordModels.findByIdAndUpdate(user_id, info, { new: true });
};

UsageRecord.findOneAndUpdate = async (condition, info, options) => {
  return usageRecordModels.findOneAndUpdate(condition, info, options);
};

UsageRecord.updateOne = async (condition, info) => {
  return usageRecordModels.updateOne(condition, info);
};

UsageRecord.findByIdAndDelete = async (user_id, info) => {
  return usageRecordModels.findByIdAndDelete(user_id);
};

UsageRecord.RevenueStatisticList = async (
  merchant_id,
  start_date,
  end_date,
  timezone
) => {
  try {
    const condition = { merchant: merchant_id };
    if (start_date || end_date) {
      condition.createdAt = {};
      if (start_date) {
        condition.createdAt.$gte = new Date(start_date);
      }
      if (end_date) {
        condition.createdAt.$lte = new Date(end_date);
      }
    }

    // ---- Query 1: Credits (refunds + reorders) ----
    const creditAgg = await usageRecordModels.aggregate([
      { $match: { ...condition, type: "credit" } },
      {
        $group: {
          _id: "$credit_type",
          total: { $sum: "$amount" },
        },
      },
    ]);

    let refund = 0,
      reorder = 0,
      totalCredit = 0;
    creditAgg.forEach((c) => {
      if (c._id === "refund") refund += c.total;
      else reorder += c.total;
      totalCredit += c.total;
    });

    // ---- Query 2: Usages (fees collected) ----
    const usageAgg = await usageRecordModels.aggregate([
      { $match: { ...condition, type: "usages" } },
      {
        $group: {
          _id: null,
          fees_collected: { $sum: "$amount" },
        },
      },
    ]);

    const fees_collected =
      usageAgg.length > 0 ? Math.round(usageAgg[0].fees_collected) : 0;

    // ---- Final Calculations ----
    const net_revenue = Math.round(fees_collected - totalCredit);
    const paid_out = Math.round(totalCredit);

    return {
      message:
        fees_collected || totalCredit ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
      data: [
        {
          fees_collected,
          net_revenue,
          paid_out,
        },
      ],
    };
  } catch (error) {
    throwError(error);
  }
};

module.exports = UsageRecord;
