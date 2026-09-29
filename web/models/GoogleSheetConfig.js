const Schema = Mongoose.Schema;

const GoogleSheetConfigSchema = Schema(
    {
        key: {
            type: String,
            default: "primary",
            unique: true,
            trim: true,
        },
        client_id: {
            type: String,
            trim: true,
        },
        client_secret: {
            type: String,
            select: false,
        },
        refresh_token: {
            type: String,
            select: false,
        },
        connected_email: String,
        connected_at: Date,
        oauth_state: {
            type: String,
            select: false,
        },
        oauth_state_expires_at: Date,
        oauth_redirect_uri: String,
        oauth_return_url: String,
        updated_by: {
            type: Schema.Types.ObjectId,
            ref: "users",
        },
    },
    {
        timestamps: true,
        id: false,
    }
);

module.exports = Mongoose.model(
    "google_sheet_configs",
    GoogleSheetConfigSchema
);
