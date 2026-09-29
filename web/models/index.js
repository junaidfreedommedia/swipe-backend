const Mongoose = require("mongoose");
global.Mongoose = require('mongoose');
global.ObjectId = (id) => new Mongoose.Types.ObjectId(id);
global.IsValidObjectId = Mongoose.Types.ObjectId.isValid;
const config = require('config');
const util = require('util');
const { URL, NAME } = config.get('DB');
const Fs = require('fs');
const Path = require('path');

// =================================================
// ✅ FIX: Connection Options for Slow Internet & DNS Issues
// =================================================
const connectionOptions = {
    serverSelectionTimeoutMS: 60000, // 60 Seconds wait karega connect hone ka
    socketTimeoutMS: 60000,          // Data transfer timeout
    family: 4,                       // IMPORTANT: Fixes 'queryTxt ETIMEOUT' (Forces IPv4)
};

// Connecting to the database
Mongoose.connect(`${URL}/${NAME}`, connectionOptions)
    .then(() => {
        console.log("✅ Successfully connected to the database");
    })
    .catch(err => {
        console.log('❌ Could not connect to the database.', err);
        process.exit();
    });

// Debugging Logic
Mongoose.set('debug', (collectionName, methodName, ...methodArgs) => {
    const msgMapper = (m) => {
        return util.inspect(m, false, 10, true)
            .replace(/\n/g, '').replace(/\s{2,}/g, ' ');
    };
    if(collectionName !== 'cron_jobs') {
        console.log(`\x1B[0;36mMongoose:\x1B[0m Swipe - ${collectionName}.${methodName}` + `(${methodArgs.map(msgMapper).join(', ')})`);
    }
});

// Load all models dynamically
let db = {};
Fs.readdirSync(__dirname)
    .filter(function(file) {
        return file.indexOf('.') !== 0 && file !== 'index.js';
    })
    .forEach(function(file) {
        var filename = file.split('.')[0];
        var model = require(Path.join(__dirname, file));
        db[filename] = model;
});

module.exports = db;