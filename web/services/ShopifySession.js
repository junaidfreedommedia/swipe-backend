const ShopifySessionSchema = Models.ShopifySession;
const ShopifySession = {};

ShopifySession.get = async (conditions) => {
    return ShopifySessionSchema.findOne(conditions);
}

module.exports = ShopifySession;
