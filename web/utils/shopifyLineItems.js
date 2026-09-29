const shopify = require("./../shopify");

const SHOPIFY_LINE_ITEM_DETAILS_QUERY = `
  query getLineItemCatalogDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on ProductVariant {
        id
        title
        sku
        selectedOptions {
          name
          value
        }
        image {
          url
        }
        product {
          id
          title
          vendor
          productType
          handle
          tags
          featuredImage {
            url
          }
        }
      }
      ... on Product {
        id
        title
        vendor
        productType
        handle
        tags
        featuredImage {
          url
        }
      }
    }
  }
`;

const SHOPIFY_ORDER_LINE_ITEMS_QUERY = `
  query getOrderLineItems($id: ID!) {
    order(id: $id) {
      lineItems(first: 100) {
        nodes {
          id
          customAttributes {
            key
            value
          }
          sellingPlan {
            name
          }
        }
      }
    }
  }
`;

const SHOPIFY_ORDER_PRICE_SUMMARY_QUERY = `
  query getOrderPriceSummary($id: ID!) {
    order(id: $id) {
      createdAt
      displayFinancialStatus
      originalTotalPriceSet {
        shopMoney { amount currencyCode }
      }
      totalReceivedSet {
        shopMoney { amount currencyCode }
      }
      currentSubtotalPriceSet {
        shopMoney { amount currencyCode }
      }
      currentTotalDiscountsSet {
        shopMoney { amount currencyCode }
      }
      currentShippingPriceSet {
        shopMoney { amount currencyCode }
      }
      currentTotalTaxSet {
        shopMoney { amount currencyCode }
      }
      currentTotalPriceSet {
        shopMoney { amount currencyCode }
      }
      currentSubtotalLineItemsQuantity
    }
  }
`;

