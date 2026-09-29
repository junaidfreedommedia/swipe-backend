const express = require("express");
const router = express.Router();
const Webhook = Services.Webhook;
const logWebhookPayload = require("../../middleware/webhookLogger");
const {  processOrderUpdateUnified, } = require("../../services/orderUpdate.service");

const {
  SQSClient,
  SendMessageCommand,
} = require("@aws-sdk/client-sqs");


const sqs = new SQSClient({
  region: process.env.AWS_REGION || "us-east-1",
});

const QUEUE_URL = process.env.SQS_QUEUE_URL;
const THROTTLE_MS = 1; // SAME as old file queue


const hasSwipeTagChange = (payload = {}) => {
  const currentTags = payload.tags || "";
  const previousTags = payload.previous_attributes?.tags || "";

  const normalize = (tags) =>
    tags
      .split(",")
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);

  const curr = new Set(normalize(currentTags));
  const prev = new Set(normalize(previousTags));

  const swipeTags = ["verifiedbyswipe", "swipe"];

  return swipeTags.some(
    tag => curr.has(tag) !== prev.has(tag)
  );
};





// -------------------------------
// Prevent duplicate Shopify webhooks
// -------------------------------
const seenWebhooks = new Set();

const isDuplicateWebhook = (req) => {
  const webhookId = req.headers["x-shopify-webhook-id"];
  if (!webhookId) return false;

  if (seenWebhooks.has(webhookId)) {
    return true;
  }

  seenWebhooks.add(webhookId);

  // Auto-clean after 5 minutes
  setTimeout(() => {
    seenWebhooks.delete(webhookId);
  }, 5 * 60 * 1000);

  return false;
};


const OrderCreate = async (req, res, next) => {
    console.log("\n\n--- ✅ INCOMING /ORDER_CREATE WEBHOOK ---");
    console.log("Timestamp:", new Date().toISOString());
    try {
        console.log("Request Headers:", JSON.stringify(req.headers, null, 2));
        const rawBody = req.body.toString();
        console.log("Raw Body Received:", rawBody);
        if (!rawBody) {
            console.log("❌ ERROR: Request body is empty. Cannot proceed.");
            return res.status(400).send("Empty body");
        }
        let payload = JSON.parse(rawBody);
        console.log("--- Payload parsed successfully ---");
        if (payload.browser_ip) {
            console.log(`✅ SUCCESS: Customer IP Found: ${payload.browser_ip}`);
        } else {
            console.log("⚠️ INFO: The 'browser_ip' field was not present in the payload from Shopify.");
            console.log("This is normal for orders created via Admin, Drafts, or POS.");
        }
        res.status(200).send("OK");
        const shop = req.header("X-Shopify-Shop-Domain");
        let protection = payload.line_items.find(
            (line) => line.title == PRODUCT_TITLE || line.title == "Swipe Package Protection"
        );
        Services.Order.handleOrderCreate(shop, payload, protection);
        console.log("--- Order processing logic initiated ---");
    } catch (error) {
        console.log("❌❌❌ CRITICAL ERROR IN OrderCreate ❌❌❌");
        console.error(error);
        res.status(200).send("OK - but error logged");
    }
};

const AppUninstall = async (req, res, next) => {
    let payload;
    try {
        payload = JSON.parse(req.body.toString());
        const merchantInfo = await Services.Merchant.findOneAndUpdate(
            { domain: payload.domain },
            { $set: { is_active: false } }
        );
        if (!empty(merchantInfo)) {
            await Services.Event.insert({
                merchant: merchantInfo._id,
                type: "APP",
                sub_type: "UNINSTALL",
                action_on: ACTIVITY_LOG_LABEL.SYSTEM,
                title: EVENT_TITLE.APP_UNINSTALL,
                ts: Math.floor(new Date().getTime() / 1000),
            });
            await Services.Task.deleteMany({ merchant: merchantInfo._id });
            await Services.Widget.deleteMany({ merchant: merchantInfo._id });
        }
    } catch (error) {
        console.log(error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "AppUninstallWebhook",
            shop_domain: payload?.domain || "Unknown Shop",
        });
        Logger.error(error.stack);
    }
    return res.status(200).send("OK");
};

