const WebhookSchema = Models.WebhookError;
const WebhookError = {};

WebhookError.insert = async (data) => {
    return new WebhookSchema(data).save();
};

/**
 * Handle webhook error - saves the error to database and sends email notification
 * Use this method instead of insert() to ensure errors are properly logged and notified
 * @param {Object} data - The webhook error data
 * @param {string} [data.shop_domain] - The shop domain where the error occurred
 * @param {string} data.webhook_name - The name of the webhook
 * @param {Object|string} data.webhook_error - The error object or message
 * @param {Object} [data.webhook_payload] - The webhook payload
 * @returns {Promise<Object>} The saved error record
 */
WebhookError.handle = async (data) => {
    try {
        // First save the error record
        const errorRecord = await WebhookError.insert(data);
        
        // Extract error details for notification
        let errorMessage = '';
        let errorReason = '';
        console.log("data.webhook_error", data.webhook_error);
        if (typeof data.webhook_error === 'object') {
            // Extract message and stack from error object
            console.log("data.webhook_error", data.webhook_error);
            if (data.webhook_error) {
                errorMessage = JSON.stringify(data.webhook_error, null, 2);
                // Try to extract the specific error message
                errorReason = data.webhook_error.message || 
                             data.webhook_error.error || 
                             data.webhook_error.description || 
                             'No specific reason available';
            }
        } else {
            errorMessage = data.webhook_error || 'No error details available';
            
            // Try to parse JSON string errors
            try {
                // First check if it's an Error object stringified with message visible at the start
                const errorMatch = errorMessage.match(/^Error: (.+?)(?:\n|$)/);
                if (errorMatch && errorMatch[1]) {
                    errorReason = errorMatch[1];
                } else {
                    // Try to parse as JSON
                    try {
                        const parsedError = JSON.parse(errorMessage);
                        errorReason = parsedError.message || 
                                     parsedError.error || 
                                     parsedError.description || 
                                     'Could not determine specific reason';
                    } catch (e) {
                        // If it's not JSON, use the first 100 chars as the reason
                        errorReason = errorMessage.substring(0, 100) + 
                                     (errorMessage.length > 100 ? '...' : '');
                    }
                }
            } catch (e) {
                // If it's not JSON, use the first 100 chars as the reason
                errorReason = errorMessage.substring(0, 100) + 
                             (errorMessage.length > 100 ? '...' : '');
            }
        }
        
        // Then send email notification about the webhook error
        await Notifications.sendNotification({
            subject: `Webhook Error: ${data.webhook_name || 'Unknown Webhook'}`,
            to: ["junaid@freedommedia.com"],
            template: "WEBHOOK_ERROR",
            webhook_name: data.webhook_name || 'Unknown Webhook',
            shop_domain: data.shop_domain || 'Not specified',
            error_message: errorMessage,
            error_reason: errorReason,
            timestamp: new Date().toLocaleString()
        }).catch(err => {
            // Log the error but don't fail the original operation
            console.error("Failed to send webhook error notification:", err);
        });
        
        return errorRecord;
    } catch (error) {
        console.error("Error handling webhook error:", error);
        // Still ensure the error is saved even if notification fails
        return WebhookError.insert(data);
    }
};

WebhookError.get = async (condition, projection, options = { lean: true }) => {
    return WebhookSchema.findOne(condition, projection, options);
};

WebhookError.count = async (condition) => {
    return WebhookSchema.countDocuments(condition);
};

WebhookError.getAll = async (condition, projection, options = { lean: true }) => {
    return WebhookSchema.find(condition, projection, options);
};

WebhookError.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse)
        return WebhookSchema.aggregate(pipeline).allowDiskUse(true);
    return WebhookSchema.aggregate(pipeline);
};

WebhookError.updateOne = async (condition, info) => {
    return WebhookSchema.updateOne(condition, info);
};

WebhookError.findOneAndUpdate = async (condition, info, options) => {
    return WebhookSchema.findOneAndUpdate(condition, info, options);
};

module.exports = WebhookError;
