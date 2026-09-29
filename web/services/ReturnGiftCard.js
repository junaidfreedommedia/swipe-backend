const crypto = require("crypto");
const shopify = require("../shopify");

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const fields = "id note lastCharacters initialValue { amount currencyCode } customer { id }";
const PREFLIGHT = `query ReturnGiftCardAccess($id: ID!) {
  currentAppInstallation { accessScopes { handle } }
  order(id: $id) { customer { id email } }
}`;
const FIND = `query ReturnGiftCardLookup($query: String!) {
  giftCards(first: 10, query: $query) { nodes { ${fields} } }
}`;
const CREATE = `mutation ReturnGiftCardCreate($input: GiftCardCreateInput!) {
  giftCardCreate(input: $input) { giftCard { ${fields} } userErrors { message } }
}`;
const NOTIFY = `mutation ReturnGiftCardNotify($id: ID!) {
  giftCardSendNotificationToCustomer(id: $id) { giftCard { id } userErrors { message } }
}`;

const request = async (client, query, variables, field) => {
  const result = await client.request(query, { variables });
  if (result.errors?.length || result.errors?.graphQLErrors?.length) {
    throw fail("Shopify could not confirm the gift card. Please retry to check its status.", 502);
  }
  const data = field ? result.data?.[field] : result.data;
  if (!data) throw fail("Shopify did not confirm the gift card. Please retry to check its status.", 502);
  if (data.userErrors?.length) throw fail(data.userErrors.map(error => error.message).join(" "));
  return data;
};

