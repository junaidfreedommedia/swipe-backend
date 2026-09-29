const mongoose = require('mongoose');
const schema = mongoose.Schema;

const StatisticsSchema = schema(
    {
        month: Number,
        year: Number,
        statistics_month: String,
        fees_collected: Number,
        fees_collected_per: String,
        net_revenue: Number,
        net_revenue_per: String,
        protected_revenue: Number,
        protected_revenue_per: String,
        paid_out: Number,
        paid_out_per: String,
        new_install: Number,
        new_install_per: String,
        in_review: Number,
        approved: Number,
        closed: Number,
    },
    {
        timestamps: true,
        id: false,
        toObject: {
            virtuals: true,
            getters: true
        },
        toJSON: {
            virtuals: true,
            getters: true
        }
    }
)

module.exports = mongoose.model("statistics", StatisticsSchema);