const OrderFulfilled = async (req, res, next) => {
    let payload;
    try {
        res.status(200).send("OK");
        const shop = req.header("X-Shopify-Shop-Domain");
        payload = JSON.parse(req.body.toString());
        const protectedOrder = payload.line_items.filter(
            (line) => line.title == PRODUCT_TITLE || line.title == "Swipe Package Protection"
        );
        if (protectedOrder.length)
            Services.Order.handleOrderFulfilled(shop, payload, protectedOrder[0]);
    } catch (error) {
        console.log(error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "OrderFulfilledWebhook",
            shop_domain: shop || "Unknown Shop",
        });
        Logger.error(error.stack);
    }
};

const isPureNoiseOrderUpdate = (payload = {}) => {
  if (payload.order_edit) return false;

  if (Array.isArray(payload.refunds) && payload.refunds.length > 0) {
    return false;
  }

  if (Array.isArray(payload.line_items) && payload.line_items.length > 0) {
    return false;
  }

  return true;
};

const isTrackingOnlyUpdate = (payload = {}) => {
  // If refund or order edit exists → NOT tracking-only
  if (payload.refunds?.length) return false;
  if (payload.order_edit) return false;

  // Tracking / fulfillment present
  const hasFulfillment = Array.isArray(payload.fulfillments) && payload.fulfillments.length > 0;

  // Line items exist but quantities / prices unchanged (Shopify still sends them)
  const hasLineItems = Array.isArray(payload.line_items) && payload.line_items.length > 0;

  // If this update is only fulfillment + timestamps
  if (hasFulfillment && hasLineItems) {
    return true;
  }

  return false;
};
const isAdminNoise = (payload = {}) => {
  // Agar admin user involved hai
  if (payload.user_id) {
    // Lekin real business change hai → allow
    if (payload.refunds?.length) return false;
    if (payload.order_edit) return false;
    if (payload.cancelled_at) return false;

    // Warna admin ka koi bhi action = noise
    return true;
  }
  return false;
};

const hasLineItemQuantityChange = (payload) => {
  if (!Array.isArray(payload?.line_items)) return false;

  return payload.line_items.some((item) => {
    const q = Number(item.quantity);
    const cq = Number(item.current_quantity);
    const fq = Number(item.fulfillable_quantity);

    // Admin order edits cause these to diverge
    return q !== cq || q !== fq;
  });
};


const OrderUpdated = async (req, res) => {
  // ✅ Always ACK Shopify immediately
  res.status(200).end();

  // ⏭️ Duplicate protection
  if (isDuplicateWebhook(req)) {
    console.log("⏭️ ORDERS_UPDATED SKIPPED | reason=duplicate_webhook");
    return;
  }

  // ⏭️ Safe JSON parse
  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    console.log("⏭️ ORDERS_UPDATED SKIPPED | reason=invalid_json");
    return;
  }

  const shop = req.header("X-Shopify-Shop-Domain");
  const orderId = payload?.id;

  if (!shop || !orderId) {
    console.log("⏭️ ORDERS_UPDATED SKIPPED | reason=missing_identifiers");
    return;
  }

  /* ------------------------------------------------------------------ */
  /* 🧠 CHANGE DETECTORS (ORDER MATTERS)                                 */
  /* ------------------------------------------------------------------ */

  // ✅ Swipe tag logic (additive override)
  const swipeTagChanged = hasSwipeTagChange(payload);

  // ✅ HARD RULE: quantity change is ALWAYS meaningful
  const hasQtyChange = hasLineItemQuantityChange(payload);

  /* ------------------------------------------------------------------ */
  /* 🔥 NOISE FILTERS (ONLY IF NO MEANINGFUL CHANGE)                     */
  /* ------------------------------------------------------------------ */

  // A payload with line_items is not safe to classify as tracking-only here.
  // Shopify also includes fulfillments in post-purchase order edits (Aftersell,
  // upsells, etc.). The worker compares the snapshot with the stored order and
  // cheaply ignores it when the business fields are genuinely unchanged.
  const hasOrderSnapshot =
    Array.isArray(payload.line_items) && payload.line_items.length > 0;

  if (
    !hasOrderSnapshot &&
    !swipeTagChanged &&
    !hasQtyChange &&
    isTrackingOnlyUpdate(payload)
  ) {
    console.log(
      `⏭️ ORDERS_UPDATED SKIPPED | reason=tracking_only | shop=${shop} | orderId=${orderId}`
    );
    return;
  }

  if (
    !hasOrderSnapshot &&
    !swipeTagChanged &&
    !hasQtyChange &&
    isAdminNoise(payload)
  ) {
    console.log(
      `⏭️ ORDERS_UPDATED SKIPPED | reason=admin_noise | shop=${shop} | orderId=${orderId}`
    );
    return;
  }

  if (!swipeTagChanged && !hasQtyChange && isPureNoiseOrderUpdate(payload)) {
    console.log(
      `⏭️ ORDERS_UPDATED SKIPPED | reason=pure_noise | shop=${shop} | orderId=${orderId}`
    );
    return;
  }

  /* ------------------------------------------------------------------ */
  /* 📤 SEND ONLY MEANINGFUL EVENTS TO SQS                               */
  /* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 🧠 SWIPE TAG CHANGE = FULL ORDER SYNC                               */
