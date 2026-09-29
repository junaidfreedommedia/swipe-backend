const customerSchema = Models.Customer;
const orderSchema = Models.Order;

const Customer = {};

const normalizeEmail = (email = "") =>
  typeof email === "string" ? email.trim().toLowerCase() : "";

const buildCustomerPayloadFromOrder = (order = {}) => {
  const email = normalizeEmail(order?.customer?.email);
  const customerId = order?.customer?.id;

  if (!email || !customerId || !order?.merchant) {
    return null;
  }

  return {
    merchant: order.merchant,
    id: customerId,
    email,
    firstName: order?.customer?.first_name || "",
    lastName: order?.customer?.last_name || "",
    phone:
      order?.customer?.phone ||
      order?.billing_address?.phone ||
      order?.shipping_address?.phone ||
      "",
    admin_graphql_api_id: order?.customer?.admin_graphql_api_id || "",
    state: order?.customer?.state || "",
    verified_email: Boolean(order?.customer?.verified_email),
    tags: order?.customer?.tags || "",
    currency: order?.customer?.currency || order?.currency || "",
    customer_created_at:
      order?.customer?.customer_created_at || order?.createdAt || null,
    billing_address: order?.billing_address || order?.shipping_address || null,
  };
};

Customer.normalizeEmail = normalizeEmail;

Customer.get = async (condition, projection, options = { lean: true }) => {
  return customerSchema.findOne(condition, projection, options);
};

Customer.getAll = async (condition, projection, options = { lean: true }) => {
  return customerSchema.find(condition, projection, options);
};

Customer.aggregate = async (pipeline) => {
  return customerSchema.aggregate(pipeline);
};

Customer.bulkWrite = async (operations) => {
  if (!Array.isArray(operations) || operations.length === 0) return null;
  return customerSchema.bulkWrite(operations, { ordered: false });
};

Customer.upsertFromOrder = async (order) => {
  const payload = buildCustomerPayloadFromOrder(order);
  if (!payload) return null;

  return customerSchema.findOneAndUpdate(
    { merchant: payload.merchant, id: payload.id },
    { $set: payload },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

Customer.backfillFromOrders = async (condition = {}, options = {}) => {
  const baseFilters = [
    condition,
    { "customer.email": { $exists: true, $ne: null, $ne: "" } },
    { "customer.id": { $exists: true, $ne: null } },
  ];

  const orders = await orderSchema.find(
    { $and: baseFilters },
    {
      merchant: 1,
      customer: 1,
      billing_address: 1,
      shipping_address: 1,
      currency: 1,
      createdAt: 1,
    },
    {
      lean: true,
      sort: { createdAt: -1 },
      ...(options.limit ? { limit: options.limit } : {}),
    }
  );

  const seen = new Set();
  const operations = [];

  for (const order of orders) {
    const payload = buildCustomerPayloadFromOrder(order);
    if (!payload) continue;

    const dedupeKey = `${payload.merchant}:${payload.id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    operations.push({
      updateOne: {
        filter: { merchant: payload.merchant, id: payload.id },
        update: { $set: payload },
        upsert: true,
      },
    });
  }

  if (operations.length > 0) {
    await customerSchema.bulkWrite(operations, { ordered: false });
  }

  return operations.length;
};

module.exports = Customer;
