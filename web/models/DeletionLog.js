const mongoose = require('mongoose');
const { Schema } = mongoose;

const DeletionLogSchema = new Schema({
    collection: {
        type: String, // e.g., 'users', 'orders', etc.
        required: true
    },
    deleted_data: {
        type: Schema.Types.Mixed, 
        required: true
    },
    deleted_by: {
        type: Schema.Types.ObjectId,
        ref: 'users',
        required: true
    },
    deleted_at: {
        type: Date,
        default: Date.now
    },
    reason: {
        type: String,
        default: ''
    }
});

module.exports = mongoose.model('deletion_logs', DeletionLogSchema);
