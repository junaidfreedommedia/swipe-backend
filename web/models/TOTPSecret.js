const Schema = Mongoose.Schema;

const TOTPSecretSchema = Schema(
    {
        user_id: {
            type: Schema.Types.ObjectId,
            ref: 'users',
            required: true,
            unique: true
        },
        secret: {
            type: String,
            required: true
        },
        // When the secret was last used for verification
        last_used: {
            type: Date,
            default: null
        }
    },
    {
        timestamps: true
    }
);

// Create an index on user_id for faster lookups
TOTPSecretSchema.index({ user_id: 1 });

module.exports = Mongoose.model('totp_secrets', TOTPSecretSchema); 