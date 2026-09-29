const Discount = {};
const shopify = require("./../shopify");

Discount.createPriceRule = async (session) => {
    try {
        let price_rule = await shopify.api.rest.PriceRule.all({ session });
        if(!price_rule.data || !price_rule.data.length) return null;
        let swipeRule = price_rule.data.find(rule => rule.title == '100OFFSWIPEREORDER');
        if(swipeRule) return swipeRule;
        const create_price_rule = new shopify.api.rest.PriceRule({ session });
        create_price_rule.title = "100OFFSWIPEREORDER";
        create_price_rule.target_type = "line_item";
        create_price_rule.target_selection = "all";
        create_price_rule.allocation_method = "across";
        create_price_rule.value_type = "percentage";
        create_price_rule.value = "-100.0";
        create_price_rule.customer_selection = "all";
        create_price_rule.starts_at = new Date();
        await create_price_rule.save({
            update: true,
        });
        return create_price_rule;
    } catch (error) {
        throwError(error);
    }
}

Discount.createDiscount = async (session) => {
    try {
        const price_rule = await Discount.createPriceRule(session);
        const discount_code = new shopify.api.rest.DiscountCode({ session });
        discount_code.price_rule_id = price_rule.id;
        discount_code.code = "100OFFSWIPEREORDER";
        await discount_code.save({
            update: true,
        });
        return { data: discount_code };
    } catch (error) {
        throwError(error);
    }
}

module.exports = Discount
