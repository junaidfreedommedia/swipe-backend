const express = require("express");
const router = express.Router();
const { GraphqlQueryError } = require("@shopify/shopify-api");
const shopify = require("./../../shopify.js");

const WebhookList = async (req, res, next) => {
    try {
        const session = await Services.ShopifySession.get({
            shop: req.params.shop,
        });
        if (!session) throwError(MSG.SHOPIFY_SESSION_NOT_FOUND);
        let webhooks = await shopify.api.rest.Webhook.all({ session });
        return res.send({ data: webhooks.data, message: MSG.DATA_FOUND });
    } catch (error) {
        next(error);
    }
};

const RegisterAllWebhooks = async (req, res, next) => {
    try {
        const session = await Services.ShopifySession.get({
            shop: req.params.shop,
        });
        if (!session) throwError(MSG.SHOPIFY_SESSION_NOT_FOUND);
        await Services.Webhook.registerWebhooks(session);
        return res.send({ message: MSG.WEBHOOK_REGISTER_SUCCESS });
    } catch (error) {
        next(error);
    }
};

const DeleteMerchantData = async (req, res, next) => {
    try {
        const merchantInfo = await Services.Merchant.get(
            { shop_id: req.params.shop },
            { _id: 1 }
        );
        await Services.User.deleteMany({ merchant: merchantInfo._id });
        await Services.Event.deleteMany({ merchant: merchantInfo._id });
        await Services.Task.deleteMany({ merchant: merchantInfo._id });
        await Services.Widget.deleteMany({ merchant: merchantInfo._id });
        await Services.Merchant.deleteOne({ _id: merchantInfo._id });
        return res.send({ message: "Merchant Data Succesfully Deleted" });
    } catch (error) {
        next(error);
    }
};

const OrderCreateWebhook = async (req, res, next) => {
    try {
        const { shop, order } = req.body;
        const isExists = await Services.Order.get({ id: order }, { _id: 1 });
        if (isExists) return res.send({ message: "Order already exists" });
        const session = await Services.ShopifySession.get({ shop });
        const orderData = await shopify.api.rest.Order.find({
            session: session,
            id: order,
        });
        const protection = orderData.line_items.find(
            (line) =>
                line.title == PRODUCT_TITLE ||
                line.title == "Swipe Package Protection"
        );
        await Services.Order.handleOrderCreate(shop, orderData, protection);
        return res.send({ data: orderData, message: "Order is created" });
    } catch (error) {
        next(error);
    }
};

