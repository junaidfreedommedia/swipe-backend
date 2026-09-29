const TYPES = { refund: "Item refund", exchange: "Exchange value", payment: "Customer extra payment", credit_refund: "Exchange difference refunded", shipping: "Shipping label cost" };
const RESOLVED_STATUSES = ["exchanged", "refunded"];
const REPORT_TYPES = { payment: "Exchanged", refund: "Refunded" };
const isResolved = (status) => RESOLVED_STATUSES.includes(String(status || "").trim().toLowerCase());
const validAmount = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0;
const currencyCode = (v) => /^[A-Z]{3}$/.test(String(v || "").toUpperCase()) ? String(v).toUpperCase() : null;
const confirmedRefundAmount = (transactions) => Array.isArray(transactions) && transactions.length &&
  transactions.every((transaction) => transaction.status === "success" && validAmount(transaction.amount))
  ? transactions.reduce((sum, transaction) => sum + Number(transaction.amount), 0) : null;

// Policy quotes are not settled transactions.
const eventsFromDetails = (record) => {
  const events = [];
  const add = (type, ref, date, amount, currency, items = []) => {
    if (!ref || !date || Number.isNaN(new Date(date).getTime())) return;
    events.push({ key: `${type}:${ref}`, type, reference: String(ref), date: new Date(date), amount: validAmount(amount) ? Number(amount) : null,
      currency: currencyCode(currency), item_ids: items.map((item) => String(item.line_item_id)) });
  };
  const r = record.refund_details || {};
  if (r.shopify_refund_id) add("refund", r.shopify_refund_id, r.processed_at, r.amount, r.currency || record.subtotal?.currency, r.items);
  const c = record.credit_refund_details || {};
  if (c.status === "refunded") add("credit_refund", c.shopify_refund_id, c.processed_at, "settled_amount" in c ? c.settled_amount : c.amount, c.currency);
  const e = record.reorder_details || {};
  if (e.id && e.processed_at) add("exchange", e.id, e.processed_at, e.replacement_total, e.currency, e.items);
  if (["paid", "payment_received", "processing"].includes(e.payment_status) && e.stripe_checkout_session_id && Number(e.amount_due) > 0) {
    add("payment", e.stripe_checkout_session_id, e.stripe_paid_at || e.paid_at, "stripe_amount_paid" in e ? e.stripe_amount_paid : e.amount_due, e.currency);
  }
  const s = record.easypost || {};
  if (s.shipment_id) add("shipping", s.shipment_id, s.purchased_at || (record.timeline || []).find((t) => t.status === "label_ready")?.created_at, s.postage_amount, s.currency);
  return events;
};

const buildReport = (records, month, merchantName, generatedAt = new Date()) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Object.assign(new Error("Choose a valid month."), { status: 400 });
  const start = new Date(`${month}-01T00:00:00.000Z`), end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const rows = [], seen = new Set();
  for (const record of records) {
    if (!isResolved(record.status)) continue;
    const key = String(record._id || `${record.shop}:${record.return_number}`);
    if (seen.has(key)) continue;
    seen.add(key);
    const events = [...new Map([...(record.finance_events || []), ...eventsFromDetails(record)]
      .filter(e => ["refund", "credit_refund", "payment", "exchange"].includes(e.type))
      .map(e => [e.key, e])).values()];
    const finalDates = (record.timeline || []).filter(t => isResolved(t.status)).map(t => t.created_at);
    const dates = (finalDates.length ? finalDates : [record.processed_at, ...(record.items || []).map(i => i.resolved_at), ...events.map(e => e.date)])
      .map(d => d && new Date(d)).filter(d => d && !Number.isNaN(d.getTime()));
    if (!dates.length) continue;
    const completed = new Date(Math.max(...dates.map(d => d.getTime())));
    if (!(completed >= start && completed < end)) continue;
    const currency = currencyCode(record.subtotal?.currency) || events.map(e => currencyCode(e.currency)).find(Boolean) || null;
    const sum = (types, expected) => {
      const selected = events.filter(e => types.includes(e.type));
      if (!selected.length) return expected ? null : 0;
      if (selected.some(e => !validAmount(e.amount) || currencyCode(e.currency) !== currency)) return null;
      return selected.reduce((total, e) => total + Number(e.amount), 0);
    };
    const items = record.items || [];
    const refundEvents = events.filter(e => e.type === "refund");
    const covered = new Set(refundEvents.flatMap(e => e.item_ids || []));
    const missingRefundHistory = items.some(i => i.resolution === "refund" && !covered.has(String(i.line_item_id)));
    const totalValue = validAmount(record.subtotal?.amount) ? Number(record.subtotal.amount) :
      items.length && items.every(i => validAmount(i.unit_price) && Number(i.quantity) > 0) ? items.reduce((total, i) => total + Number(i.unit_price) * Number(i.quantity), 0) : null;
    const hasExchange = items.some(i => i.resolution === "reorder");
    const hasRefund = items.some(i => i.resolution === "refund");
    rows.push({ key, return_number: String(record.order?.name || record.return_number || "").replace(/-R\d+$/i, ""),
      status: record.status, created_at: record.createdAt || null, date: completed.toISOString(), currency,
      type: hasExchange && hasRefund ? "Exchange & Refund" : hasExchange || record.status === "exchanged" ? "Exchange" : "Refund",
      total_value: totalValue,
      refund: missingRefundHistory ? null : sum(["refund", "credit_refund"], hasRefund || record.status === "refunded"),
      stripe_charge: sum(["payment"], Number(record.reorder_details?.amount_due) > 0),
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  return resolvedSnapshot({ version: 4, month, merchant_name: merchantName, generated_at: generatedAt, timezone: "UTC", rows });
};

const resolvedSnapshot = (snapshot) => {
  if (snapshot.version !== 4) throw Object.assign(new Error("Generate this report again to include item totals, refunds and Stripe charges in the new format."), { status: 409 });
  const rows = (snapshot.rows || []).filter(row => isResolved(row.status));
  const totals = {};
  for (const row of rows) {
    if (!currencyCode(row.currency)) continue;
    if (!totals[row.currency]) totals[row.currency] = { total_value: 0, refund: 0, stripe_charge: 0 };
    for (const field of ["total_value", "refund", "stripe_charge"]) {
      if (validAmount(row[field])) totals[row.currency][field] += Number(row[field]);
    }
  }
  Object.values(totals).forEach(summary => Object.keys(summary).forEach(key => { summary[key] = Number(summary[key].toFixed(3)); }));
  return { ...snapshot, rows, totals, notes: [] };
};
module.exports = { TYPES, REPORT_TYPES, RESOLVED_STATUSES, eventsFromDetails, buildReport, resolvedSnapshot, confirmedRefundAmount };
