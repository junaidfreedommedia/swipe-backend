require('dotenv').config({ path: '.env' });
const mongoose = require('mongoose');
const Config = require('./config/config');
const Models = require('./models');
const Order = Models.Order;
const Merchant = Models.Merchant;

setTimeout(async () => {
    try {
        const shop = 'lola-and-the-boys-2.myshopify.com';
        const merchant = await Merchant.findOne({ shop_id: shop }).lean();
        console.log("merchant details", merchant._id, typeof merchant._id);

        const orderId1 = 6466056781926;
        let existingOrder1 = await Order.findOne({
            id: orderId1,
            merchant: merchant._id,
        }).lean();

        console.log("Found order directly?", existingOrder1 ? "YES" : "NO");

    } catch (e) {
        console.log("Error", e);
    }
    process.exit(0);
}, 2000);
