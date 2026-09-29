const Schema = Mongoose.Schema;
const AclSchema = Schema(
    {
        role: String,
        permissions: Object
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

module.exports = Mongoose.model('acls', AclSchema)