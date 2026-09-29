const express = require("express");
const router = express.Router();

/**
 * Get list of webhook payloads with pagination and filtering
 */
const listWebhookPayloads = async (req, res, next) => {
    try {
        const { topic, limit = 20, page = 1, sort = -1 } = req.query;
        
        // Build query conditions
        let condition = {};
        if (topic) {
            condition.topic = topic;
        }
        
        // Calculate pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);
        
        // Get total count for pagination
        const totalCount = await Services.WebhookPayload.count(condition);
        
        // Get webhook payloads
        const webhooks = await Services.WebhookPayload.getAll(
            condition,
            null,
            { 
                sort: { createdAt: parseInt(sort) },
                skip,
                limit: parseInt(limit)
            }
        );
        
        return res.send({
            message: webhooks.length > 0 ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: {
                totalRecords: totalCount,
                response: webhooks
            }
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * Get a single webhook payload by ID
 */
const getWebhookPayload = async (req, res, next) => {
    try {
        const { id } = req.params;
        
        const webhook = await Services.WebhookPayload.get({ _id: id });
        
        if (!webhook) {
            return res.status(404).send({
                message: MSG.DATA_NOT_FOUND
            });
        }
        
        return res.send({
            message: MSG.DATA_FOUND,
            data: webhook
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * Get list of unique webhook topics
 */
const getWebhookTopics = async (req, res, next) => {
    try {
        const topics = await Services.WebhookPayload.aggregate([
            { $group: { _id: "$topic" } },
            { $sort: { _id: 1 } }
        ]);
        
        return res.send({
            message: topics.length > 0 ? MSG.DATA_FOUND : MSG.DATA_NOT_FOUND,
            data: topics.map(t => t._id)
        });
    } catch (error) {
        return next(error);
    }
};

// Register routes
router.get("/payloads", Auth.check, listWebhookPayloads);
router.get("/payloads/:id", Auth.check, getWebhookPayload);
router.get("/topics", Auth.check, getWebhookTopics);

module.exports = router;