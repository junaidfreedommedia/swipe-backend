require('dotenv').config({ path: '.env' });
const mongoose = require('mongoose');
const Config = require('./config/config');
const Models = require('./models'); // this connects to DB
const Order = Models.Order;
const Merchant = Models.Merchant;

setTimeout(async () => {
    try {
        const order = await Order.findOne({ id: 6466056781926 }).populate('merchant');
        if (order) {
            console.log("FOUND ORDER:", order.id, "Merchant _id:", order.merchant ? order.merchant._id : 'null', "Shop:", order.merchant ? order.merchant.shop_id : 'null');
        } else {
            console.log("ORDER NOT FOUND IN DB");
        }

        const orders = await Order.find({ id: 6466056781926 });
        console.log("All orders with this ID count:", orders.length);
        console.log("Order exact details:", JSON.stringify(orders.map(o => ({ id: o.id, merchant_id: o.merchant })), null, 2))
    } catch (e) {
        console.log("Error", e);
    }
    process.exit(0);
}, 2000);
