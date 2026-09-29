const calendlyModels = Models.Calendly;
const Calendly = {};
const axiosService = require("./../utils/axios");

Calendly.insert = async (data) => {
    return new calendlyModels(data).save();
};

Calendly.get = async (condition, projection, options) => {
    return calendlyModels.findOne(condition, projection, options);
};

Calendly.getAll = async (condition, projection, options = { lean: true }) => {
    return calendlyModels.find(condition, projection, options);
};

Calendly.findOneAndUpdate = async (condition, info, options) => {
    return calendlyModels.findOneAndUpdate(condition, info, options);
};

Calendly.getToken = async () => {
    try {
        const tokenData = await Services.Calendly.get();

        const expiryTime =
            tokenData.created_at * 1000 + tokenData.expires_in * 1000;

        const currentTime = Date.now();

        const isExpired = currentTime >= expiryTime;
        let refreshToken;
        if (isExpired) {
            refreshToken = await refreshAccessToken(tokenData.refresh_token);
        } else {
            return null;
        }
    } catch (error) {
        throwError(error);
    }
};

async function refreshAccessToken(refreshToken) {
    try {
        const tokenUrl = "https://auth.calendly.com/oauth/token";

        const data = {
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: process.env.CALENDLY_CLIENT_ID,
            client_secret: process.env.CALENDLY_CLIENT_SECRETE,
        };

        const config = {
            headers: {
                "Content-Type": "application/json",
            },
        };
        const response = await axiosService.post(tokenUrl, data, config);
        if (response) {
            await Services.Calendly.findOneAndUpdate(
                { refresh_token: refreshToken },
                {
                    token: response.data.access_token,
                    refresh_token: response.data.refresh_token,
                    created_at: response.data.created_at,
                    expires_in: response.data.expires_in,
                }
            );
        }
        return response.data;
    } catch (error) {
        throwError(error);
    }
}

module.exports = Calendly;