/* ------------------------------------------------------------------ */

if (swipeTagChanged) {
  console.log(
    `🔥 SWIPE TAG CHANGE DETECTED → FULL ORDER SYNC | shop=${shop} | orderId=${orderId}`
  );

  await processOrderUpdateUnified({
    payload,
    shop,
    mode: "FULL",
    Services,
  });

  return;
}

/* ------------------------------------------------------------------ */
/* 📤 NORMAL ORDER UPDATE → SEND TO SQS                                */
/* ------------------------------------------------------------------ */

await sqs.send(
  new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify({
      ts: Date.now(),
      shop,
      orderId,
      payload,
      reason: hasQtyChange
        ? "LINE_ITEM_QTY_UPDATE"
        : "ORDER_UPDATE",
    }),
  })
);

console.log(
  `📤 ORDERS_UPDATED → SQS QUEUED | shop=${shop} | orderId=${orderId} | qtyChange=${hasQtyChange}`
);

  console.log(
    `📤 ORDERS_UPDATED → SQS QUEUED | shop=${shop} | orderId=${orderId} | qtyChange=${hasQtyChange} | swipeTagChanged=${swipeTagChanged}`
  );
};




const OrderEdit = async (req, res, next) => {
  let payload;

  try {
    res.status(200).send("OK");

    const shop = req.header("X-Shopify-Shop-Domain");
    payload = JSON.parse(req.body.toString());

  await processOrderUpdateUnified({
  payload,
  shop,
  mode: "TAGS_ONLY",
  Services, // ✅ REQUIRED
});
  } catch (error) {
    console.log("❌ ERROR in OrderEditWebhook:", error);
    await Services.WebhookError.handle({
      webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
      webhook_payload: payload,
      webhook_name: "OrderEditWebhook",
      shop_domain: req.header("X-Shopify-Shop-Domain") || "Unknown Shop",
    });
  }
};


const OrderPartiallyFulfilled = async (req, res, next) => {
    let payload;
    try {
        res.status(200).send("OK");
        const shop = req.header("X-Shopify-Shop-Domain");
        payload = JSON.parse(req.body.toString());
        console.log({ payload });
        const protectedOrder = payload.line_items.filter(
            (line) => line.title == PRODUCT_TITLE || line.title == "Swipe Package Protection"
        );
        if (protectedOrder.length)
            Services.Order.handleOrderFulfilled(shop, payload, protectedOrder[0]);
    } catch (error) {
        console.log(error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "OrderPartiallyFulfilledWebhook",
            shop_domain: shop || "Unknown Shop",
        });
        Logger.error(error.stack);
    }
};

const ShopUpdate = async (req, res, next) => {
    let payload;
    try {
        res.status(200).send("OK");
        const shop = req.header("X-Shopify-Shop-Domain");
        payload = JSON.parse(req.body.toString());
        console.log({ payload, shop });
        await Services.Merchant.findOneAndUpdate(
            { id: payload.id },
            { $set: { ...payload } },
            { upsert: true }
        );
    } catch (error) {
        console.log(error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "ShopUpdateWebhook",
            shop_domain: shop || "Unknown Shop",
        });
        Logger.error(error.stack);
    }
};

const AppSubscriptionUpdate = async (req, res, next) => {
    return res.status(200).send("OK");
};

