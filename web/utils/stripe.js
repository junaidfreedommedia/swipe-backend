const Stripe = require('stripe');
const stripe = Stripe(Config.get('APP').STRIPE_API);

module.exports = {
    productCreate: async (info) => {
        return stripe.products.create(info);
    },
    productUpdate: async (productId, info) => {
        return stripe.products.update(productId, info);
    },
    productSearch: async (query) => {
        return stripe.products.search({query});
    },
    priceCreate: async (info) => {
        return stripe.prices.create(info);
    },
    paymentLinkCreate: async (info) => {
        return stripe.paymentLinks.create(info);
    },
    paymentLinkUpdate: async (payment_link_id, info) => {
        return stripe.paymentLinks.update(payment_link_id, info);
    },
    customerCreate: async (info) => {
        return stripe.customers.create(info);
    },
    createSource: async (Id, info) => {
        return stripe.customers.createSource(Id, info);
    },
    customerUpdate: async (Id, info) => {
        return stripe.customers.update(Id, info);
    },
    paymentMethodAttach:async (payment_method, Id) =>{
        return stripe.paymentMethods.attach(payment_method, Id);
    },
    paymentMethodRetrieve:async (id) => {
        return stripe.paymentMethods.retrieve(id);
    },
    paymentMethodsList :async (customer_id) =>{
        return stripe.paymentMethods.list(customer_id);
    },
    customerFind: async (email) =>{
        try{
            const customer = await stripe.customers.search({
                query: `email:\'${email}\'`,
            });
            return customer?.data[0];
        }catch(error){
            console.log(error);
            throw error;
        }
    }
};