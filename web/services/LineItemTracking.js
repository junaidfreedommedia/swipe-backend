const lineItemsTrackingSchema = Models.LineItemTracking;
const shopify = require("./../shopify");
const LineItemTracking = {};

LineItemTracking.aggregate = async (pipeline, allowDiskUse = false) => {
    if (allowDiskUse)
        return lineItemsTrackingSchema.aggregate(pipeline).allowDiskUse(true);
    return lineItemsTrackingSchema.aggregate(pipeline);
};

/**
 * Creates tracking entries for each unit of each line item
 * @param {Object} params
 * @param {string} params.merchantId - MongoDB ObjectId of the merchant
 * @param {string} params.orderId - MongoDB ObjectId of our local order
 * @param {string} params.shopifyOrderId - Shopify's order ID
 * @param {Array} params.lineItems - Array of line items from Shopify webhook
 */
LineItemTracking.processOrderLineItems = async ({
    merchantId,
    orderId,
    shopifyOrderId,
    lineItems,
}) => {
    try {
        const trackingEntries = [];

        // Process each line item
        for (const item of lineItems) {
            // Exclude gift card product (Note: 8398355530034 this is test product Id)
            const excludedProductIds = [596294369338, 8398355530034];
            if (excludedProductIds.includes(item?.product_id)) continue;

            // Create quantity number of entries for this line item
            for (let i = 0; i < item.quantity; i++) {
                trackingEntries.push({
                    merchant: merchantId,
                    order: orderId,
                    order_id: String(shopifyOrderId),
                    line_item_id: item.id,
                    gross_sale: Number(item.price),
                });
            }
        }

        // Bulk insert all tracking entries
        if (trackingEntries.length > 0) {
            await lineItemsTrackingSchema.insertMany(trackingEntries);
        }

        return { success: true, count: trackingEntries.length };
    } catch (err) {
        Services.WebhookError.handle({
            webhook_error:
                err instanceof Error ? err.message : JSON.stringify(err),
            webhook_payload: shopifyOrderId,
            webhook_name: "LineItemTracking",
        });
        return { success: false, error: err.message };
    }
};

/**
 * Creates tracking entries for returned line items with 0 gross sale
 * @param {Object} params
 * @param {string} params.merchantId - MongoDB ObjectId of the merchant
 * @param {string} params.orderId - MongoDB ObjectId of our local order
 * @param {string} params.shopifyOrderId - Shopify's order ID
 * @param {Array} params.returnLineItems - Array of return line items from Shopify webhook
 * @param {string} params.returnId - The top-level return ID from the webhook payload
 */
LineItemTracking.processReturnLineItems = async ({
    merchantId,
    orderId,
    shopifyOrderId,
    returnLineItems,
    returnId,
}) => {
    try {
        const trackingEntries = [];

        // Process each return line item
        for (const item of returnLineItems) {
            const lineItemId = item.fulfillment_line_item.line_item.id;

            // Create quantity number of return entries
            for (let i = 0; i < item.quantity; i++) {
                trackingEntries.push({
                    merchant: merchantId,
                    order: orderId,
                    order_id: String(shopifyOrderId),
                    line_item_id: lineItemId,
                    gross_sale: 0,
                    return_id: String(returnId),
                });
            }
        }

        // Bulk insert all tracking entries
        if (trackingEntries.length > 0) {
            await lineItemsTrackingSchema.insertMany(trackingEntries);
        }

        return { success: true, count: trackingEntries.length };
    } catch (err) {
        Services.WebhookError.handle({
            webhook_error:
                err instanceof Error ? err.message : JSON.stringify(err),
            webhook_payload: shopifyOrderId,
            webhook_name: "processReturnLineItems",
        });
        return { success: false, error: err.message };
    }
};

const fetchLineItemDetails = async ({ session, orderId, lineItemId, qty }) => {
    const client = new shopify.api.clients.Graphql({ session });

    const query = `
        query GetLineItemDetails($lineItemId: ID!) {
            node(id: $lineItemId) {
                ... on LineItem {
                    id
                    title
                    quantity
                    currentQuantity
                    variant {
                        id
                        title
                    }
                    customAttributes {
                        key
                        value
                    }
                    discountAllocations {
                        allocatedAmountSet {
                            shopMoney {
                                amount
                                currencyCode
                            }
                        }
                    }
                    originalTotalSet {
                        shopMoney {
                            amount
                            currencyCode
                        }
                    }
                    originalUnitPriceSet {
                        shopMoney {
                            amount
                            currencyCode
                        }
                        presentmentMoney {
                            amount
                            currencyCode
                        }
                    }
                }
            }
        }
    `;

    try {
        const response = await client.request(query, {
            variables: { lineItemId },
        });

        const node = response?.data?.node;
        if (!node) {
            throw new Error(`Line item ${lineItemId} not found.`);
        }

        const grossSale =
            parseFloat(node.originalUnitPriceSet.presentmentMoney.amount) *
                qty || 0;

        return grossSale;
    } catch (error) {
        console.error("Error fetching line item details:", error);
        return 0;
    }
};


/**
 * Creates tracking entries for each unit of each line item
 * @param {Object} params
 * @param {string} params.merchantId - MongoDB ObjectId of the merchant
 * @param {string} params.orderId - MongoDB ObjectId of our local order
 * @param {string} params.shopifyOrderId - Shopify's order ID
 * @param {Array} params.lineItems - Array of line items from Shopify webhook
 */

LineItemTracking.processOrderEditLineItems = async ({
    session,
    merchantId,
    orderId,
    shopifyOrderId,
    orderEdit,
}) => {
    try {
        const trackingEntries = [];

        // Process removals first with gross_sale = 0
        for (const removal of orderEdit.line_items.removals) {
            const lineItemId = removal.id;

            trackingEntries.push({
                merchant: merchantId,
                order: orderId,
                order_id: String(shopifyOrderId),
                line_item_id: lineItemId,
                gross_sale: 0,
            });
        }

        // Process additions with the original gross_sale amount
        // Assuming you have a way to get gross_sale for the additions (you might need to fetch it or pass it in)
        for (const addition of orderEdit.line_items.additions) {
            const lineItemId = addition.id;
            const qty = addition.delta;

            let grossSale = 0;
            try {
                const lineItemGID = `gid://shopify/LineItem/${lineItemId}`;
                // const shopifyOrderIdGID = `gid://shopify/Order/${shopifyOrderId}`;

                grossSale = await fetchLineItemDetails({
                    session,
                    orderId: shopifyOrderId,
                    lineItemId: lineItemGID,
                    qty,
                });
            } catch (err) {
                console.warn(
                    `Failed to fetch gross sale for line item ${lineItemId}:`,
                    err.message
                );
            }

            trackingEntries.push({
                merchant: merchantId,
                order: orderId,
                order_id: String(shopifyOrderId),
                line_item_id: lineItemId,
                gross_sale: grossSale,
            });
        }

        if (trackingEntries.length > 0) {
            await lineItemsTrackingSchema.insertMany(trackingEntries);
        }

        return { success: true, count: trackingEntries.length };
    } catch (err) {
        Services.WebhookError.handle({
            webhook_error:
                err instanceof Error ? err.message : JSON.stringify(err),
            webhook_payload: shopifyOrderId,
            webhook_name: "processOrderEditLineItems",
        });
        return { success: false, error: err.message };
    }
};

module.exports = LineItemTracking;
