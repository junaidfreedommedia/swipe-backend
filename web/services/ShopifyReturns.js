const shopify = require("../shopify.js");

const ShopifyReturns = {};

const RETURNABLE_FULFILLMENTS_QUERY = `
  query SwipeReturnableFulfillments($orderId: ID!) {
    returnableFulfillments(orderId: $orderId, first: 50) {
      nodes {
        id
        fulfillment {
          id
          displayStatus
        }
        returnableFulfillmentLineItems(first: 100) {
          nodes {
            quantity
            fulfillmentLineItem {
              id
              quantity
              lineItem {
                id
                name
                sku
                quantity
                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                image {
                  url
                }
                 variant {
                   id
                   title
                   product {
                     id
                     title
                     tags
                     variants(first: 100) {
                       nodes {
                         id
                         title
                         sku
                         price
                         inventoryQuantity
                         inventoryPolicy
                         inventoryItem {
                           tracked
                         }
                         selectedOptions {
                           name
                           value
                         }
                         image {
                           url
                         }
                       }
                     }
                   }
                 }
              }
            }
          }
        }
      }
    }
  }
`;

const PRODUCT_VARIANTS_QUERY = `
  query SwipeReturnProductVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        status
        tags
        featuredImage { url }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            inventoryQuantity
            inventoryPolicy
            inventoryItem {
              tracked
            }
            selectedOptions {
              name
              value
            }
            image {
              url
            }
          }
        }
      }
    }
  }
`;

// Some older store installations do not have the inventory permission on their
// saved access token. The size/color list itself must still remain available.
const PRODUCT_VARIANTS_BASIC_QUERY = `
  query SwipeReturnProductVariantsBasic($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        status
        tags
        featuredImage { url }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            selectedOptions {
              name
              value
            }
            image {
              url
            }
          }
        }
      }
    }
  }
`;

const PRODUCT_CATALOG_QUERY = `
  query SwipeReturnProductCatalog($first: Int!, $query: String!) {
    products(first: $first, query: $query, sortKey: TITLE) {
      nodes {
        id
        title
        status
        tags
        featuredImage { url }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            inventoryQuantity
            inventoryPolicy
            inventoryItem { tracked }
            selectedOptions { name value }
            image { url }
          }
        }
      }
    }
  }
`;

const PRODUCT_CATALOG_BASIC_QUERY = `
  query SwipeReturnProductCatalogBasic($first: Int!, $query: String!) {
    products(first: $first, query: $query, sortKey: TITLE) {
      nodes {
        id
        title
        status
        tags
        featuredImage { url }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            selectedOptions { name value }
            image { url }
          }
        }
      }
    }
  }
`;

const RETURN_CALCULATE_QUERY = `
  query SwipeReturnCalculate($input: CalculateReturnInput!) {
    returnCalculate(input: $input) {
      id
      returnLineItems {
        quantity
        fulfillmentLineItem {
          id
        }
      }
      exchangeLineItems {
        quantity
      }
      returnShippingFee {
        amountSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

const RETURN_REQUEST_MUTATION = `
  mutation SwipeReturnRequest($input: ReturnRequestInput!) {
    returnRequest(input: $input) {
      return {
        id
        name
        status
         returnLineItems(first: 100) {
           nodes {
             id
             quantity
           }
         }
      }
      userErrors { field message }
    }
  }
`;

const RETURN_CREATE_MUTATION = `
  mutation SwipeReturnCreate($input: ReturnInput!) {
    returnCreate(returnInput: $input) {
      return {
        id
        name
        status
         returnLineItems(first: 100) {
           nodes {
             id
             quantity
           }
         }
      }
      userErrors { field message }
    }
  }
`;

const RETURN_APPROVE_MUTATION = `
  mutation SwipeReturnApprove($input: ReturnApproveRequestInput!) {
    returnApproveRequest(input: $input) {
      return { id name status }
      userErrors { field message }
    }
  }
