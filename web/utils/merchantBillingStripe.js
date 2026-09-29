// Dedicated client: do not change the API version or behavior of existing Stripe flows.
let client;
module.exports = () => {
    if (!client) {
        const key = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API || global.Config?.get('APP')?.STRIPE_API;
        if (!key) throw Object.assign(new Error('Stripe is not configured on the server.'), { status: 503 });
        client = require('stripe')(key, { apiVersion: '2022-11-15', timeout: 20000, maxNetworkRetries: 1 });
    }
    return client;
};
