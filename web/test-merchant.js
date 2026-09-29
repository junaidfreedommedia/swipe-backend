require('dotenv').config({ path: '.env' });
const mongoose = require('mongoose');
const Config = require('./config/config');
const Models = require('./models'); // this connects to DB
const Merchant = Models.Merchant;

setTimeout(async () => {
    try {
        const merchants = await Merchant.find({ shop_id: 'lola-and-the-boys-2.myshopify.com' });
        console.log(`Found ${merchants.length} merchants for shop lola-and-the-boys-2`);
        for (const m of merchants) {
            console.log(`- _id: ${m._id}, is_active: ${m.is_active}`)
        }
    } catch (e) {
        console.log("Error", e);
    }
    process.exit(0);
}, 2000);