`;

const RETURN_DECLINE_MUTATION = `
  mutation SwipeReturnDecline($input: ReturnDeclineRequestInput!) {
    returnDeclineRequest(input: $input) {
      return { id name status decline { reason } }
      userErrors { field message }
    }
  }
`;

const getSession = async (shop) => {
  const normalized = String(shop || "").trim().toLowerCase();
  if (!normalized) throw new Error("Shopify shop is required");
  const session = await Models.ShopifySession.getShopifySession(
    normalized,
    "offline"
  );
  if (!session) throw new Error("Shopify session not found");
  return session;
};

const getClient = (session) => new shopify.api.clients.Graphql({ session });

const assertNoUserErrors = (payload, operation) => {
  const errors = Array.isArray(payload?.userErrors) ? payload.userErrors : [];
  if (errors.length) {
    throw new Error(
      `${operation}: ${errors.map((error) => error.message).join(", ")}`
    );
  }
  return payload?.return;
};

const normalizeExchangeVariants = (product, currentVariant, lineItem) => {
  const nodes = product?.variants?.nodes || [];
  const variants = nodes.map((variant) => {
    const inventoryQuantity = Number(variant?.inventoryQuantity || 0);
    const inventoryTracked = variant?.inventoryItem?.tracked === true;
    const inventoryPolicy = String(variant?.inventoryPolicy || "DENY");
    const selectedOptions = Array.isArray(variant?.selectedOptions)
      ? variant.selectedOptions
          .filter((option) => option?.name && option?.value)
          .map((option) => ({ name: option.name, value: option.value }))
      : [];
    const optionTitle = selectedOptions
      .map((option) => `${option.name}: ${option.value}`)
      .join(" / ");

    return {
      id: variant.id,
      title:
        optionTitle ||
        (String(variant.title || "").toLowerCase() === "default title"
          ? product?.title || lineItem?.name || "Standard"
          : variant.title),
      variant_title: variant.title,
      sku: variant.sku || "",
      unit_price: Number(variant.price || 0),
      image_url: variant.image?.url || lineItem?.image?.url || "",
      selected_options: selectedOptions,
      inventory_quantity: inventoryQuantity,
      inventory_tracked: inventoryTracked,
      inventory_policy: inventoryPolicy,
      available:
        !inventoryTracked || inventoryPolicy === "CONTINUE" || inventoryQuantity > 0,
    };
  });

  if (variants.length) return variants;

  return currentVariant?.id
    ? [
        {
          id: currentVariant.id,
          title: currentVariant.title || "Standard",
          variant_title: currentVariant.title || "",
          sku: lineItem?.sku || "",
          unit_price: Number(
            lineItem?.originalUnitPriceSet?.shopMoney?.amount || 0
          ),
          image_url: lineItem?.image?.url || "",
          selected_options: [],
          inventory_quantity: null,
          inventory_tracked: false,
          inventory_policy: "CONTINUE",
          available: true,
        },
      ]
    : [];
};

const productGid = (value) => {
  const id = String(value || "").trim();
  if (!id) return null;
  return id.startsWith("gid://shopify/Product/")
    ? id
    : `gid://shopify/Product/${id.split("/").pop()}`;
};

ShopifyReturns.getSession = getSession;

