const Schema = Mongoose.Schema;
const RegionSchema = Schema(
    {
        name: String,
        description: String,
        areas: [
            {
                _id: false,
                type: {
                    type: String
                },
                value: String,
                city: String,
                county: String,
                state: String
            }
        ],
        resources: [
            {
                _id: false,
                user: {
                    type: Schema.Types.ObjectId,
                    ref: 'User'
                },
                is_account_manager: Boolean,
                is_last_assign_manager: {
                    type: Boolean,
                    default: false
                },
                seq: Number
            }
        ],
        status: { type: Boolean, default: true },
        is_default: { type: Boolean, default: false }
    },
    {
        timestamps: false,
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
);

module.exports = Mongoose.model('regions', RegionSchema);
