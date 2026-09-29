const Notifications = require("../utils/notification");

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const money = (amount, currency = "USD") =>
  `${escapeHtml(String(currency || "USD").toUpperCase())} ${Number(amount || 0).toFixed(2)}`;

const displayId = (value) => {
  const id = String(value || "").trim();
  return id && !id.startsWith("#") ? `#${id}` : id;
};

const storeFrom = (record, storeName) =>
  String(storeName || record?.store_name || record?.shop || "Store").trim();

const returnStatusUrl = (record) => {
  const host = String(process.env.FE_HOST || global.Config?.APP?.FE_HOST || "")
    .trim()
    .replace(/\/$/, "");
  const token = String(record?.public_token || "").trim();
  return host && token
    ? `${host}/returns/status/${encodeURIComponent(token)}`
    : "";
};

const detailCard = (rows = []) => `
  <div style="margin:0 0 20px;background:#fff;border:1px solid #E8E1D8;border-radius:16px;padding:16px;text-align:left;">
    ${rows
      .map(
        ([label, value]) =>
          `<p style="font-size:15px;line-height:23px;color:#40516F;margin:0 0 6px;"><strong>${escapeHtml(label)}:</strong> ${value}</p>`
      )
      .join("")}
  </div>`;

const itemTable = (items = []) => {
  if (!items.length) return "";
  const rows = items
    .map((item) => {
      const title = escapeHtml(
        item.replacement_product_title ||
          item.exchange_product_title ||
          item.item?.exchange_product_title ||
          item.item?.title ||
          item.title ||
          "Return item"
      );
      const variant = escapeHtml(
        item.replacement_variant_title ||
          item.exchange_variant_title ||
          item.item?.exchange_variant_title ||
          item.variant_title ||
          ""
      );
      const imageUrl = escapeHtml(
        item.replacement_product_image_url ||
          item.exchange_product_image_url ||
          item.item?.exchange_product_image_url ||
          item.item?.image_url ||
          item.image_url ||
          ""
      );
      const image = imageUrl
        ? `<img src="${imageUrl}" alt="${title}" width="44" height="44" style="width:44px;height:44px;border-radius:8px;object-fit:cover;border:1px solid #E8E1D8;display:block;">`
        : `<div style="width:44px;height:44px;border-radius:8px;background:#F8F6F7;border:1px solid #E8E1D8;"></div>`;
      return `<tr><td style="padding:12px 16px;border-bottom:1px solid #E8E1D8;color:#40516F;font-size:15px;line-height:22px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="width:52px;vertical-align:middle;">${image}</td><td style="vertical-align:middle;color:#40516F;font-size:15px;line-height:22px;">${title}${variant ? `<br><span style="font-size:13px;color:#6B7280;">${variant}</span>` : ""}</td></tr></table></td><td style="padding:12px 16px;border-bottom:1px solid #E8E1D8;color:#40516F;font-size:15px;line-height:22px;text-align:right;">${Number(item.quantity || 0)}</td></tr>`;
    })
    .join("");

  return `<div style="margin:0 0 20px;background:#fff;border:1px solid #E8E1D8;border-radius:16px;overflow:hidden;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr style="background:#F8F6F7;"><td style="padding:12px 16px;color:#40516F;font-size:14px;font-weight:700;">Item</td><td style="padding:12px 16px;color:#40516F;font-size:14px;font-weight:700;text-align:right;">Qty</td></tr>${rows}</table></div>`;
};

const send = async (options) => {
  const email = String(options.customerEmail || "").trim();
  if (!email) return { sent: false, reason: "missing_email" };
  try {
    await Notifications.sendNotification({
      subject: options.subject,
      to: [email],
      template: options.template,
      headline: options.headline,
      store_name: escapeHtml(options.storeName || "Store"),
      customer_name: escapeHtml(options.customerName || "Customer"),
      message: options.message,
      details_html: options.detailsHtml,
      action_html: options.actionHtml || "",
      footer_message: options.footerMessage,
    });
    return { sent: true };
  } catch (error) {
    if (global.Logger?.error) {
      global.Logger.error(`[Return Customer Email] ${options.template} failed: ${error.message}`);
    } else {
      console.error(`[Return Customer Email] ${options.template} failed:`, error.message);
    }
    return { sent: false, reason: "send_failed", error };
  }
};

