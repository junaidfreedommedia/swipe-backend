const express = require("express");
const router = express.Router();

const buildBillingLedger = ({ usages = [], credits = [] }) => {
    const ledgerMap = new Map();

    const ensureRow = (key, seed = {}) => {
        if (!ledgerMap.has(key)) {
            ledgerMap.set(key, {
                key,
                order_name: seed.order_name || "Unmapped",
                usage_amount: 0,
                credit_amount: 0,
                net_amount: 0,
                source_types: new Set(),
                action_keys: new Set(),
                claim_ids: new Set(),
                updated_at: seed.updated_at || null,
            });
        }
        return ledgerMap.get(key);
    };

    usages.forEach((usage, index) => {
        const rowKey =
            usage.order?.toString() ||
            usage.order_name ||
            usage.adjustment_key ||
            `usage-${index}`;
        const row = ensureRow(rowKey, {
            order_name: usage.order_name,
            updated_at: usage.record_date || usage.createdAt,
        });
        row.usage_amount += Number(usage.amount || 0);
        row.order_name = row.order_name || usage.order_name || "Unmapped";
        row.updated_at = usage.record_date || usage.createdAt || row.updated_at;
        if (usage.source_type) row.source_types.add(usage.source_type);
        if (usage.action_key) row.action_keys.add(usage.action_key);
    });

    credits.forEach((credit, index) => {
        const rowKey =
            credit.order?.toString() ||
            credit.order_name ||
            credit.adjustment_key ||
            `credit-${index}`;
        const row = ensureRow(rowKey, {
            order_name: credit.order_name,
            updated_at: credit.record_date || credit.createdAt,
        });
        row.credit_amount += Number(credit.amount || 0);
        row.order_name = row.order_name || credit.order_name || "Unmapped";
        row.updated_at = credit.record_date || credit.createdAt || row.updated_at;
        if (credit.source_type) row.source_types.add(credit.source_type);
        if (credit.action_key) row.action_keys.add(credit.action_key);
        if (credit.claim) row.claim_ids.add(String(credit.claim));
    });

    return Array.from(ledgerMap.values())
        .map((row) => ({
            ...row,
            usage_amount: parseFloat(row.usage_amount.toFixed(2)),
            credit_amount: parseFloat(row.credit_amount.toFixed(2)),
            net_amount: parseFloat((row.usage_amount - row.credit_amount).toFixed(2)),
            source_types: Array.from(row.source_types),
            action_keys: Array.from(row.action_keys),
            claim_ids: Array.from(row.claim_ids),
        }))
        .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
};

const StatementFilter = async (req, res, next) => {
    try{
        let { merchant, start_date, end_date } = req.body;
        Auth.assertMerchantAccess(req.user, merchant);
        if(empty(start_date)) start_date = Moment().startOf('month');
        if(empty(end_date)) end_date = Moment().endOf('month');

        const merchantInfo = await Services.Merchant.get(
            { _id: merchant },
            { competition: 1 }
        );

        const startDate = Moment(start_date).startOf("day").toDate();
        const endDate = Moment(end_date).endOf("day").toDate();

        const usagesRecords = await Services.Statement.getUsageSummary({
            merchantId: merchant,
            startDate,
            endDate,
        });

        const dailySummary = await Services.Statement.getDailyReportSummary({
            merchantId: merchant,
            startDate,
            endDate,
        });

        usagesRecords.claim_credit = {
            refund: parseFloat((usagesRecords.total_refunds || 0).toFixed(2)),
            reorder: parseFloat((usagesRecords.total_reorders || 0).toFixed(2)),
        };
        usagesRecords.billing_ledger = buildBillingLedger({
            usages: usagesRecords.usages,
            credits: usagesRecords.credits,
        });

        const result = (
            usagesRecords.credits.length ||
            usagesRecords.usages.length ||
            dailySummary.report_days
        );
        const matrix = {};
        if(result){
            const claim_credit = usagesRecords.claim_credit;
            const baseShopifyBill = parseFloat(
                (
                    dailySummary.report_days > 0
                        ? Number(dailySummary.net_sales_c || 0) / 100
                        : Number(usagesRecords.fees_collected || 0)
                ).toFixed(2)
            );
            const commissionPercent = Number(merchantInfo?.competition || 0);
            matrix.total_credit = claim_credit.refund + claim_credit.reorder || 0;
            matrix.total_gross_sales = parseFloat(
                ((dailySummary.total_gross_sales_c || 0) / 100).toFixed(2)
            );
            matrix.total_discounts = parseFloat(
                ((dailySummary.swipe_discounts_c || 0) / 100).toFixed(2)
            );
            matrix.total_returns = parseFloat(
                ((dailySummary.net_returns_amount_c || 0) / 100).toFixed(2)
            );
            matrix.base_shopify_bill = baseShopifyBill;
            matrix.total_payable = baseShopifyBill - matrix.total_credit;
            matrix.commission_percent = commissionPercent;
            matrix.shopify_charge = parseFloat(
                ((matrix.total_payable * commissionPercent) / 100).toFixed(2)
            );
            matrix.net_payable = parseFloat(
                (matrix.total_payable - matrix.shopify_charge).toFixed(2)
            );
            usagesRecords.fees_collected = baseShopifyBill;
        }
        return res.send({ data: { ...matrix, ...usagesRecords}, message: result ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND });
    }catch(error){
        return next(error);
    }
}

const createStatement = async (req, res, next) => {
    try {
        const response = await Services.Statement.CreatePdf(req.body);
        console.log(response);
        if (response.merchantsProcessed > 0) {
            return res.status(200).send({
                message: `${response.message}`,
                status: "success",
                data: response
            });
        } else {
            return res.status(200).send({
                message: "No usage records found for the selected period. No PDFs were generated.",
                status: "failed",
                data: response
            });
        }
    } catch(error) {
        return next(error);
    }
};

const deleteStatement = async (req, res, next) => {
  try {
    const { id } = req.params;

    const statement = await Models.Statement.findById(id);

    if (!statement) {
      return res.status(404).send({
        status: "failed",
        message: "Statement not found",
      });
    }

    await Models.Statement.deleteOne({ _id: id });

    return res.status(200).send({
      status: "success",
      message: "Statement deleted successfully",
    });
  } catch (error) {
    return next(error);
  }
};



router.post('/', Auth.check, Func.validate(AdminRules.StatementFilter), StatementFilter);
router.post(
    '/create-statement',
    Auth.check,
    Auth.requireSuperAdmin,
    createStatement
);
router.delete(
    "/:id",
    Auth.check,
    Auth.requireSuperAdmin,
    deleteStatement
);
  




module.exports = router;
