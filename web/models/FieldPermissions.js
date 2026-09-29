const Schema = Mongoose.Schema;
const FieldPermissionsSchema = Schema(
    {
        role:String,
        permissions:{
            type:Object
        }
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

module.exports = Mongoose.model('fieldpermissions', FieldPermissionsSchema)