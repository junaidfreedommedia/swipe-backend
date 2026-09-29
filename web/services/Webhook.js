
const shopify = require('./../shopify');
const Webhook = {};

Webhook.registerWebhooks = async function (session) {
    try {
        const { TOPIC, URL: WebhookHttpEndpoint, format } = Config.get('WEBHOOK');
        const allWebhooks = await shopify.api.rest.Webhook.all({ session: session });
        const existingByTopicName = {};
        for (let webhook of allWebhooks.data) {
            const existsORrNot = Object.keys(TOPIC).find(key => TOPIC[key] === webhook.topic);
            if (existsORrNot) existingByTopicName[existsORrNot] = webhook;
        }
        const prepareWebhooksPayload = ({ info, topicName, topic }) => {
            const url = `${WebhookHttpEndpoint}${topicName}`;
            info.address = url;
            info.topic = topic;
            info.format = format;
            return info;
        }
        const newWebhookObj = () => new shopify.api.rest.Webhook({ session });

        const missingTopics = [];
        const repairedTopics = [];

        for (let topicName in TOPIC) {
            const existingWebhook = existingByTopicName[topicName];
            const expectedAddress = `${WebhookHttpEndpoint}${topicName}`;

            // Self-heal only when missing or misconfigured.
            if (!existingWebhook) {
                let webhookObj = prepareWebhooksPayload({ info: newWebhookObj(), topicName, topic: TOPIC[topicName] });
                await webhookObj.save({ update: true });
                missingTopics.push(topicName);
                continue;
            }

            const existingAddress = (existingWebhook.address || '').trim();
            if (existingAddress !== expectedAddress) {
                let webhookObj = prepareWebhooksPayload({ info: newWebhookObj(), topicName, topic: TOPIC[topicName] });
                webhookObj.id = existingWebhook.id;
                await webhookObj.save({ update: true });
                repairedTopics.push(topicName);
            }
        }

        return Promise.resolve({
            totalRequiredTopics: Object.keys(TOPIC).length,
            missingRegistered: missingTopics,
            repairedAddress: repairedTopics,
            alreadyHealthyCount: Object.keys(TOPIC).length - missingTopics.length - repairedTopics.length,
        });
    } catch (error) {
        console.log(error);
         await Services.WebhookError.handle({
            webhook_error: error instanceof Error 
                ? error.message 
                : JSON.stringify(error),
            webhook_name: "RegisterWebhooksError",
            shop_domain: session?.shop || "Unknown Shop"
        });
        Logger.error(error.stack);
    }
}

Webhook.registerWebhooksForCron = async function (shop) {
    try {
        const session = await Services.ShopifySession.get({ shop });
        if (!session) {
            return {
                message: MSG.DATA_NOT_FOUND,
                skipped: true,
            };
        }

        const summary = await Webhook.registerWebhooks(session);
        return {
            message: MSG.WEBHOOK_REGISTER_SUCCESS,
            ...summary,
        };
    } catch (error) {
        console.log(error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_name: "RegisterWebhooksCronError",
            shop_domain: shop || "Unknown Shop"
        });
        throw error;
    }
};

module.exports = Webhook;