const OrderCreateWebhookForAdmin = async (req, res, next) => {
    try {
        const orderId = req.params.orderId;
        if (!orderId || typeof orderId !== "string" || orderId.trim() === "") {
            return res
                .status(400)
                .send({ message: "Invalid or missing order ID." });
        }
        const shop = "lola-and-the-boys-2.myshopify.com";
        const session = await Services.ShopifySession.get({ shop });
        const client = new shopify.api.clients.Graphql({ session });
  const checkExists = await client.request(`
  query {
    orders(first: 1, query: "name:${orderId}") {
      nodes { id name updatedAt }
    }
  }
`);

const orders = checkExists.data.orders.nodes;

        if (orders.length === 0) {
            return res.status(404).send({
                message: `Order with ID ${orderId} not found, Please enter Valid ID`,
            });
        }

        const gid = orders[0].id;
        const numericShopifyId = gid.match(/(\d+)$/)[0];

        const isExists = await Services.Order.get(
            { id: numericShopifyId },
            { _id: 1 }
        );
        if (isExists) return res.send({ message: "Order already exists" });
        const orderData = await shopify.api.rest.Order.find({
            session: session,
            id: numericShopifyId,
        });
         if (orderData.name) {
    orderData.name = orderData.name.replace(/[^0-9]/g, "");
}
        const protection = orderData.line_items.find(
            (line) =>
                line.title == PRODUCT_TITLE ||
                line.title == "Swipe Package Protection"
        );
        await Services.Order.handleOrderCreate(shop, orderData, protection);
        return res.send({
            message: "Order Created Successfully",
            data: orderData,
        });
    } catch (error) {
        if (error instanceof GraphqlQueryError) {
            throw new Error(
                `${error.message}\n${JSON.stringify(error.response, null, 2)}`
            );
        } else {
            throw error;
        }
    }
};
const BackfillOrdersByDate = async (req, res, next) => {
  try {
    const { shop, startDate, endDate } = req.body;

    if (!shop || !startDate || !endDate) {
      return res.status(400).send({
        message: "shop, startDate and endDate are required",
      });
    }

    const session = await Services.ShopifySession.get({ shop });
    if (!session) throwError("Shopify session not found");

    const client = new shopify.api.clients.Graphql({ session });

    let hasNextPage = true;
    let cursor = null;
    let createdCount = 0;

    while (hasNextPage) {
const response = await client.request(
  `
  query ($cursor: String) {
    orders(
      first: 250
      after: $cursor
      query: "updated_at:>=${startDate} updated_at:<=${endDate}"
    ) {
      edges { cursor node { id updatedAt } }
      pageInfo { hasNextPage }
    }
  }
  `,
  { variables: { cursor } }
);


const orders = response.data.orders.edges;


      for (const edge of orders) {
        const gid = edge.node.id;
        const numericId = gid.match(/(\d+)$/)[0];

        const exists = await Services.Order.get(
          { id: numericId },
          { _id: 1 }
        );
        if (exists) continue;

        const orderData = await shopify.api.rest.Order.find({
          session,
          id: numericId,
        });

        const protection = orderData.line_items.find(
          (line) =>
            line.title === PRODUCT_TITLE ||
            line.title === "Swipe Package Protection"
        );

        await Services.Order.handleOrderCreate(
          shop,
          orderData,
          protection
        );

        createdCount++;
      }

hasNextPage = response.data.orders.pageInfo.hasNextPage;

      cursor =
        orders.length > 0 ? orders[orders.length - 1].cursor : null;
    }

    return res.send({
      message: "Order backfill completed",
      createdOrders: createdCount,
    });
  } catch (error) {
    next(error);
  }
};

Services.Order.handleOrderUpdate = async (shop, orderData) => {
  if (!orderData || !orderData.id) return;

  const updatePayload = {
    financial_status: orderData.financial_status,
    fulfillment_status: orderData.fulfillment_status,
    total_price: orderData.total_price,
    subtotal_price: orderData.subtotal_price,
    total_tax: orderData.total_tax,
    total_discounts: orderData.total_discounts,
    updated_at: orderData.updated_at,
    cancelled_at: orderData.cancelled_at,
    cancel_reason: orderData.cancel_reason,
    refunds: orderData.refunds,
    order_status_url: orderData.order_status_url,
  };

  // ❗ Line items can change (order edit / refund)
  if (orderData.line_items) {
    updatePayload.line_items = orderData.line_items;
  }

  // ❗ Fulfillments change on return / partial refund
  if (orderData.fulfillments) {
    updatePayload.fulfillments = orderData.fulfillments;
  }

  const result = await Services.Order.updateOne(
    { id: orderData.id },
    { $set: updatePayload }
  );

  return result;
};
const addVerifiedBySwipeTag = async (client, orderGid) => {
  const TAG = "verifiedbyswipe";

  // Fetch existing tags
const fetchRes = await client.request(
  `
  query ($id: ID!) {
    order(id: $id) { id tags }
  }
  `,
  { variables: { id: orderGid } }
);

const existingTags = fetchRes.data.order.tags || [];


  // Already tagged
  if (existingTags.includes(TAG)) return false;

  // Update tags
const updateRes = await client.request(
  `
  mutation ($id: ID!, $tags: [String!]!) {
    orderUpdate(input: { id: $id, tags: $tags }) {
      order { id tags }
      userErrors { field message }
    }
  }
  `,
  { variables: { id: orderGid, tags: [...existingTags, TAG] } }
);

const userErrors = updateRes.data.orderUpdate.userErrors;
if (userErrors.length) {
  throw new Error(userErrors.map(e => e.message).join(", "));
}


  return true;
};

