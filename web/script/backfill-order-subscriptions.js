const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
process.env.ALLOW_CONFIG_MUTATIONS = "true";
require("../config/config");

const Models = require("../models");
const { fetchOrderLineItems, getLineItemSellingPlanTitle } = require("../utils/shopifyLineItems");

const shouldMarkSubscription = (lineItems = []) =>
  (Array.isArray(lineItems) ? lineItems : []).some((item) =>
    Boolean(getLineItemSellingPlanTitle(item))
  );

async function run() {
  try {
    const merchantCache = new Map();
    const sessionCache = new Map();

    const cursor = Models.Order.find(
      {
        $or: [
          { is_subscription: { $ne: true } },
          { "line_items.selling_plan_name": { $exists: false } },
        ],
      },
      {
        _id: 1,
        id: 1,
        admin_graphql_api_id: 1,
        merchant: 1,
        line_items: 1,
        is_subscription: 1,
      }
    )
      .lean()
      .cursor();

    let scanned = 0;
    let updated = 0;

    for await (const order of cursor) {
      scanned += 1;

      const merchantId = String(order.merchant || "");
      if (!merchantId) {
        continue;
      }

      let merchant = merchantCache.get(merchantId);
      if (!merchant) {
        merchant = await Models.Merchant.findById(order.merchant, { shop_id: 1 }).lean();
        merchantCache.set(merchantId, merchant || null);
      }
      if (!merchant?.shop_id) {
        continue;
      }

      let session = sessionCache.get(merchant.shop_id);
      if (!session) {
        session = await Models.ShopifySession.findOne({ shop: merchant.shop_id });
        sessionCache.set(merchant.shop_id, session || null);
      }
      if (!session) {
        continue;
      }

      const graphqlLineItems = await fetchOrderLineItems(
        session,
        order.admin_graphql_api_id || order.id
      );

      const mergedLineItems = (order.line_items || []).map((item) => {
        const graphItem = graphqlLineItems.get(String(item?.admin_graphql_api_id || ""));
        const sellingPlanName =
          item?.selling_plan_name ||
          graphItem?.sellingPlanName ||
          getLineItemSellingPlanTitle(item);

        return {
          ...item,
          ...(sellingPlanName ? { selling_plan_name: sellingPlanName } : {}),
        };
      });

      const isSubscription = shouldMarkSubscription(mergedLineItems);

      if (
        isSubscription !== Boolean(order.is_subscription) ||
        mergedLineItems.some((item, index) => item?.selling_plan_name !== order?.line_items?.[index]?.selling_plan_name)
      ) {
        await Models.Order.updateOne(
          { _id: order._id },
          {
            $set: {
              line_items: mergedLineItems,
              is_subscription: isSubscription,
            },
          }
        );
        updated += 1;
        console.log(`Updated order ${order.id} subscription=${isSubscription}`);
      }
    }

    console.log(`Subscription backfill complete. Scanned=${scanned}, Updated=${updated}`);
  } catch (error) {
    console.error("Subscription backfill failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

run();
