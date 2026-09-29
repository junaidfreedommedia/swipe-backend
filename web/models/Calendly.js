const Schema = Mongoose.Schema;
const CalendlySchema = Schema(
    {
        token: String,
        refresh_token: String,
        expires_in: Number,
        created_at: Number
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

module.exports = Mongoose.model('calendlys', CalendlySchema)