const RegisterAllWebhooks = async (req, res, next) => {
    let payload;
    try {
        payload = JSON.parse(req.body.toString());
        console.log(payload);
        const { shop } = payload;
        const session = await Services.ShopifySession.get({ shop });
        if (!session) return res.send({ message: MSG.DATA_NOT_FOUND });
        await Webhook.registerWebhooks(session);
        return res.send({ message: MSG.WEBHOOK_REGISTER_SUCCESS });
    } catch (error) {
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "RegisterWebhook",
            shop_domain: payload?.shop || "Unknown Shop",
        });
        next(error);
    }
};

const webhookUrl = async (req, res) => {
    const echo = req.query.echo;
    if (echo) {
        return res.status(200).send(echo);
    } else {
        return res.status(400).send("Missing echo parameter.");
    }
};

const RefundCreate = async (req, res, next) => {
    let payload;
    try {
        res.status(200).send("OK");
        const shop = req.header("X-Shopify-Shop-Domain");
        payload = JSON.parse(req.body.toString());

        await Services.Order.handleRefunds(shop, payload, 'refund_create');

    } catch (error) {
        console.log(error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "RefundCreateWebhook",
            shop_domain: req.header("X-Shopify-Shop-Domain") || "Unknown Shop",
        });
    }
};



const TrackerUpdate = async (req, res, next) => {
  try {
    const event = JSON.parse(req.body.toString());

    if (!event || event.description !== "tracker.updated" || !event.result) {
      return res.status(200).send("Event ignored");
    }

    const tracker = event.result;
    if (!tracker.id || !tracker.status) {
      return res.status(400).send("Invalid tracker data");
    }

    const order = await Services.Order.get({ tracking_id: tracker.id });
    if (!order) {
      console.log(`⏭️ TRACKER SKIP: No order for tracking ${tracker.id}`);
      return res.status(200).send("No matching order");
    }

    /* -----------------------------------------
       ✅ ONLY UPDATE WHEN TRACKING IS NEW
    ----------------------------------------- */
    const existingTrackingId = order.tracking_id;

    if (existingTrackingId === tracker.id) {
      console.log(
        `⏭️ TRACKING STATUS SKIPPED for order ${order.id} (status: ${tracker.status})`
      );
      return res.status(200).send("Tracking status ignored");
    }

    /* -----------------------------------------
       🆕 NEW TRACKING → SAVE ONCE
    ----------------------------------------- */
    await Services.Order.findOneAndUpdate(
      { _id: order._id },
      {
        $set: {
          tracking_id: tracker.id,
          tracking_status: tracker.status,
        },
      }
    );

    console.log(
      `📦 TRACKING ADDED: Order ${order.id} → ${tracker.id} (${tracker.status})`
    );

    return res.status(200).send("Tracking saved");
  } catch (error) {
    next(error);
  }
};

const registerWebhook = async (req, res, next) => {
    try {
        const { shop } = req.params;
        const { topic, webhookUrl } = req.body;
        if (!shop || !topic || !webhookUrl) {
            return res.status(400).json({ success: false, message: "Missing required parameters: shop, topic, or webhookUrl" });
        }
        const session = await Services.ShopifySession.get({ shop });
        if (!session) {
            return res.status(404).json({ success: false, message: "Shop session not found, or check the DB environment(development/production)" });
        }
        const client = new shopify.api.clients.Graphql({ session });
        const graphqlQuery = {
            query: `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) { userErrors { field message } webhookSubscription { id endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`,
            variables: { topic, webhookSubscription: { callbackUrl: webhookUrl, format: "JSON" } },
        };
        const response = await client.query({ data: graphqlQuery });
        const result = response.body.data.webhookSubscriptionCreate;
        if (result.userErrors.length > 0) {
            return res.status(400).json({ success: false, errors: result.userErrors });
        }
        res.json({ success: true, data: result.webhookSubscription });
    } catch (error) {
        console.error("Webhook registration error:", error);
        next(error);
    }
};

