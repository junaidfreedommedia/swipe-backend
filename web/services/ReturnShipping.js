const {
  normalizeEasyPostAddress,
  getShopifyReturnAddress,
  createReturnShipment,
  purchaseReturnLabel,
} = require("../utils/easypost");

const ReturnShipping = {};

ReturnShipping.createLabel = async ({ merchant, order, policy, returnRecord }) => {
  if (returnRecord?.easypost?.shipment_id) return returnRecord;
  if (Number(returnRecord?.subtotal?.amount || 0) <= Number(policy.keep_item_max || 0)) {
    return returnRecord;
  }

  const shop = merchant.shop_id || merchant.myshopify_domain;
  const session = await Services.ShopifyReturns.getSession(shop);
  const returnAddress = policy.return_address?.enabled
    ? normalizeEasyPostAddress(policy.return_address)
    : await getShopifyReturnAddress({ session, merchant });
  const customerAddress = normalizeEasyPostAddress({
    ...order.shipping_address,
    name:
      order.shipping_address?.name ||
      order.customer?.name ||
      `${order.customer?.first_name || ""} ${order.customer?.last_name || ""}`.trim(),
    email: order.customer?.email,
    phone: order.shipping_address?.phone || order.customer?.phone,
  });
  const ounces = Math.max(1, Number(order.total_weight || 454) / 28.3495);
  const shipment = await createReturnShipment({
    customerAddress,
    returnAddress,
    parcel: { weight: Math.round(ounces * 100) / 100 },
    reference: returnRecord.return_number,
  });
  const lowestRate = (shipment.rates || [])
    .filter((rate) => Number.isFinite(Number(rate.rate)))
    .sort((a, b) => Number(a.rate) - Number(b.rate))[0];
  if (!lowestRate) throw new Error("EasyPost returned no rates");

  const purchased = await purchaseReturnLabel({
    shipmentId: shipment.id,
    rateId: lowestRate.id,
  });
  const purchasedShipment = purchased.shipment || {};
  const expiresAt = new Date(
    Date.now() + Number(policy.label_expiry_days || 14) * 24 * 60 * 60 * 1000
  );

  return Services.Return.attachLabel(returnRecord._id, {
    shipment_id: purchasedShipment.id || shipment.id,
    rate_id: lowestRate.id,
    carrier: lowestRate.carrier,
    service: lowestRate.service,
    tracking_code: purchasedShipment.tracking_code,
    tracker_id: purchasedShipment.tracker?.id,
    label_url: purchasedShipment.postage_label?.label_url,
    label_pdf_url: purchasedShipment.postage_label?.label_pdf_url,
    qr_code_url: purchased.qrCode?.form_url,
    postage_amount: Number(lowestRate.rate || 0),
    currency: lowestRate.currency,
    purchased_at: new Date(),
    label_expires_at: expiresAt,
  });
};

module.exports = ReturnShipping;