ShopifyReturns.getReturnableItems = async ({ shop, orderId, client }) => {
  const graphqlClient = client || getClient(await getSession(shop));
  const response = await graphqlClient.request(RETURNABLE_FULFILLMENTS_QUERY, {
    variables: { orderId },
  });
  const fulfillments = response?.data?.returnableFulfillments?.nodes || [];

  return fulfillments.flatMap((returnableFulfillment) =>
    (returnableFulfillment?.returnableFulfillmentLineItems?.nodes || []).map(
      (node) => {
        const fulfillmentLineItem = node.fulfillmentLineItem || {};
        const lineItem = fulfillmentLineItem.lineItem || {};
        const variant = lineItem.variant || {};
        const product = variant.product || {};
         return {
          fulfillment_line_item_id: fulfillmentLineItem.id,
          line_item_graphql_id: lineItem.id,
          line_item_id: String(lineItem.id || "").split("/").pop(),
          max_quantity: node.quantity,
          title: lineItem.name,
          sku: lineItem.sku,
          image_url: lineItem.image?.url,
          unit_price: Number(
            lineItem.originalUnitPriceSet?.shopMoney?.amount || 0
          ),
          currency:
            lineItem.originalUnitPriceSet?.shopMoney?.currencyCode || "USD",
          variant_id: variant.id,
          variant_title: variant.title,
           product_id: product.id,
           product_tags: product.tags || [],
           exchange_variants: normalizeExchangeVariants(
             product,
             variant,
             lineItem
           ),
           fulfillment_status: returnableFulfillment.fulfillment?.displayStatus,
         };
      }
    )
  );
};

ShopifyReturns.getExchangeVariants = async ({ shop, productIds, client }) => {
  const ids = [
    ...new Set(
      (Array.isArray(productIds) ? productIds : [])
        .map(productGid)
        .filter(Boolean)
    ),
  ];
  if (!ids.length) return [];

  const graphqlClient = client || getClient(await getSession(shop));
  let response;
  let inventoryAvailable = true;

  try {
    response = await graphqlClient.request(PRODUCT_VARIANTS_QUERY, {
      variables: { ids },
    });
  } catch (error) {
    inventoryAvailable = false;
    response = await graphqlClient.request(PRODUCT_VARIANTS_BASIC_QUERY, {
      variables: { ids },
    });
  }

  return (response?.data?.nodes || [])
    .filter((product) => product?.id)
    .map((product) => ({
      product_id: product.id,
      product_title: product.title,
      product_status: product.status,
      product_image_url: product.featuredImage?.url || "",
      product_tags: product.tags || [],
      exchange_variants: normalizeExchangeVariants(product, null, {
        name: product.title,
      }).map((variant) => ({
        ...variant,
        inventory_available: inventoryAvailable,
      })),
    }));
};

