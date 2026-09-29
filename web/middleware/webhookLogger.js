/**
 * Middleware to log all webhook payloads to the WebhookPayload collection
 * Non-blocking implementation that always calls next()
 */
const logWebhookPayload = (req, res, next) => {
    try {
        // Get the webhook topic from the URL path
        // const urlPath = req.path;
        // const topic = urlPath.substring(1); // Remove leading slash
        
        // // Parse the payload
        // const rawPayload = req.body.toString();
        // let payload;
        
        // try {
        //     payload = JSON.parse(rawPayload);
        // } catch (e) {
        //     // If payload isn't valid JSON, store as string
        //     payload = rawPayload;
        // }
        
        // // Store the webhook payload (non-blocking)
        // Services.WebhookPayload.insert({
        //     topic,
        //     payload
        // }).catch(err => {
        //     console.log('Error logging webhook payload:', err);
        // });
        
        // Continue to the actual webhook handler immediately
        next();
    } catch (error) {
        console.log('Error in webhook logger middleware:', error);
        // Always continue to the handler even if logging fails
        next();
    }
};

module.exports = logWebhookPayload;