const crypto = require("crypto");
const express = require("express");
const { google } = require("googleapis");

const router = express.Router();
const CONFIG_KEY = "primary";
const OAUTH_SCOPES = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/spreadsheets",
];

const ensureAdmin = (req, _res, next) => {
    if (
        req.user?.role !== USER_ROLE.ADMIN ||
        req.user?.admin_type === "simple_admin" ||
        req.auth?.isImpersonating
    ) {
        return next(setError(MSG.NOT_RBS_PERMISSION, 403));
    }
    return next();
};

const getConfigModel = () => Models.GoogleSheetConfig;

const getRequestOrigin = (req) => {
    const forwardedProto = req.headers["x-forwarded-proto"]
        ?.split(",")[0]
        ?.trim();
    const protocol = forwardedProto || req.protocol;
    return `${protocol}://${req.get("host")}`;
};

const getCallbackUrl = (req) =>
    `${getRequestOrigin(req)}/admin/googleSheet/oauth/callback`;

const getSafeReturnUrl = (req) => {
    const requestedUrl = String(req.body?.return_url || "").trim();
    const origin = String(req.headers.origin || "").trim();
    if (/^https?:\/\//i.test(requestedUrl) && /^https?:\/\//i.test(origin)) {
        try {
            if (new URL(requestedUrl).origin === new URL(origin).origin) {
                return requestedUrl;
            }
        } catch (_error) {
            // Fall through to the known frontend origin.
        }
    }

    if (/^https?:\/\//i.test(origin)) return `${origin}/dashboard/store`;

    return null;
};

const appendResultToUrl = (url, result, message) => {
    if (!url) return null;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}googleSheet=${encodeURIComponent(
        result
    )}&message=${encodeURIComponent(message)}`;
};

const getConfig = async (req, res, next) => {
    try {
        const config = await getConfigModel()
            .findOne({ key: CONFIG_KEY })
            .select("+client_secret +refresh_token")
            .lean();

        return res.send({
            message: MSG.DATA_FOUND,
            data: {
                client_id: config?.client_id || "",
                has_client_secret: Boolean(config?.client_secret),
                has_refresh_token: Boolean(config?.refresh_token),
                connected: Boolean(config?.refresh_token),
                connected_email: config?.connected_email || "",
                connected_at: config?.connected_at || null,
                callback_url: getCallbackUrl(req),
            },
        });
    } catch (error) {
        return next(error);
    }
};

const saveConfig = async (req, res, next) => {
    try {
        const clientId = String(req.body?.client_id || "").trim();
        const clientSecret = String(req.body?.client_secret || "").trim();
        const refreshToken = String(req.body?.refresh_token || "").trim();
        const existing = await getConfigModel()
            .findOne({ key: CONFIG_KEY })
            .select("+client_secret +refresh_token");

        if (!clientId && !existing?.client_id) {
            return next(setError("Google OAuth Client ID is required.", 400));
        }
        if (!clientSecret && !existing?.client_secret) {
            return next(setError("Google OAuth Client Secret is required.", 400));
        }

        const update = {
            client_id: clientId || existing.client_id,
            updated_by: req.user?._id,
        };
        if (clientSecret) update.client_secret = clientSecret;
        if (refreshToken) {
            update.refresh_token = refreshToken;
            update.connected_at = new Date();
        }

        await getConfigModel().findOneAndUpdate(
            { key: CONFIG_KEY },
            { $set: update, $setOnInsert: { key: CONFIG_KEY } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        global.Services?.GoogleSheet?.resetOAuthClient?.();

        return res.send({
            message: "Google Sheet settings saved successfully.",
            data: {
                client_id: update.client_id,
                has_client_secret: true,
                has_refresh_token: Boolean(refreshToken || existing?.refresh_token),
                connected: Boolean(refreshToken || existing?.refresh_token),
                callback_url: getCallbackUrl(req),
            },
        });
    } catch (error) {
        return next(error);
    }
};

const startOAuth = async (req, res, next) => {
    try {
        const config = await getConfigModel()
            .findOne({ key: CONFIG_KEY })
            .select("+client_secret +refresh_token");

        if (!config?.client_id || !config?.client_secret) {
            return next(
                setError("Save Google Client ID and Client Secret first.", 400)
            );
        }

        const redirectUri = getCallbackUrl(req);
        const state = crypto.randomBytes(32).toString("hex");
        const returnUrl = getSafeReturnUrl(req);
        const oauth = new google.auth.OAuth2(
            config.client_id,
            config.client_secret,
            redirectUri
        );

        config.oauth_state = state;
        config.oauth_state_expires_at = new Date(Date.now() + 10 * 60 * 1000);
        config.oauth_redirect_uri = redirectUri;
        config.oauth_return_url = returnUrl;
        await config.save();

        return res.send({
            message: "Google authorization URL created.",
            data: {
                auth_url: oauth.generateAuthUrl({
                    access_type: "offline",
                    prompt: "consent",
                    include_granted_scopes: true,
                    scope: OAUTH_SCOPES,
                    state,
                }),
                callback_url: redirectUri,
            },
        });
    } catch (error) {
        return next(error);
    }
};

const oauthCallback = async (req, res) => {
    let returnUrl = null;

    try {
        const state = String(req.query?.state || "");
        const code = String(req.query?.code || "");
        const config = await getConfigModel()
            .findOne({ key: CONFIG_KEY })
            .select("+client_secret +refresh_token +oauth_state");

        returnUrl = config?.oauth_return_url || null;
        if (
            !config ||
            !state ||
            !code ||
            state !== config.oauth_state ||
            !config.oauth_state_expires_at ||
            config.oauth_state_expires_at.getTime() < Date.now()
        ) {
            throw new Error("Google authorization request is invalid or expired.");
        }

        const oauth = new google.auth.OAuth2(
            config.client_id,
            config.client_secret,
            config.oauth_redirect_uri
        );
        const { tokens } = await oauth.getToken(code);
        oauth.setCredentials(tokens);

        let connectedEmail = config.connected_email || "";
        try {
            const userInfo = await google
                .oauth2({ version: "v2", auth: oauth })
                .userinfo.get();
            connectedEmail = userInfo.data?.email || connectedEmail;
        } catch (_error) {
            // The refresh token is still valid even if email lookup fails.
        }

        config.refresh_token = tokens.refresh_token || config.refresh_token;
        if (!config.refresh_token) {
            throw new Error(
                "Google did not return a refresh token. Reconnect and approve access again."
            );
        }
        config.connected_email = connectedEmail;
        config.connected_at = new Date();
        config.oauth_state = undefined;
        config.oauth_state_expires_at = undefined;
        await config.save();

        global.Services?.GoogleSheet?.resetOAuthClient?.();

        const successUrl = appendResultToUrl(
            returnUrl,
            "connected",
            "Google Account connected successfully."
        );
        if (successUrl) return res.redirect(302, successUrl);

        return res.send("Google Account connected successfully. You may close this page.");
    } catch (error) {
        const message = error?.message || "Unable to connect Google Account.";
        const errorUrl = appendResultToUrl(returnUrl, "error", message);
        if (errorUrl) return res.redirect(302, errorUrl);
        return res.status(400).send(message);
    }
};

const deleteMerchantSheet = async (req, res, next) => {
    try {
        const merchantId = String(req.params?.merchantId || "");
        if (!IsValidObjectId(merchantId)) {
            return next(setError(MSG.INVALID_MERCHANT_ID, 400));
        }

        const result = await Services.GoogleSheet.deleteMerchantSpreadsheet(
            merchantId
        );

        return res.send({
            message: result.hadSpreadsheet
                ? "Merchant Google Sheet moved to Trash successfully."
                : "Merchant Google Sheet settings cleared successfully.",
            data: result,
        });
    } catch (error) {
        return next(error);
    }
};

router.get("/config", Auth.check, ensureAdmin, getConfig);
router.put("/config", Auth.check, ensureAdmin, saveConfig);
router.post("/connect", Auth.check, ensureAdmin, startOAuth);
router.delete(
    "/merchant/:merchantId",
    Auth.check,
    ensureAdmin,
    deleteMerchantSheet
);
router.get("/oauth/callback", oauthCallback);

module.exports = router;