const customerFrom = (record, fallback = {}) => ({
  email:
    fallback.email ||
    fallback.contact_email ||
    fallback.customer?.email ||
    record?.customer?.email,
  name:
    record?.customer?.name ||
    fallback.customer?.name ||
    [fallback.customer?.first_name, fallback.customer?.last_name].filter(Boolean).join(" ") ||
    "Customer",
});

const sendPaymentLink = ({ record, customerEmail, storeName, amount, currency, checkoutUrl }) => {
  const customer = customerFrom(record, { email: customerEmail });
  const store = storeFrom(record, storeName);
  const safeUrl = escapeHtml(checkoutUrl);
  return send({
    template: "RETURN_PAYMENT_CUSTOMER",
    subject: `${store}: Complete payment for return ${record.return_number}`,
    headline: "Complete Your Exchange Payment",
    storeName: store,
    customerEmail: customer.email,
    customerName: customer.name,
    message: "Your return credit has been applied. Please pay the remaining balance to complete your exchange.",
    detailsHtml: detailCard([
      ["Return", escapeHtml(displayId(record.return_number))],
      ["Amount due", money(amount, currency)],
    ]),
    actionHtml: `<p style="margin:28px 0 6px;text-align:center;"><a href="${safeUrl}" style="display:inline-block;background:#333333;color:#ffffff;padding:14px 24px;border-radius:8px;font-size:16px;font-weight:700;">Pay securely with Stripe</a></p><p style="font-size:13px;line-height:20px;color:#6B7280;text-align:center;margin:0;">This secure payment page is provided by Stripe.</p>`,
    footerMessage: "Once payment is received, your replacement order will be created automatically.",
  });
};

const sendApproved = ({ record, customerEmail, storeName, statusUrl }) => {
  const customer = customerFrom(record, { email: customerEmail });
  const store = storeFrom(record, storeName);
  const labelReady = Boolean(
    record?.easypost?.label_url ||
      record?.easypost?.label_pdf_url ||
      record?.easypost?.qr_code_url
  );
  const url = escapeHtml(statusUrl || returnStatusUrl(record));
  const actionHtml = url
    ? `<p style="margin:28px 0 6px;text-align:center;"><a href="${url}" style="display:inline-block;background:#333333;color:#ffffff;padding:14px 24px;border-radius:8px;font-size:16px;font-weight:700;">${labelReady ? "View return &amp; label" : "View return status"}</a></p>`
    : "";
  return send({
    template: "RETURN_APPROVED_CUSTOMER",
    subject: `${store}: Your return ${displayId(record.return_number)} has been approved`,
    headline: "Your Return Is Approved",
    storeName: store,
    customerEmail: customer.email,
    customerName: customer.name,
    message: labelReady
      ? "Your return has been approved and your return shipping label is ready."
      : "Your return has been approved. You can use the link below to view its latest status.",
    detailsHtml: detailCard([
      ["Return", escapeHtml(displayId(record.return_number))],
      ["Status", labelReady ? "Label ready" : "Approved"],
    ]),
    actionHtml,
    footerMessage: labelReady
      ? "Open your return page to view the QR code or download the printable label."
      : "Your return page will show the latest status and label as soon as it is available.",
  });
};

const sendDeclined = ({ record, customerEmail, storeName, statusUrl }) => {
  const customer = customerFrom(record, { email: customerEmail });
  const store = storeFrom(record, storeName);
  const url = escapeHtml(statusUrl || returnStatusUrl(record));
  return send({
    template: "RETURN_DECLINED_CUSTOMER",
    subject: `${store}: Your return ${displayId(record.return_number)} has been declined`,
    headline: "Your Return Request Has Been Declined",
    storeName: store,
    customerEmail: customer.email,
    customerName: customer.name,
    message: "After reviewing your return request, we are unable to approve it for the reason below.",
    detailsHtml: detailCard([
      ["Return", escapeHtml(displayId(record.return_number))],
      ["Status", "Declined"],
      ["Reason", escapeHtml(record.decline_reason || "").replace(/\r\n|\r|\n/g, "<br>")],
    ]),
    actionHtml: url
      ? `<p style="margin:28px 0 6px;text-align:center;"><a href="${url}" style="display:inline-block;background:#333333;color:#ffffff;padding:14px 24px;border-radius:8px;font-size:16px;font-weight:700;">View return details</a></p>`
      : "",
    footerMessage: "If you have questions about this decision, please contact the store and include your return number.",
  });
};