const listWebhooks = async (req, res, next) => {
    try {
        const { shop } = req.params;
        if (!shop) {
            return res.status(400).json({ success: false, message: "Missing required parameter: shop" });
        }
        const session = await Services.ShopifySession.get({ shop });
        if (!session) {
            return res.status(404).json({ success: false, message: "Shop session not found, or check the DB environment(development/production)" });
        }
        const client = new shopify.api.clients.Graphql({ session });
        const graphqlQuery = {
            query: `{ webhookSubscriptions(first: 50) { edges { node { id topic createdAt endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } } }`,
        };
        const response = await client.query({ data: graphqlQuery });
        const subscriptions = response.body.data.webhookSubscriptions.edges.map((edge) => edge.node);
        res.json({ success: true, webhooks: subscriptions });
    } catch (error) {
        console.error("List webhooks error:", error);
        next(error);
    }
};

const ReturnsApprove = async (req, res, next) => {
    res.status(200).send("OK");
    try {
        const shop = req.header("X-Shopify-Shop-Domain");
        let payload = JSON.parse(req.body.toString());
        await Services.Order.handleRefunds(shop, payload, 'returns_approve');
    } catch (error) {
        console.log(error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "ReturnsApproveWebhook",
            shop_domain: shop || "Unknown Shop",
        });
    }
};






const handleOrdersCancelled = async (req, res, next) => {
    res.status(200).send("OK");
    try {
        const payload = JSON.parse(req.body.toString());
        await Services.Order.handleRefunds(req.header("X-Shopify-Shop-Domain"), payload, 'order_cancelled');
    } catch (error) {
        console.error("Error in ORDERS_CANCELLED webhook:", error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "OrdersCancelledWebhook",
            shop_domain: req.header("X-Shopify-Shop-Domain") || "Unknown Shop",
        });
    }
};

const handleReturnsUpdate = async (req, res, next) => {
    res.status(200).send("OK");
    try {
        const shop = req.header("X-Shopify-Shop-Domain");
        const payload = JSON.parse(req.body.toString());
        await Services.Order.handleReturns(shop, payload, 'returns_update');
    } catch (error) {
        console.error("Error in RETURNS_UPDATE webhook:", error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "ReturnsUpdateWebhook",
            shop_domain: req.header("X-Shopify-Shop-Domain") || "Unknown Shop",
        });
    }
};

const handleReturnsDecline = async (req, res, next) => {
    res.status(200).send("OK");
    try {
        const shop = req.header("X-Shopify-Shop-Domain");
        const payload = JSON.parse(req.body.toString());
        await Services.Order.handleReturns(shop, payload, 'returns_decline');
    } catch (error) {
        console.error("Error in RETURNS_DECLINE webhook:", error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "ReturnsDeclineWebhook",
            shop_domain: req.header("X-Shopify-Shop-Domain") || "Unknown Shop",
        });
    }
};

const handleReturnsCancel = async (req, res, next) => {
    res.status(200).send("OK");
    try {
        const shop = req.header("X-Shopify-Shop-Domain");
        const payload = JSON.parse(req.body.toString());
        await Services.Order.handleReturns(shop, payload, 'returns_cancel');
    } catch (error) {
        console.error("Error in RETURNS_CANCEL webhook:", error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "ReturnsCancelWebhook",
            shop_domain: req.header("X-Shopify-Shop-Domain") || "Unknown Shop",
        });
    }
};

const handleReturnsClose = async (req, res, next) => {
    res.status(200).send("OK");
    try {
        const shop = req.header("X-Shopify-Shop-Domain");
        const payload = JSON.parse(req.body.toString());
        await Services.Order.handleReturns(shop, payload, 'returns_close');
    } catch (error) {
        console.error("Error in RETURNS_CLOSE webhook:", error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "ReturnsCloseWebhook",
            shop_domain: req.header("X-Shopify-Shop-Domain") || "Unknown Shop",
        });
    }
};

const handleReturnsReopen = async (req, res, next) => {
    res.status(200).send("OK");
    try {
        const shop = req.header("X-Shopify-Shop-Domain");
        const payload = JSON.parse(req.body.toString());
        await Services.Order.handleReturns(shop, payload, 'returns_reopen');
    } catch (error) {
        console.error("Error in RETURNS_REOPEN webhook:", error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "ReturnsReopenWebhook",
            shop_domain: req.header("X-Shopify-Shop-Domain") || "Unknown Shop",
        });
    }
};

