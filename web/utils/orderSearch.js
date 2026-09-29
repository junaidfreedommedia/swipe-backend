const EMAIL_SEARCH_COLLATION = { locale: "en", strength: 2 };
const EMAIL_SEARCH_INDEX = "order_email_case_insensitive_idx";

async function buildOrderSearchFilter(search, orders) {
  if (!search) return {};
  const value = search.trim();
  if (/^\d+$/.test(value)) return { order_number: Number(value) };

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    // Resolve stored casing through the case-insensitive index first. Keep the
    // final order query's default collation so status/tag filters do not change.
    // Do not use distinct with this collation: it collapses differently-cased
    // stored addresses, which would lose orders in the final binary lookup.
    const matches = await orders
      .find({ "customer.email": value })
      .select({ _id: 0, "customer.email": 1 })
      .collation(EMAIL_SEARCH_COLLATION)
      .lean();
    const emails = [...new Set(matches.map((order) => order.customer.email))];
    return { "customer.email": { $in: emails } };
  }

  // Preserve partial email and customer-name searches.
  return {
    $or: [
      { "customer.email": { $regex: "^" + value, $options: "i" } },
      { "customer.name": { $regex: "^" + value, $options: "i" } },
    ],
  };
}

module.exports = { buildOrderSearchFilter, EMAIL_SEARCH_COLLATION, EMAIL_SEARCH_INDEX };
