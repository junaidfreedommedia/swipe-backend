const EasyPost = require("@easypost/api");

const SHOPIFY_LOCATION_QUERY = `
  query SwipeReturnLocation($id: ID!) {
    location(id: $id) {
      id
      name
      address {
        address1
        address2
        city
        province
        provinceCode
        country
        countryCode
        zip
        phone
      }
    }
  }
`;

let easyPostClient;

const getEasyPostClient = () => {
  if (!process.env.EASYPOST_API_KEY) {
    throw new Error("EASYPOST_API_KEY is not configured");
  }

  if (!easyPostClient) {
    easyPostClient = new EasyPost(process.env.EASYPOST_API_KEY);
  }

  return easyPostClient;
};

const clean = (value) => {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
};

const compactObject = (value) =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );

const normalizeEasyPostAddress = (address = {}, fallback = {}) =>
  compactObject({
    name: clean(address.name || fallback.name),
    company: clean(address.company || fallback.company),
    street1: clean(
      address.street1 ||
        address.address1 ||
        fallback.street1 ||
        fallback.address1
    ),
    street2: clean(
      address.street2 ||
        address.address2 ||
        fallback.street2 ||
        fallback.address2
    ),
    city: clean(address.city || fallback.city),
    state: clean(
      address.state ||
        address.provinceCode ||
        address.province ||
        fallback.state ||
        fallback.province_code ||
        fallback.province
    ),
    zip: clean(address.zip || fallback.zip),
    country: clean(
      address.countryCode ||
        address.country ||
        fallback.countryCode ||
        fallback.country_code ||
        fallback.country
    ),
    phone: clean(address.phone || fallback.phone || fallback.phone_no),
    email: clean(address.email || fallback.email),
  });

const assertCompleteAddress = (address, label) => {
  const required = ["street1", "city", "zip", "country"];
  const missing = required.filter((field) => !address?.[field]);

  if (missing.length) {
    throw new Error(`${label} is missing: ${missing.join(", ")}`);
  }
};

const toShopifyLocationGid = (locationId) => {
  const value = clean(locationId);
  if (!value) return null;
  if (value.startsWith("gid://shopify/Location/")) return value;
  return `gid://shopify/Location/${value}`;
};

const getShopifyReturnAddress = async ({
  session,
  merchant = {},
  graphqlClient,
}) => {
  const fallbackAddress = normalizeEasyPostAddress({}, {
    ...merchant,
    name: merchant.name || merchant.shop_owner,
    company: merchant.name,
  });
  const locationId = toShopifyLocationGid(merchant.primary_location_id);

  if (!locationId) {
    assertCompleteAddress(fallbackAddress, "Shopify return address");
    return fallbackAddress;
  }

  if (!session && !graphqlClient) {
    throw new Error("Shopify session is required to load the primary location");
  }

  const client = graphqlClient || (() => {
    const shopify = require("../shopify.js");
    return new shopify.api.clients.Graphql({ session });
  })();

  try {
    const response = await client.request(SHOPIFY_LOCATION_QUERY, {
      variables: { id: locationId },
    });
    const location = response?.data?.location;
    const returnAddress = normalizeEasyPostAddress(location?.address, {
      ...merchant,
      name: location?.name || merchant.name || merchant.shop_owner,
      company: merchant.name,
    });

    assertCompleteAddress(returnAddress, "Shopify return address");
    return returnAddress;
  } catch (error) {
    assertCompleteAddress(fallbackAddress, "Shopify return address");
    return fallbackAddress;
  }
};

const normalizeParcel = (parcel = {}) => {
  const normalized = compactObject({
    length: Number(parcel.length) || undefined,
    width: Number(parcel.width) || undefined,
    height: Number(parcel.height) || undefined,
    weight: Number(parcel.weight) || undefined,
    predefined_package: clean(parcel.predefined_package),
  });

  if (!normalized.weight || normalized.weight <= 0) {
    throw new Error("Return parcel weight must be greater than zero");
  }

  return normalized;
};

const createReturnShipment = async (
  {
    customerAddress,
    returnAddress,
    parcel,
    reference,
    carrierAccountIds,
  },
  client = getEasyPostClient()
) => {
  const fromAddress = normalizeEasyPostAddress(customerAddress);
  const toAddress = normalizeEasyPostAddress(returnAddress);

  assertCompleteAddress(fromAddress, "Customer address");
  assertCompleteAddress(toAddress, "Return address");

  const shipment = compactObject({
    from_address: fromAddress,
    to_address: toAddress,
    parcel: normalizeParcel(parcel),
    is_return: true,
    reference: clean(reference),
    carrier_accounts:
      Array.isArray(carrierAccountIds) && carrierAccountIds.length
        ? carrierAccountIds
        : undefined,
  });

  return client.Shipment.create(shipment);
};

const purchaseReturnLabel = async (
  { shipmentId, rateId, insuranceAmount, includeQrCode = true },
  client = getEasyPostClient()
) => {
  if (!clean(shipmentId) || !clean(rateId)) {
    throw new Error("EasyPost shipmentId and rateId are required");
  }

  const purchasedShipment = await client.Shipment.buy(
    shipmentId,
    rateId,
    insuranceAmount || null
  );

  if (!includeQrCode) {
    return { shipment: purchasedShipment, qrCode: null };
  }

  try {
    const shipmentWithQrCode = await client.Shipment.generateForm(
      shipmentId,
      "label_qr_code"
    );
    const forms = Array.isArray(shipmentWithQrCode?.forms)
      ? shipmentWithQrCode.forms
      : [];
    const qrCode =
      forms.find((form) => form?.form_type === "label_qr_code") ||
      forms[forms.length - 1] ||
      null;

    return { shipment: shipmentWithQrCode, qrCode };
  } catch (error) {
    return {
      shipment: purchasedShipment,
      qrCode: null,
      qrCodeError: error.message,
    };
  }
};

const getTrackingStatus = async (order) => {
  const fulfillment = order?.fulfillments?.[0];
  const trackingNumber = fulfillment?.tracking_number;
  const carrier = fulfillment?.tracking_company;

  if (!trackingNumber) {
    return {
      status: "Pending",
      message: "No tracking information available for this order.",
      events: [],
    };
  }

  return {
    trackingNumber,
    carrier,
    status: "Fulfilled",
    message: "Tracking is available via the carrier using the tracking number.",
    events: [],
  };
};

module.exports = {
  SHOPIFY_LOCATION_QUERY,
  getEasyPostClient,
  normalizeEasyPostAddress,
  getShopifyReturnAddress,
  createReturnShipment,
  purchaseReturnLabel,
  getTrackingStatus,
};