const handleReturnsRequest = async (req, res, next) => {
    res.status(200).send("OK");
    try {
        const shop = req.header("X-Shopify-Shop-Domain");
        const payload = JSON.parse(req.body.toString());
        await Services.Order.handleReturns(shop, payload, 'returns_request');
    } catch (error) {
        console.error("Error in RETURNS_REQUEST webhook:", error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "ReturnsRequestWebhook",
            shop_domain: req.header("X-Shopify-Shop-Domain") || "Unknown Shop",
        });
    }
};

const handleReturnsProcess = async (req, res, next) => {
    res.status(200).send("OK");
    try {
        const shop = req.header("X-Shopify-Shop-Domain");
        const payload = JSON.parse(req.body.toString());
        await Services.Order.handleReturns(shop, payload, 'returns_process');
    } catch (error) {
        console.error("Error in RETURNS_PROCESS webhook:", error);
        await Services.WebhookError.handle({
            webhook_error: error instanceof Error ? error.message : JSON.stringify(error),
            webhook_payload: payload,
            webhook_name: "ReturnsProcessWebhook",
            shop_domain: req.header("X-Shopify-Shop-Domain") || "Unknown Shop",
        });
    }
};


router.get("/webhook-url", webhookUrl);

// --------------------
// ORDER / SHOPIFY WEBHOOKS
// --------------------

router.post(
  "/ORDER_CREATE",
    express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  OrderCreate
);

router.post(
  "/APP_UNINSTALLED",
  express.raw({ type: "application/json" }),
  Auth.verifyWebhook,
  AppUninstall
);

router.post(
  "/ORDERS_FULFILLED",
   express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  OrderFulfilled
);


router.post(
  "/ORDERS_EDITED",
   express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  OrderEdit
);

router.post(
  "/ORDERS_PARTIALLY_FULFILLED",
  express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  logWebhookPayload,
  OrderPartiallyFulfilled
);


router.post(
  "/SHOP_UPDATE",
  express.raw({ type: "application/json" }),
  Auth.verifyWebhook,
  ShopUpdate
);

router.post(
  "/APP_SUBSCRIPTIONS_UPDATE",
  express.raw({ type: "application/json" }),
  Auth.verifyWebhook,
  AppSubscriptionUpdate
);

// --------------------
// NON-SHOPIFY / INTERNAL
// --------------------

router.post("/register", Auth.check, RegisterAllWebhooks);

router.post(
  "/REFUND_CREATE",
    express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  RefundCreate
);

router.post(
  "/TRACKER_UPDATE",
  express.raw({ type: "application/json" }),
  Auth.verifyWebhook,
  TrackerUpdate
);

router.post("/gql/register/:shop", Auth.check, registerWebhook);
router.get("/gql/list/:shop", listWebhooks);

// --------------------
// ORDER UPDATED (SQS – MOST IMPORTANT)
// --------------------

router.post(
  "/ORDERS_UPDATED",
  express.raw({ type: "application/json", limit: "2mb" }),
  Auth.verifyWebhook,
  OrderUpdated
);

// --------------------
// RETURNS WEBHOOKS
// --------------------

router.post(
  "/ORDERS_CANCELLED",
    express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  logWebhookPayload,
  handleOrdersCancelled
);

router.post(
  "/RETURNS_UPDATE",
    express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  logWebhookPayload,
  handleReturnsUpdate
);

router.post(
  "/RETURNS_DECLINE",
    express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  logWebhookPayload,
  handleReturnsDecline
);

router.post(
  "/RETURNS_APPROVE",
   express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  ReturnsApprove
);

router.post(
  "/RETURNS_CANCEL",
    express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  logWebhookPayload,
  handleReturnsCancel
);

router.post(
  "/RETURNS_CLOSE",
   express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  logWebhookPayload,
  handleReturnsClose
);

router.post(
  "/RETURNS_REOPEN",
    express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  logWebhookPayload,
  handleReturnsReopen
);

router.post(
  "/RETURNS_REQUEST",
    express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  logWebhookPayload,
  handleReturnsRequest
);

router.post(
  "/RETURNS_PROCESS",
    express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  Auth.verifyWebhook,
  logWebhookPayload,
  handleReturnsProcess
);



// Isolated from Shopify and customer-payment webhooks; this route receives raw bytes.
router.post('/merchant-billing-stripe', express.raw({ type: 'application/json', limit: '2mb' }),
    require('../../utils/merchantBillingWebhook')());

module.exports = router;
