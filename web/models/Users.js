const bcrypt = require("bcryptjs");
const saltRounds = 10;
const Schema = Mongoose.Schema;

const UserSchema = Schema(
    {
        display_name: String,
        email: String,
        permissions: [String],
        role: String,
        roles: [String],
        admin_type: {
            type: String,
            enum: ["super_admin", "simple_admin"],
        },
        admin_permissions: {
            claims_view: {
                type: Boolean,
                default: false,
            },
            claims_create: {
                type: Boolean,
                default: false,
            },
        },
        disabled: {
            type: Boolean,
            default: false,
        },
        email_verified: {
            type: Boolean,
            default: false,
        },
        mfa_enabled: {
            type: Boolean,
            default: false,
        },
        mfa_method: {
            type: String,
            enum: ['email', 'totp'],
            default: 'email'
        },
        pending_mfa_method: {
            type: String,
            enum: ['sms','email', null],
            default: null
        },
        mfa_setup_in_progress: {
            type: Boolean,
            default: false
        },
        last_loginAt: Date,
        password: String,
        user_verified: {
            type: Boolean,
            default: false,
        },
        social_links: [
            {
              type: {
                type: String,
                required: true,
                enum: ["facebook", "twitter", "linkedin", "instagram", "youtube", "website"], 
                },
               value: {
                    type: String,
                    required: true,
                    validate: {
                        validator: function (v) {
                        return /^(https?:\/\/)?([\w\d\-_]+\.+[A-Za-z]{2,})(\/.*)?$/.test(v);
                        },
                        message: props => `${props.value} is not a valid URL!`,
                    },
                },
            },
        ],
        merchant: {
            type: Schema.Types.ObjectId,
            ref: "merchants",
        },
        password_reset_key: String,
        merchants: [
            {
                type: Schema.Types.ObjectId,
                ref: "merchants",
            },
        ],
        is_deleted: { type: Boolean, default: false },
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
UserSchema.pre("save", function (next) {
    if ((!empty(this.password) && this.isNew) || this.isModified("password")) {
        const document = this;
        bcrypt.hash(this.password, saltRounds, function (err, hashedPassword) {
            if (err) {
                next(err);
            } else {
                document.password = hashedPassword;
                next();
            }
        });
    } else {
        next();
    }
});

UserSchema.pre("findOneAndUpdate", async function (next) {
    const update = this.getUpdate();
    const password = update.$set && update.$set.password;
    if (password) {
        try {
            const hashedPassword = await bcrypt.hash(password, saltRounds);
            this.getUpdate().$set.password = hashedPassword;
            next();
        } catch (error) {
            return next(error);
        }
    } else {
        next();
    }
});

module.exports = Mongoose.model("users", UserSchema);