ShopifyReturns.searchExchangeProducts = async ({
  shop,
  search,
  limit = 30,
  client,
}) => {
  const graphqlClient = client || getClient(await getSession(shop));
  const safeSearch = String(search || "")
    .replace(/[^a-zA-Z0-9 _-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const variables = {
    first: Math.min(50, Math.max(1, Number(limit) || 30)),
    query: safeSearch ? `status:active ${safeSearch}` : "status:active",
  };
  let response;
  let inventoryAvailable = true;

  try {
    response = await graphqlClient.request(PRODUCT_CATALOG_QUERY, { variables });
  } catch (error) {
    inventoryAvailable = false;
    response = await graphqlClient.request(PRODUCT_CATALOG_BASIC_QUERY, {
      variables,
    });
  }

  return (response?.data?.products?.nodes || [])
    .filter(
      (product) =>
        product?.id && String(product.status || "ACTIVE").toUpperCase() === "ACTIVE"
    )
    .map((product) => ({
      product_id: product.id,
      product_title: product.title,
      product_status: product.status,
      product_image_url:
        product.featuredImage?.url || product.variants?.nodes?.[0]?.image?.url || "",
      product_tags: product.tags || [],
      exchange_variants: normalizeExchangeVariants(product, null, {
        name: product.title,
        image: product.featuredImage,
      }).map((variant) => ({
        ...variant,
        inventory_available: inventoryAvailable,
      })),
    }))
    .filter((product) =>
      product.exchange_variants.some((variant) => variant.available !== false)
    );
};

const buildLineItems = (items, forRequest) =>
  items.map((item) => {
    const common = {
      fulfillmentLineItemId: item.fulfillment_line_item_id,
      quantity: Number(item.quantity),
      returnReason: item.shopify_reason || "OTHER",
    };
    if (!forRequest && item.restocking_fee_percent > 0) {
      common.restockingFee = {
        percentage: Number(item.restocking_fee_percent),
      };
    }
    if (forRequest) common.customerNote = item.customer_note || item.reason_label;
    else common.returnReasonNote = item.customer_note || item.reason_label;
    return common;
  });

ShopifyReturns.calculate = async ({
  shop,
  orderId,
  items,
  exchangeItems = [],
  shippingFee,
  currency,
  client,
}) => {
  if (!items.every((item) => item.fulfillment_line_item_id)) return null;
  const graphqlClient = client || getClient(await getSession(shop));
  const input = {
    orderId,
    returnLineItems: items.map((item) => ({
      fulfillmentLineItemId: item.fulfillment_line_item_id,
      quantity: Number(item.quantity),
      ...(item.restocking_fee_percent > 0
        ? { restockingFee: { percentage: item.restocking_fee_percent } }
        : {}),
    })),
    exchangeLineItems: exchangeItems
      .filter((item) => item.variant_id)
      .map((item) => ({
        variantId: item.variant_id,
        quantity: Number(item.quantity),
      })),
    ...(shippingFee > 0
      ? {
          returnShippingFee: {
            amount: { amount: shippingFee, currencyCode: currency },
          },
        }
      : {}),
  };
  const response = await graphqlClient.request(RETURN_CALCULATE_QUERY, {
    variables: { input },
  });
  return response?.data?.returnCalculate || null;
};

ShopifyReturns.submit = async ({
  shop,
  orderId,
  items,
  outcome,
  autoApprove,
  shippingFee,
  currency,
  client,
}) => {
  if (!items.every((item) => item.fulfillment_line_item_id)) {
    return { skipped: true, reason: "Fulfillment line item IDs are unavailable" };
  }
  const graphqlClient = client || getClient(await getSession(shop));

  if (!autoApprove) {
    const input = {
      orderId,
      returnLineItems: buildLineItems(items, true),
    };
    const response = await graphqlClient.request(RETURN_REQUEST_MUTATION, {
      variables: { input },
    });
    return assertNoUserErrors(response?.data?.returnRequest, "Return request");
  }

  const input = {
    orderId,
    requestedAt: new Date().toISOString(),
    returnLineItems: buildLineItems(items, false),
    ...(outcome === "exchange"
      ? {
          exchangeLineItems: items
            .filter((item) => item.exchange_variant_id)
            .map((item) => ({
              variantId: item.exchange_variant_id,
              quantity: Number(item.quantity),
            })),
        }
      : {}),
    ...(shippingFee > 0
      ? {
          returnShippingFee: {
            amount: { amount: shippingFee, currencyCode: currency },
          },
        }
      : {}),
  };
  const response = await graphqlClient.request(RETURN_CREATE_MUTATION, {
    variables: { input },
  });
  return assertNoUserErrors(response?.data?.returnCreate, "Return creation");
};

ShopifyReturns.approve = async ({ shop, returnId, client }) => {
  const graphqlClient = client || getClient(await getSession(shop));
  const response = await graphqlClient.request(RETURN_APPROVE_MUTATION, {
    variables: { input: { id: returnId } },
  });
  return assertNoUserErrors(
    response?.data?.returnApproveRequest,
    "Return approval"
  );
};

ShopifyReturns.decline = async ({
  shop,
  returnId,
  reason = "OTHER",
  client,
}) => {
  const graphqlClient = client || getClient(await getSession(shop));
  const response = await graphqlClient.request(RETURN_DECLINE_MUTATION, {
    variables: { input: { id: returnId, declineReason: reason } },
  });
  return assertNoUserErrors(
    response?.data?.returnDeclineRequest,
    "Return decline"
  );
};

module.exports = ShopifyReturns;
