const Stripe = require("stripe");

let stripe;
let activeKey;

const getSecretKey = () =>
  String(process.env.STRIPE_SECRET_KEY || Config.get("APP").STRIPE_API || "").trim();

const getClient = () => {
  const secretKey = getSecretKey();
  if (!secretKey) {
    const error = new Error(
      "Stripe is not configured. Add STRIPE_SECRET_KEY to the backend environment."
    );
    error.status = 503;
    throw error;
  }
  if (
    String(process.env.RETURN_TEST_MODE || "").toLowerCase() === "true" &&
    !secretKey.startsWith("sk_test_")
  ) {
    const error = new Error(
      "Stripe test mode requires an sk_test_ secret key. Live charges are blocked."
    );
    error.status = 503;
    throw error;
  }
  if (!stripe || activeKey !== secretKey) {
    stripe = Stripe(secretKey);
    activeKey = secretKey;
  }
  return stripe;
};

module.exports = {
    isConfigured: () => Boolean(getSecretKey()),
    checkoutSessionCreate: async (info, options) => {
        return getClient().checkout.sessions.create(info, options);
    },
    checkoutSessionRetrieve: async (id) => {
        return getClient().checkout.sessions.retrieve(id);
    },
    constructWebhookEvent: (payload, signature, secret) => {
        return getClient().webhooks.constructEvent(payload, signature, secret);
    },
    productCreate: async (info) => {
        return getClient().products.create(info);
    },
    productUpdate: async (productId, info) => {
        return getClient().products.update(productId, info);
    },
    productSearch: async (query) => {
        return getClient().products.search({query});
    },
    priceCreate: async (info) => {
        return getClient().prices.create(info);
    },
    paymentLinkCreate: async (info) => {
        return getClient().paymentLinks.create(info);
    },
    paymentLinkUpdate: async (payment_link_id, info) => {
        return getClient().paymentLinks.update(payment_link_id, info);
    },
    customerCreate: async (info) => {
        return getClient().customers.create(info);
    },
    createSource: async (Id, info) => {
        return getClient().customers.createSource(Id, info);
    },
    customerUpdate: async (Id, info) => {
        return getClient().customers.update(Id, info);
    },
    paymentMethodAttach:async (payment_method, Id) =>{
        return getClient().paymentMethods.attach(payment_method, Id);
    },
    paymentMethodRetrieve:async (id) => {
        return getClient().paymentMethods.retrieve(id);
    },
    paymentMethodsList :async (customer_id) =>{
        return getClient().paymentMethods.list(customer_id);
    },
    customerFind: async (email) =>{
        try{
            const customer = await getClient().customers.search({
                query: `email:\'${email}\'`,
            });
            return customer?.data[0];
        }catch(error){
            console.log(error);
            throw error;
        }
    }
};