const sendFiled = ({ record, customerEmail, storeName, statusUrl }) => {
  const customer = customerFrom(record, { email: customerEmail });
  const store = storeFrom(record, storeName);
  const url = escapeHtml(statusUrl || returnStatusUrl(record));
  const actionHtml = url
    ? `<p style="margin:28px 0 6px;text-align:center;"><a href="${url}" style="display:inline-block;background:#333333;color:#ffffff;padding:14px 24px;border-radius:8px;font-size:16px;font-weight:700;">View return status</a></p>`
    : "";
  const returnedItems = (record.items || []).map((item) => ({
    title: item.title,
    variant_title: item.variant_title,
    image_url: item.image_url,
    quantity: item.quantity,
  }));
  return send({
    template: "RETURN_FILED_CUSTOMER",
    subject: `${store}: Return request ${displayId(record.return_number)} received`,
    headline: "Your Return Request Is Submitted",
    storeName: store,
    customerEmail: customer.email,
    customerName: customer.name,
    message: "We successfully received your return request. We will keep you updated as it moves forward.",
    detailsHtml:
      detailCard([
        ["Return", escapeHtml(displayId(record.return_number))],
        ["Return value", money(record.subtotal?.amount, record.subtotal?.currency)],
      ]) + itemTable(returnedItems),
    actionHtml,
    footerMessage: "Open your return page at any time to view its latest status.",
  });
};

const sendReplacementCreated = ({ record, customerEmail, storeName, replacementOrder, items, total, currency }) => {
  const customer = customerFrom(record, { email: customerEmail });
  const store = storeFrom(record, storeName);
  const replacementId =
    replacementOrder?.name || replacementOrder?.order_number || replacementOrder?.id || "";
  return send({
    template: "RETURN_REORDER_CUSTOMER",
    subject: `${store}: Your replacement order ${displayId(replacementId)} has been created`,
    headline: "Your Replacement Order Is Created",
    storeName: store,
    customerEmail: customer.email,
    customerName: customer.name,
    message: "We created the replacement order for your Swipe return.",
    detailsHtml:
      detailCard([
        ["Return", escapeHtml(displayId(record.return_number))],
        ["Replacement order", escapeHtml(displayId(replacementId))],
        ["Replacement value", money(total, currency)],
      ]) + itemTable(items),
    footerMessage: "Swipe is handling the replacement for you. We will keep your experience simple and worry-free.",
  });
};

const sendRefundProcessed = ({ record, customerEmail, storeName, items, amount, currency, creditRefund = false }) => {
  const customer = customerFrom(record, { email: customerEmail });
  const store = storeFrom(record, storeName);
  return send({
    template: "RETURN_REFUND_CUSTOMER",
    subject: `${store}: Your return refund has been processed`,
    headline: "Your Refund Is Processed",
    storeName: store,
    customerEmail: customer.email,
    customerName: customer.name,
    message: creditRefund
      ? "We refunded your remaining return credit to the original payment method."
      : "We processed the refund for the selected items in your Swipe return.",
    detailsHtml:
      detailCard([
        ["Return", escapeHtml(displayId(record.return_number))],
        ["Total refunded", money(amount, currency)],
      ]) + itemTable(items),
    footerMessage: "The time for funds to appear depends on the original payment provider.",
  });
};

module.exports = {
  customerFrom,
  itemTable,
  returnStatusUrl,
  storeFrom,
  sendApproved,
  sendDeclined,
  sendFiled,
  sendPaymentLink,
  sendRefundProcessed,
  sendReplacementCreated,
};
