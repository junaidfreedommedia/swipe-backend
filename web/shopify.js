
const Config = require("./config/config");
const dotenv = require("dotenv");
const path   = require("path");
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { shopifyApp }= require("@shopify/shopify-app-express");
const {  LATEST_API_VERSION } = require("@shopify/shopify-api");
const { restResources } = require(
  `@shopify/shopify-api/rest/admin/${LATEST_API_VERSION}`
);
const { MongoDBSessionStorage }= require("@shopify/shopify-app-session-storage-mongodb");

console.log("NODE_ENV:", process.env.NODE_ENV);

let api = {
  apiVersion:    LATEST_API_VERSION,
  restResources,
  billing:       Config.get("BILLING_CONFIG"),
  isEmbeddedApp: false,
  forceRedirect: false,
};
console.log("→ Shopify REST API version:", LATEST_API_VERSION);
console.log("→ Shopify REST API restResources :", restResources);
console.log("Api",api);


const env = process.env.NODE_ENV || "staging";
if (["production", "staging", "develop"].includes(env)) {
  const configuredScopes = JSON.parse(process.env.SCOPE || "[]");
  const requiredReturnScopes = [
    "read_returns",
    "write_returns",
    "read_locations",
    "write_gift_cards",
    "write_customers",
  ];
  Object.assign(api, {
    apiKey:       process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_CLIENT_SECRET,
    scopes:       [...new Set([...configuredScopes, ...requiredReturnScopes])],
    hostScheme:   process.env.HOST_SCHEME,
    hostName:     process.env.HOST,
  });
}

const shopify = shopifyApp({
  api,
  auth: {
    path:         "/api/auth",
    callbackPath: "/api/auth/callback",
  },
  webhooks: {
    path: "/api/webhooks",
  },
  sessionStorage: new MongoDBSessionStorage(
    Config.get("DB").URL,
    Config.get("DB").NAME
  ),
});

module.exports = shopify;
