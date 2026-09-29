const Schema = Mongoose.Schema;

const OTPSchema = Schema(
    {
        user_id: {
            type: Schema.Types.ObjectId,
            ref: 'users',
            required: true
        },
        otp: {
            type: String,
            required: true
        },
        purpose: {
            type: String,
            enum: ['login', 'enable_mfa', 'change_mfa'],
            required: true
        },
        expires_at: {
            type: Date,
            required: true,
            index: { expires: 0 } // This will auto-expire documents when expires_at is reached
        }
    },
    {
        timestamps: true
    }
);

// Create a compound index for user_id and purpose to find records quickly
OTPSchema.index({ user_id: 1, purpose: 1 });

module.exports = Mongoose.model('otps', OTPSchema); 