const BackfillUpdatedOrdersByDate = async (req, res, next) => {
  try {
    const { shop, startDate, endDate } = req.body;

    const session = await Services.ShopifySession.get({ shop });
    const client = new shopify.api.clients.Graphql({ session });

    const startISO = new Date(startDate + "T00:00:00Z").toISOString();

    let cursor = null;
    let scanned = 0;
    let updated = 0;

    while (true) {
      const resp = await client.request(
        `
        query ($cursor: String) {
          orders(
            first: 100
            after: $cursor
          query: "updated_at:>=${startDate} updated_at:<=${endDate}"
          ) {
            edges {
              cursor
              node { id updatedAt }
            }
            pageInfo { hasNextPage }
          }
        }
        `,
        { variables: { cursor } }
      );

      const edges = resp.data.orders.edges;
      if (!edges.length) break;

      for (const edge of edges) {
        scanned++;
        const numericId = edge.node.id.match(/(\d+)$/)[0];

        const orderData = await shopify.api.rest.Order.find({
          session,
          id: numericId,
        });

        const updatedAt = new Date(orderData.updated_at);
        const start = new Date(startDate);
        const end = new Date(endDate + "T23:59:59Z");

        if (updatedAt >= start && updatedAt <= end) {
          await Services.Order.handleOrderUpdate(shop, orderData);
          updated++;
        }
      }

      if (!resp.data.orders.pageInfo.hasNextPage) break;
      cursor = edges[edges.length - 1].cursor;
    }

    return res.send({
      message: "Backfill completed",
      scanned,
      updated,
    });
  } catch (err) {
    next(err);
  }
};



const UsageRecordCreate = async (req, res, next) => {
    try {
        const { shop, order } = req.params;
        const merchantInfo = await Services.Merchant.get({ shop_id: shop });
        if (!merchantInfo.is_billing)
            throwError("Please enable the merchant billing option.");
        const orderInfo = await Services.Order.get(
            { order_number: order },
            { _id: 1, protection_amount: 1 }
        );
        if (empty(orderInfo)) throwError("Order not found.");
        const alreadyExists = await Services.UsageRecord.get(
            { order: orderInfo._id },
            { _id: 1 }
        );
        if (alreadyExists) throwError("Usages record already exists.");
        const response = await Services.Billing.createUsageRecord({
            shop,
            merchant: merchantInfo._id,
            order: orderInfo._id,
            billing_type: "shopify",
            amount: Number(orderInfo.protection_amount),
        });
        return res.send({
            data: response,
            message: "Usages record successfully created.",
        });
    } catch (error) {
        next(error);
    }
};

const AppApi = async (req, res, next) => {
    try {
        return res.send({
            data: {
                result: {
                    app: {
                        name: "Swipe",
                        description:
                            "Our round-the-clock management of shipping issues will increase revenue and enhance your customer loyalty. Best Shopify package protection in the market!",
                        download: 50,
                    },
                },
            },
        });
    } catch (error) {
        next(error);
    }
};



//for testing
const RemoveMerchant = async (req, res, next) => {
    try {
        const merchantInfo = await Services.Merchant.get(
            { shop_id: req.params.shop },
            { _id: 1 })
            const session = await Services.ShopifySession.get({ shop: req.params.shop  });
            if (session) {
                // Get all webhooks
                const webhooks = await shopify.api.rest.Webhook.all({ session });
                
                // Delete each webhook
                for (const webhook of webhooks.data) {
                    await shopify.api.rest.Webhook.delete({
                        session,
                        id: webhook.id
                    });
                }
            }
            
    
        
        await Services.User.deleteMany({ merchant: merchantInfo._id });
        await Services.Event.deleteMany({ merchant: merchantInfo._id });
        await Services.Task.deleteMany({ merchant: merchantInfo._id });
        await Services.Widget.deleteMany({ merchant: merchantInfo._id });
        await Services.Merchant.deleteOne({ _id: merchantInfo._id });
       
        return res.send({ message: "Merchant Data Succesfully Deleted" });
    } catch (err) {
        console.error("Error during webhook reprocessing:", err);
    }
};

router.get("/webhook-list/:shop", WebhookList);
router.post("/backfill-orders", BackfillOrdersByDate);
router.post("/backfill-updated-orders", BackfillUpdatedOrdersByDate);

router.get("/webhook-register/:shop", RegisterAllWebhooks);
router.get("/usage-record-create/:shop/:order", UsageRecordCreate);
router.get("/app", AppApi);
router.post("/order-create", OrderCreateWebhook);
router.get("/create-order/:orderId", OrderCreateWebhookForAdmin);
router.delete("/remove-merchant-data/:shop", DeleteMerchantData);
router.get("/remove/:shop", RemoveMerchant);

module.exports = router;
