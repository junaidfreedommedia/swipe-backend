const WebhookPayloadSchema = Models.WebhookPayload;
const WebhookPayload = {};

WebhookPayload.insert = async (data) => {
    return new WebhookPayloadSchema(data).save();
};

WebhookPayload.get = async (condition, projection, options = { lean: true }) => {
    return WebhookPayloadSchema.findOne(condition, projection, options);
};

WebhookPayload.getAll = async (condition, projection, options = { lean: true }) => {
    return WebhookPayloadSchema.find(condition, projection, options);
};

WebhookPayload.count = async (condition) => {
    return WebhookPayloadSchema.countDocuments(condition);
};

module.exports = WebhookPayload; 