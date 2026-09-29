const Schema = Mongoose.Schema;
const CustomerClaimSchema = Schema(
    {
        customer: String,
        merchants: [
            {
                id:{
                    type: Schema.Types.ObjectId,
                    ref: "merchants",
                },
                name: String,
                count: Number,
            },
        ],
        total_count: Number
    },
    {
        timestamps: true,
        id: false,
        toObject: {
            virtuals: true,
            getters: true,
        },
        toJSON: {
            virtuals: true,
            getters: true,
        },
    }
);

module.exports = Mongoose.model("customerclaims", CustomerClaimSchema);
