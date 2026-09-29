let Config = require("config");
const dotenv = require("dotenv");
const path = require("path");

const filePath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: filePath });

const ENV = process.env;

/* ---------------- DATABASE ---------------- */
Config.DB = Config.DB || {};
Config.DB.URL = ENV.DATABASE_URL;
Config.DB.NAME = ENV.DATABASE_NAME;

/* ---------------- AWS ---------------- */
Config.AWS_CREDENTIALS = Config.AWS_CREDENTIALS || {};
Config.AWS_CREDENTIALS.AWS_ACCESS_KEY = ENV.AWS_ACCESS_KEY_ID;
Config.AWS_CREDENTIALS.AWS_SECRET_KEY = ENV.AWS_SECRET_ACCESS_KEY;
Config.AWS_CREDENTIALS.AWS_REGION = ENV.AWS_REGION;

/* ---------------- APP ---------------- */
Config.APP = Config.APP || {};
Config.APP.SHOPIFY_API_KEY = ENV.SHOPIFY_API_KEY;
Config.APP.SHOPIFY_CLIENT_SECRET = ENV.SHOPIFY_CLIENT_SECRET;
Config.APP.REDIRECT_URL = ENV.REDIRECT_URL;
Config.APP.HOST_SCHEME = ENV.HOST_SCHEME;
Config.APP.HOST = ENV.HOST;
Config.APP.SCOPE = ENV.SCOPE ? JSON.parse(ENV.SCOPE) : [];
Config.APP.SHOPIFY_APP_URL = ENV.SHOPIFY_APP_URL;
Config.APP.FE_HOST = ENV.FE_HOST;
Config.APP.BE_HOST = ENV.BE_HOST;
Config.APP.BACKEND_PORT = ENV.BACKEND_PORT;

/* ---------------- WEBHOOK ---------------- */
Config.WEBHOOK = Config.WEBHOOK || {};
Config.WEBHOOK.URL = ENV.WEBHOOK_URL;

/* ---------------- GLOBAL ---------------- */
global.Config = Config;
module.exports = Config;