// A persisted, unique code is reused on EVERY attempt, including network timeouts.
// Shopify enforces code uniqueness; a lost response can never create a second card.
const issue = async (record) => {
  if (record.outcome !== "store_credit") throw fail("This action is only available for store credit returns.");
  if (!["received", "processed", "credited"].includes(record.status)) {
    throw fail("Mark the return as received before issuing store credit.");
  }
  if (!(record.items || []).length || record.items.some(item => item.resolution && !["pending", "store_credit"].includes(item.resolution))) {
    throw fail("Store credit cannot be issued after an item has been refunded or exchanged.");
  }
  const amount = Number(record.store_credit_total?.amount);
  const currency = String(record.store_credit_total?.currency || "").toUpperCase();
  if (!Number.isFinite(amount) || Number(amount.toFixed(2)) <= 0 || !/^[A-Z]{3}$/.test(currency)) {
    throw fail("This return does not have a valid store credit amount.");
  }
  if (record.gift_card_details?.status === "issued" && record.gift_card_details?.notification_sent_at) return record;
  const session = await Services.ShopifySession.get({ shop: record.shop });
  if (!session) throw fail("Reconnect this store to Shopify before issuing store credit.");
  // Pin only this feature; existing refund/exchange clients keep their API version.
  const client = new shopify.api.clients.Graphql({ session, apiVersion: "2026-07" });
  const orderId = String(record.shopify_order_id || "").match(/\d+$/)?.[0];
  if (!orderId) throw fail("The original Shopify order is missing.");
  const access = await request(client, PREFLIGHT, { id: `gid://shopify/Order/${orderId}` });
  const scopes = new Set((access.currentAppInstallation?.accessScopes || []).map(scope => scope.handle));
  if (!scopes.has("write_gift_cards") || !scopes.has("write_customers")) {
    throw fail("Reconnect the Shopify app and approve gift card and customer permissions before issuing store credit.");
  }
  const customer = access.order?.customer;
  if (!customer?.id || !customer.email) {
    throw fail("Add a customer profile with an email address to the original Shopify order before issuing store credit.");
  }

  const scope = { _id: record._id, merchant: record.merchant, outcome: "store_credit" };
  await Models.Return.updateOne({ ...scope, gift_card_code: { $exists: false } }, {
    $set: { gift_card_code: crypto.randomBytes(10).toString("hex").toUpperCase() },
  });
  const token = crypto.randomBytes(16).toString("hex");
  const now = new Date();
  const locked = await Models.Return.findOneAndUpdate({
    ...scope, status: { $in: ["received", "processed", "credited"] },
    "refund_operation.status": { $ne: "processing" },
    items: { $not: { $elemMatch: { resolution: { $nin: ["pending", "store_credit", null] } } } },
    $or: [{ "gift_card_details.lock_until": { $exists: false } }, { "gift_card_details.lock_until": { $lte: now } }],
  }, { $set: { "gift_card_details.lock_token": token, "gift_card_details.lock_until": new Date(now.getTime() + 120000) } }, { new: true })
    .select("+gift_card_code").lean();
  if (!locked) throw fail("Store credit is already processing. Please refresh before trying again.");
  const owned = { ...scope, "gift_card_details.lock_token": token };
  try {
    if (locked.gift_card_details?.status !== "issued") {
      if (!locked.gift_card_code) throw fail("The gift card reference is missing. Contact support before retrying.");
      const note = `Swipe return ${record._id}`;
      const found = await request(client, FIND, { query: locked.gift_card_code }, "giftCards");
      let card = found.nodes?.find(entry => entry.note === note && entry.lastCharacters?.toUpperCase() === locked.gift_card_code.slice(-4));
      if (!card) {
        const created = await request(client, CREATE, { input: {
          code: locked.gift_card_code, initialAmount: { amount: amount.toFixed(2), currencyCode: currency },
          customerId: customer.id, note,
        } }, "giftCardCreate");
        card = created.giftCard;
      }
      if (!card?.id || card.note !== note || card.customer?.id !== customer.id ||
          card.initialValue?.currencyCode !== currency || !Number.isFinite(Number(card.initialValue?.amount)) ||
          Math.abs(Number(card.initialValue?.amount) - amount) > 0.001) {
        throw fail("Gift card details need review in Shopify. No additional credit has been issued.");
      }
      const issuedAt = new Date();
      const saved = await Models.Return.updateOne(owned, { $set: {
        status: "credited", processed_at: issuedAt,
        "gift_card_details.status": "issued", "gift_card_details.id": card.id,
        "gift_card_details.last_characters": card.lastCharacters,
        "gift_card_details.amount": amount, "gift_card_details.currency": currency,
        "gift_card_details.customer_id": customer.id, "gift_card_details.email": customer.email,
        "gift_card_details.issued_at": issuedAt,
        "items.$[].resolution": "store_credit", "items.$[].resolved_at": issuedAt,
      }, $unset: { "gift_card_details.error": 1 }, $push: { timeline: {
        status: "credited", label: "Store credit issued", created_at: issuedAt,
        detail: `${currency} ${amount.toFixed(2)} issued as a Shopify gift card ending ${card.lastCharacters}.`,
      } } });
      if (!saved.matchedCount) throw fail("Gift card processing is still being confirmed. Please refresh.");
      locked.gift_card_details = { ...locked.gift_card_details, status: "issued", id: card.id };
    }
    if (!locked.gift_card_details.notification_sent_at) {
      try {
        const notification = await request(client, NOTIFY, { id: locked.gift_card_details.id }, "giftCardSendNotificationToCustomer");
        if (notification.giftCard?.id !== locked.gift_card_details.id) throw fail("Gift card email was not confirmed.");
        await Models.Return.updateOne(owned, { $set: { "gift_card_details.notification_sent_at": new Date() }, $unset: { "gift_card_details.notification_error": 1 } });
      } catch (_error) {
        await Models.Return.updateOne(owned, { $set: { "gift_card_details.notification_error": "Gift card issued, but its email was not confirmed. Retry sending the email." } });
      }
    }
  } catch (error) {
    await Models.Return.updateOne(owned, { $set: { "gift_card_details.error": "Gift card processing could not be confirmed. Retry to check Shopify using the same gift card reference." } });
    // Never include GraphQL request variables or the redeemable code in errors.
    const safeMessage = error.status === 409 ? String(error.message).split(locked.gift_card_code).join("[gift card code]")
      : "Gift card processing could not be confirmed. Please retry to check Shopify.";
    throw fail(safeMessage, error.status || 502);
  } finally {
    await Models.Return.updateOne(owned, { $unset: { "gift_card_details.lock_token": 1, "gift_card_details.lock_until": 1 } });
  }
  return Services.Return.get({ _id: record._id, merchant: record.merchant });
};

module.exports = { issue };
