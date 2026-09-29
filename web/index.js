const express = require("express");
global.Fs = require('fs-extra');
global._ = require('lodash');
global.Path = require('path');
global.Logger = require('./utils/logger');
const Config = require("./config/config");
require('./config/config');


require('./utils/global');
require('./utils/constants');
global.MSG = require('./locals/en/messages');
global.Email = require('./utils/email');
global.Notifications = require('./utils/notification')
global.Func = require('./utils/functions');
global.IS_APP_PROCESS = true;
global.Models = require('./models');
global.Services = require('./load-services');
global.AdminRules = require('./validation/admin_rules');
global.Auth = require('./middleware/auth');
global.MerchantRules = require('./validation/merchant_rules');
global.V1Rules = require('./validation/v1_rules');
global.StripeAPI = require('./utils/stripe');
global.FastCsv = require("fast-csv");
global.S3 = require('./utils/s3upload');
const shopify = require("./shopify.js");
const fileUpload = require("express-fileupload");
const { installApp, appStatus } = require("./app-install.js");
const GDPRWebhookHandlers = require("./gdpr.js");
const cors = require('cors');
const createError = require('http-errors');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger.json');


const PORT = parseInt(process.env.BACKEND_PORT);
const app = express();
const webhooks = require("./controllers/v1/webhooks");
const validateShopifySession = shopify.validateAuthenticatedSession();

function getShopFromRequest(req) {
    return (
        req.query?.shop ||
        req.headers["x-shopify-shop-domain"] ||
        req.headers["shop"]
    );
}

function ensureShopifyContext({ onMissingShop }) {
    return function (req, res, next) {
        const shop = getShopFromRequest(req);
        const authHeader = req.headers.authorization || "";
        const hasBearerToken = /^Bearer\s+/i.test(authHeader);

        if (shop || hasBearerToken) {
            return validateShopifySession(req, res, next);
        }

        console.warn(
            `[shopify-app/WARN] Skipping auth middleware for path=${req.originalUrl} reason=missing-shop`
        );
        return onMissingShop(req, res, next);
    };
}

app.set('view engine', 'ejs');
app.set('views', Path.join(__dirname, 'lib/view'));
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
    shopify.config.auth.callbackPath,
    shopify.auth.callback(),
    async function (_req, res, _next) {
        let url = Config.get('APP').REDIRECT_URL;
       try {
    const appInfo = await appStatus(res.locals.shopify.session);

   if (!appInfo.installed || !appInfo.registered) {

        const installedApp = await installApp(res.locals.shopify.session);
        const redirectUrl = `${Config.get('APP').REDIRECT_URL.replace(/\/?$/, "/")}register?token=${installedApp.token}`;
        return res.redirect(301, redirectUrl);
    }

    return res.redirect(301, Config.get('APP').REDIRECT_URL);

} catch (error) {
    console.log('APP ROOT ERROR CALLBACK', error);
    return res.redirect('https://dashboard.swipe.ai/?redirect=install');
}

    }
);
app.post(
    shopify.config.webhooks.path,
    shopify.processWebhooks({ webhookHandlers: GDPRWebhookHandlers })
);

app.use('/v1/webhooks', webhooks);

app.use(express.json({ limit: '2mb' }));
app.use(fileUpload());
app.use(cors({ exposedHeaders: ['x-access-token'], origin: true }));
app.use("/public", require("./controllers/v1/public"));
app.use(
    "/api/*",
    ensureShopifyContext({
        onMissingShop: (_req, res) =>
            res.status(401).send({ message: "Missing Shopify context." }),
    })
);
require('./load-controllers')(app)
app.use('/v1/swagger.json', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use("/v1/orders", require("./controllers/v1/orders"));
app.use("/*",
    ensureShopifyContext({
        onMissingShop: (_req, res) =>
            res.redirect(302, Config.get('APP').REDIRECT_URL),
    }),
    async function (_req, res, _next) {
        return res.redirect(301, Config.get('APP').REDIRECT_URL);
    }
);




app.use(function(_req, _res, next) {
    next(createError(404));
});

app.use(function (err, req, res, _next) {
    console.log(err);
    res.status(err.status || 500);
    res.send({ message: getErrorMessage(err) });
});
app.listen(PORT, () => {
    Logger.info(`Server started and running on port ${PORT}`);
    console.log(`Example app listening on port ${PORT}`);
});
