const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getShopifyReturnAddress,
  normalizeEasyPostAddress,
  createReturnShipment,
  purchaseReturnLabel,
} = require("./easypost");

test("normalizes Shopify address fields for EasyPost", () => {
  const address = normalizeEasyPostAddress({
    name: "Swipe Returns",
    address1: "123 Main St",
    address2: "Suite 4",
    city: "Austin",
    provinceCode: "TX",
    zip: "78701",
    countryCode: "US",
    phone: "+15125550123",
  });

  assert.deepEqual(address, {
    name: "Swipe Returns",
    street1: "123 Main St",
    street2: "Suite 4",
    city: "Austin",
    state: "TX",
    zip: "78701",
    country: "US",
    phone: "+15125550123",
  });
});

test("loads the Shopify primary location as the return address", async () => {
  let variables;
  const graphqlClient = {
    request: async (_query, options) => {
      variables = options.variables;
      return {
        data: {
          location: {
            name: "Main Warehouse",
            address: {
              address1: "500 Warehouse Way",
              city: "Dallas",
              provinceCode: "TX",
              zip: "75201",
              countryCode: "US",
            },
          },
        },
      };
    },
  };

  const address = await getShopifyReturnAddress({
    merchant: {
      primary_location_id: 987654,
      name: "Northside",
      email: "returns@example.com",
    },
    graphqlClient,
  });

  assert.deepEqual(variables, {
    id: "gid://shopify/Location/987654",
  });
  assert.deepEqual(address, {
    name: "Main Warehouse",
    company: "Northside",
    street1: "500 Warehouse Way",
    city: "Dallas",
    state: "TX",
    zip: "75201",
    country: "US",
    email: "returns@example.com",
  });
});

test("falls back to the saved Shopify shop address", async () => {
  const graphqlClient = {
    request: async () => {
      throw new Error("Shopify temporarily unavailable");
    },
  };

  const address = await getShopifyReturnAddress({
    merchant: {
      primary_location_id: 123,
      name: "Northside",
      address1: "10 Store Road",
      city: "Miami",
      province_code: "FL",
      zip: "33101",
      country_code: "US",
    },
    graphqlClient,
  });

  assert.equal(address.street1, "10 Store Road");
  assert.equal(address.city, "Miami");
  assert.equal(address.state, "FL");
});

test("creates a return shipment from customer to Shopify warehouse", async () => {
  let payload;
  const client = {
    Shipment: {
      create: async (shipment) => {
        payload = shipment;
        return { id: "shp_test", rates: [] };
      },
    },
  };

  const result = await createReturnShipment(
    {
      customerAddress: {
        name: "Jane Customer",
        street1: "1 Customer St",
        city: "Austin",
        state: "TX",
        zip: "78701",
        country: "US",
      },
      returnAddress: {
        company: "Northside",
        street1: "500 Warehouse Way",
        city: "Dallas",
        state: "TX",
        zip: "75201",
        country: "US",
      },
      parcel: { length: 12, width: 9, height: 4, weight: 32 },
      reference: "return-1042-R1",
    },
    client
  );

  assert.equal(result.id, "shp_test");
  assert.equal(payload.is_return, true);
  assert.equal(payload.from_address.name, "Jane Customer");
  assert.equal(payload.to_address.company, "Northside");
  assert.deepEqual(payload.parcel, {
    length: 12,
    width: 9,
    height: 4,
    weight: 32,
  });
});

test("buys a label and requests its QR form", async () => {
  const calls = [];
  const client = {
    Shipment: {
      buy: async (shipmentId, rateId) => {
        calls.push(["buy", shipmentId, rateId]);
        return { id: shipmentId, postage_label: { label_url: "label.pdf" } };
      },
      generateForm: async (shipmentId, type) => {
        calls.push(["form", shipmentId, type]);
        return {
          id: shipmentId,
          forms: [
            {
              form_type: "label_qr_code",
              form_url: "qr.png",
            },
          ],
        };
      },
    },
  };

  const result = await purchaseReturnLabel(
    { shipmentId: "shp_test", rateId: "rate_test" },
    client
  );

  assert.deepEqual(calls, [
    ["buy", "shp_test", "rate_test"],
    ["form", "shp_test", "label_qr_code"],
  ]);
  assert.equal(result.qrCode.form_url, "qr.png");
});