const chunk = (items = [], size = 50) => {
  const chunks = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const extractNumericId = (gid = "") => {
  const match = String(gid).match(/(\d+)$/);
  return match ? match[1] : null;
};

const normalizeProperties = (properties = []) =>
  (Array.isArray(properties) ? properties : [])
    .map((property) => {
      const name = String(property?.name || "").trim();
      const value = String(property?.value || "").trim();

      if (!name || !value || name.startsWith("_")) {
        return null;
      }

      return { name, value };
    })
    .filter(Boolean);

const normalizeSelectedOptions = (selectedOptions = []) =>
  (Array.isArray(selectedOptions) ? selectedOptions : [])
    .map((option) => {
      const name = String(option?.name || "").trim();
      const value = String(option?.value || "").trim();

      if (!name || !value) {
        return null;
      }

      return { name, value };
    })
    .filter(Boolean);

const getLineItemSellingPlanTitle = (item = {}) => {
  const plan = item?.selling_plan_allocation?.selling_plan;
  const directName =
    plan?.name ||
    plan?.title ||
    item?.selling_plan_name ||
    item?.selling_plan_allocation?.name;

  if (directName) {
    return String(directName).trim();
  }

  const options = Array.isArray(plan?.options) ? plan.options : [];
  if (options.length > 0) {
    return options
      .map((option) => option?.value || option?.name || "")
      .filter(Boolean)
      .join(" / ");
  }

  return "";
};

const normalizeGraphqlCustomAttributes = (attributes = []) =>
  (Array.isArray(attributes) ? attributes : [])
    .map((attribute) => {
      const name = String(attribute?.key || "").trim();
      const value = String(attribute?.value || "").trim();

      if (!name || !value || name.startsWith("_")) {
        return null;
      }

      return { name, value };
    })
    .filter(Boolean);

const buildShopifyProductInfo = ({
  item = {},
  liveOrderItem = null,
  variantNode = null,
  productNode = null,
}) => {
  const resolvedProduct = variantNode?.product || productNode || null;
  const selectedOptions = normalizeSelectedOptions(variantNode?.selectedOptions);
  const variantTitle = String(
    variantNode?.title || item?.variant_title || ""
  ).trim();

  return {
    product_title: resolvedProduct?.title || item?.title || "",
    variant_title:
      variantTitle && variantTitle.toLowerCase() !== "default title"
        ? variantTitle
        : "",
    sku: variantNode?.sku || item?.sku || "",
    vendor: resolvedProduct?.vendor || item?.vendor || "",
    product_type: resolvedProduct?.productType || "",
    handle: resolvedProduct?.handle || "",
    tags: Array.isArray(resolvedProduct?.tags) ? resolvedProduct.tags : [],
    selected_options: selectedOptions,
    subscription_plan: getLineItemSellingPlanTitle(liveOrderItem || item),
  };
};

const fetchCatalogNodes = async (session, ids = []) => {
  const client = new shopify.api.clients.Graphql({ session });
  const nodes = [];

  for (const group of chunk(ids, 50)) {
    const response = await client.request(SHOPIFY_LINE_ITEM_DETAILS_QUERY, {
      variables: { ids: group },
    });

    nodes.push(...(response?.data?.nodes || []));
  }

  return nodes;
};

const fetchOrderLineItems = async (session, orderId) => {
  if (!orderId) {
    return new Map();
  }

  const client = new shopify.api.clients.Graphql({ session });
  const orderGid = String(orderId).startsWith("gid://shopify/Order/")
    ? String(orderId)
    : `gid://shopify/Order/${orderId}`;

  const response = await client.request(SHOPIFY_ORDER_LINE_ITEMS_QUERY, {
    variables: { id: orderGid },
  });

  const nodes = response?.data?.order?.lineItems?.nodes || [];

  return new Map(
    nodes.map((node) => [
      String(node?.id || ""),
      {
        sellingPlanName: String(node?.sellingPlan?.name || "").trim(),
        customAttributes: normalizeGraphqlCustomAttributes(node?.customAttributes),
      },
    ])
  );
};

const fetchShopifyOrderSnapshot = async (orderId, shopDomain) => {
  if (!orderId || !shopDomain) return null;

  try {
    const session = await Services.ShopifySession.get({ shop: shopDomain });
    if (!session) return null;

    const order = await shopify.api.rest.Order.find({
      session,
      id: orderId,
    });

    // Shopify Admin's financial summary is backed by the richer GraphQL
    // fields. In particular, originalTotalPriceSet is the immutable amount at
    // order creation and can differ from REST total_price after order edits.
    try {
      const client = new shopify.api.clients.Graphql({ session });
      const orderGid = String(orderId).startsWith("gid://shopify/Order/")
        ? String(orderId)
        : `gid://shopify/Order/${orderId}`;
      const response = await client.request(SHOPIFY_ORDER_PRICE_SUMMARY_QUERY, {
        variables: { id: orderGid },
      });
      const summary = response?.data?.order;

      if (summary) {
        order.shopify_price_summary = {
          status: String(summary.displayFinancialStatus || "")
            .toLowerCase(),
          created_at: summary.createdAt,
          original_order_amount:
            summary.originalTotalPriceSet?.shopMoney?.amount,
          paid_amount: summary.totalReceivedSet?.shopMoney?.amount,
          subtotal_amount:
            summary.currentSubtotalPriceSet?.shopMoney?.amount,
          discount_amount:
            summary.currentTotalDiscountsSet?.shopMoney?.amount,
          shipping_amount:
            summary.currentShippingPriceSet?.shopMoney?.amount,
          tax_amount: summary.currentTotalTaxSet?.shopMoney?.amount,
          total_amount: summary.currentTotalPriceSet?.shopMoney?.amount,
          item_count: summary.currentSubtotalLineItemsQuantity,
        };
      }
    } catch (summaryError) {
      console.error(
        "Failed to fetch Shopify GraphQL price summary:",
        summaryError.message
      );
    }

    // Transactions are not guaranteed to be embedded in the REST Order
    // response, but Shopify's price summary uses them for the Paid amount.
    try {
      const transactionResponse = await shopify.api.rest.Transaction.all({
        session,
        order_id: orderId,
      });
      order.transactions = Array.isArray(transactionResponse)
        ? transactionResponse
        : transactionResponse?.data || [];
    } catch (transactionError) {
      console.error(
        "Failed to fetch Shopify order transactions:",
        transactionError.message
      );
    }

    return order;
  } catch (error) {
    console.error("Failed to fetch live Shopify order:", error.message);
    return null;
  }
};

const enrichOrderLineItemsFromShopify = async (
  orderDetail,
  shopDomain,
  liveOrderSnapshot = null
) => {
  const lineItems = Array.isArray(orderDetail?.line_items) ? orderDetail.line_items : [];

  if (!shopDomain || lineItems.length === 0) {
    return lineItems.map((item) => ({
      ...item,
      properties: normalizeProperties(item?.properties),
      shopify_product_info: buildShopifyProductInfo({ item }),
    }));
  }

  try {
    const session = await Services.ShopifySession.get({ shop: shopDomain });
    if (!session) {
      return lineItems.map((item) => ({
        ...item,
        properties: normalizeProperties(item?.properties),
        shopify_product_info: buildShopifyProductInfo({ item }),
      }));
    }

    let liveOrderItemsById = new Map();
    let liveOrder = liveOrderSnapshot;
    if (!liveOrder && orderDetail?.id) {
      liveOrder = await shopify.api.rest.Order.find({
        session,
        id: orderDetail.id,
      });
    }

    if (liveOrder) {
      liveOrderItemsById = new Map(
        (Array.isArray(liveOrder?.line_items) ? liveOrder.line_items : []).map((item) => [
          String(item.id),
          item,
        ])
      );
    }

    const graphqlOrderLineItemsById = await fetchOrderLineItems(
      session,
      orderDetail?.admin_graphql_api_id || orderDetail?.id
    );

    const nodeIds = [
      ...new Set(
        lineItems.flatMap((item) => {
          const ids = [];

          if (item?.variant_id) {
            ids.push(`gid://shopify/ProductVariant/${item.variant_id}`);
          }
          if (item?.product_id) {
            ids.push(`gid://shopify/Product/${item.product_id}`);
          }

          return ids;
        })
      ),
    ];

    const fetchedNodes = nodeIds.length > 0 ? await fetchCatalogNodes(session, nodeIds) : [];
    const variantMap = new Map();
    const productMap = new Map();

    fetchedNodes.forEach((node) => {
      if (node?.__typename === "ProductVariant") {
        const id = extractNumericId(node.id);
        if (id) {
          variantMap.set(id, node);
        }
      }

      if (node?.__typename === "Product") {
        const id = extractNumericId(node.id);
        if (id) {
          productMap.set(id, node);
        }
      }
    });

    return lineItems.map((item) => {
      const liveOrderItem = liveOrderItemsById.get(String(item?.id || ""));
      const graphqlOrderLineItem = graphqlOrderLineItemsById.get(
        String(item?.admin_graphql_api_id || "")
      );
      const variantNode = variantMap.get(String(item?.variant_id || ""));
      const productNode =
        productMap.get(String(item?.product_id || "")) || variantNode?.product || null;

      return {
        ...item,
        image_url:
          item?.image_url ||
          variantNode?.image?.url ||
          productNode?.featuredImage?.url ||
          null,
        properties: normalizeProperties(
          Array.isArray(item?.properties) && item.properties.length > 0
            ? item.properties
            : liveOrderItem?.properties?.length
              ? liveOrderItem.properties
              : graphqlOrderLineItem?.customAttributes
        ),
        shopify_product_info: buildShopifyProductInfo({
          item,
          liveOrderItem: {
            ...liveOrderItem,
            selling_plan_name:
              liveOrderItem?.selling_plan_name ||
              graphqlOrderLineItem?.sellingPlanName,
          },
          variantNode,
          productNode,
        }),
      };
    });
  } catch (error) {
    console.error("Failed to enrich order line items from Shopify:", error.message);

    return lineItems.map((item) => ({
      ...item,
      properties: normalizeProperties(item?.properties),
      shopify_product_info: buildShopifyProductInfo({ item }),
    }));
  }
};

module.exports = {
  enrichOrderLineItemsFromShopify,
  fetchOrderLineItems,
  fetchShopifyOrderSnapshot,
  getLineItemSellingPlanTitle,
};
