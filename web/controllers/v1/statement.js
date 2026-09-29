const express = require("express");
const { Buffer } = require("buffer");
const axiosService = require("./../../utils/axios");
const router = express.Router();
const Statement = Services.Statement;
const { Types } = require("mongoose");
const axios = require("axios");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  region: process.env.AWS_REGION,
});

const List = async (req, res, next) => {
    try {
        const { merchantId } = req.params;
        Auth.assertMerchantAccess(req.user, merchantId);
        const { month, year } = req.query;
        const limit = parseInt(req.query.limit) || 25;
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;

        let condition = {};
        if (merchantId) condition.merchant = ObjectId(merchantId);
    if (month && year) {
  condition.month = Number(month);
  condition.year = Number(year);
} else if (month && typeof month === "string" && month.includes("-")) {
  condition.statement_month = month; // YYYY-MM
}

        const pipeline = [];

        pipeline.push(
            { $match: condition },
            { $sort: { createdAt: -1 } },
            {
                $facet: {
                    statementList: [{ $skip: skip }, { $limit: limit }],
                    metadata: [{ $count: "totalRecords" }],
                },
            }
        );

        const result = await Statement.aggregate(pipeline);

        const data = result[0]?.statementList || [];
        const totalRecords = result[0]?.metadata[0]?.totalRecords || 0;

        res.send({
            data,
            totalRecords,
            message: data.length === 0 ? MSG.DATA_NOT_FOUND : MSG.DATA_FOUND,
        });
    } catch (error) {
        return next(error);
    }
};


const StatementPreview = async (req, res, next) => {
  try {
    const { merchantId, month } = req.query;

    if (!month) {
      throwError("Month is required", 400);
    }

    let finalMerchantId;

    // 👑 ADMIN
    if (req.user.role === "admin") {
      if (!merchantId || !Types.ObjectId.isValid(merchantId)) {
        throwError("Valid merchantId is required for admin", 400);
      }
      finalMerchantId = merchantId;
    }
    // 🏪 MERCHANT
    else {
      finalMerchantId = req.user.merchant;
    }

    Auth.assertMerchantAccess(req.user, finalMerchantId);

    const statement = await Statement.get({
      merchant: new Types.ObjectId(finalMerchantId),
      statement_month: String(month),
    });

    if (!statement) {
      throwError("Statement Preview not available!", 404);
    }

    let fetchUrl;

    // ✅ OLD RECORDS (existing behaviour)
    if (statement.url) {
      fetchUrl = statement.url;
    }
    // ✅ NEW RECORDS (fallback)
    else if (statement.s3_key) {
      const signedUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: statement.s3_key,
        }),
        { expiresIn: 300 } // 5 minutes
      );
      fetchUrl = signedUrl;
    }
    // ❌ NOTHING FOUND
    else {
      throwError("Statement file not available", 404);
    }

    const response = await axios.get(fetchUrl, {
      responseType: "arraybuffer",
    });

    if (!response || !response.data) {
      throwError("Unable to load statement file", 500);
    }

    const buffer = Buffer.from(response.data);

    // ✅ SAME OLD FRONTEND RESPONSE
    res.status(200).send({
      preview: buffer,
    });
  } catch (error) {
    next(error);
  }
};



const AdminStatementList = async (req, res, next) => {
    try {
        const { merchantId, month, year } = req.query;
        const limit = parseInt(req.query.limit) || 25;
        const page = parseInt(req.query.page) || 1;
        const skip = (page - 1) * limit;
        let condition = {};
        if (!Auth.isSuperAdmin(req.user)) {
            condition.merchant = {
                $in: Auth.getAssignedMerchantIds(req.user).map((id) => ObjectId(id)),
            };
        }
        if (merchantId) {
            Auth.assertMerchantAccess(req.user, merchantId);
            condition.merchant = ObjectId(merchantId);
        }
    if (month && year) {
  condition.month = Number(month);
  condition.year = Number(year);
} else if (month && typeof month === "string" && month.includes("-")) {
  condition.statement_month = month;
}

        console.log(condition);
        const pipeline = [];

        pipeline.push(
            { $match: condition },
            {
                $lookup: {
                    from: "merchants",
                    localField: "merchant",
                    foreignField: "_id",
                    as: "merchant",
                },
            },
            { $unwind: "$merchant" },
            {
                $sort: { createdAt: -1 },
            },
            {
                $project: {
                    _id: 1,
                    statement_month: 1,
                    month: 1,
                    year: 1,
                    url: 1,
                    shopify_charge_amount: 1,
                    shopify_charge_status: 1,
                    shopify_charge_description: 1,
                    shopify_charged_at: 1,
                    billing_status: 1,
                    billing_provider: 1,
                    billing_amount_cents: 1,
                    "merchant._id": 1,
                    "merchant.name": 1,
                },
            }
        );

        // Final facet stage: pagination and total count
        pipeline.push({
            $facet: {
                metadata: [{ $count: "totalRecords" }],
                statementList: [{ $skip: skip }, { $limit: limit }],
            },
        });

        const result = await Statement.aggregate(pipeline);
        const data = result[0]?.statementList || [];
        const totalRecords = result[0]?.metadata[0]?.totalRecords || 0;
        res.send({
            data,
            totalRecords,
            message: data.length === 0 ? MSG.DATA_NOT_FOUND : MSG.DATA_FOUND,
        });
    } catch (error) {
        return next(error);
    }
};

router.get("/merchant/:merchantId", Auth.check, List);
router.get("/preview", Auth.check, StatementPreview);
router.get("/list", Auth.check, AdminStatementList);

module.exports = router;
