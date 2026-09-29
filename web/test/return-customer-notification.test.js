const test = require("node:test");
const assert = require("node:assert/strict");
const Notifications = require("../utils/notification");
const ReturnCustomerNotification = require("../services/ReturnCustomerNotification");

const sentEmails = [];
Notifications.__setEmailProvider({
  send: async (...args) => {
    sentEmails.push(args);
  },
});

const record = {
  return_number: "2853",
  store_name: "Swipe Test Store",
  customer: {
    name: "Junaid & Co",
    email: "customer@example.com",
  },
};

test("renders the branded Stripe return payment email", async () => {
  sentEmails.length = 0;
  const result = await ReturnCustomerNotification.sendPaymentLink({
    record,
    customerEmail: record.customer.email,
    amount: 19.99,
    currency: "USD",
    checkoutUrl: "https://checkout.stripe.test/pay?id=1&source=return",
  });

  assert.equal(result.sent, true);
  assert.equal(sentEmails.length, 1);
  assert.deepEqual(sentEmails[0][0], ["customer@example.com"]);
  assert.match(sentEmails[0][2], /Complete Your Exchange Payment/);
  assert.match(sentEmails[0][1], /^Swipe Test Store:/);
  assert.match(sentEmails[0][2], /Swipe Test Store/);
  assert.match(sentEmails[0][2], /footer-logo-1\.png/);
  assert.doesNotMatch(sentEmails[0][2], /Group-482143\.png/);
  assert.match(sentEmails[0][2], /padding:0 30px 30px/);
  assert.match(sentEmails[0][2], /text-align:center;">&copy;/);
  assert.match(sentEmails[0][2], /USD 19\.99/);
  assert.match(sentEmails[0][2], /Pay securely with Stripe/);
  assert.match(sentEmails[0][2], /checkout\.stripe\.test\/pay\?id=1&amp;source=return/);
  assert.match(sentEmails[0][2], /Junaid &amp; Co/);
});

test("renders the approval email with a direct link to the label page", async () => {
  sentEmails.length = 0;
  const previousFrontendHost = process.env.FE_HOST;
  process.env.FE_HOST = "https://dashboard.swipe.ai/";
  const result = await ReturnCustomerNotification.sendApproved({
    record: {
      ...record,
      public_token: "public-return-token",
      easypost: { label_pdf_url: "https://labels.example/return.pdf" },
    },
  });
  if (previousFrontendHost === undefined) delete process.env.FE_HOST;
  else process.env.FE_HOST = previousFrontendHost;

  assert.equal(result.sent, true);
  assert.match(sentEmails[0][2], /Your Return Is Approved/);
  assert.match(sentEmails[0][2], /Label ready/);
  assert.match(sentEmails[0][2], /View return &amp; label/);
  assert.match(
    sentEmails[0][2],
    /https:\/\/dashboard\.swipe\.ai\/returns\/status\/public-return-token/
  );
});

test("sends the branded decline email to the customer with the saved reason and status link", async () => {
  sentEmails.length = 0;
  const result = await ReturnCustomerNotification.sendDeclined({
    record: {
      ...record,
      decline_reason: 'Outside the return window.\nItem marked <final-sale> & "non-returnable".',
    },
    storeName: "Merchant Store",
    statusUrl: "https://dashboard.swipe.ai/returns/status/declined-return-token",
  });

  assert.equal(result.sent, true);
  assert.equal(sentEmails.length, 1);
  assert.deepEqual(sentEmails[0][0], [record.customer.email]);
  assert.equal(sentEmails[0][1], "Merchant Store: Your return #2853 has been declined");
  const html = sentEmails[0][2];
  assert.match(html, /Your Return Request Has Been Declined/);
  assert.match(html, /Merchant Store/);
  assert.match(html, /Junaid &amp; Co/);
  assert.match(html, /Outside the return window\.<br>Item marked &lt;final-sale&gt; &amp; &quot;non-returnable&quot;\./);
  assert.doesNotMatch(html, /<final-sale>/);
  assert.match(html, /View return details/);
  assert.match(html, /returns\/status\/declined-return-token/);
  assert.match(html, /footer-logo-1\.png/);
  assert.doesNotMatch(html, /\[(?:HEADLINE|DETAILS_HTML|MESSAGE|CUSTOMER_NAME)\]/);
});

test("skips the decline email when the customer has no email address", async () => {
  sentEmails.length = 0;
  const result = await ReturnCustomerNotification.sendDeclined({
    record: { return_number: "2853", decline_reason: "Final sale" },
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "missing_email");
  assert.equal(sentEmails.length, 0);
});

test("renders a successful return-submission email with its status link", async () => {
  sentEmails.length = 0;
  const result = await ReturnCustomerNotification.sendFiled({
    record: {
      ...record,
      public_token: "filed-return-token",
      subtotal: { amount: 49.98, currency: "USD" },
      items: [
        {
          title: "Meadow Blush Bouquet",
          variant_title: "Medium",
          quantity: 2,
        },
      ],
    },
    statusUrl: "https://dashboard.swipe.ai/returns/status/filed-return-token",
  });

  assert.equal(result.sent, true);
  assert.match(sentEmails[0][1], /Return request #2853 received/);
  assert.match(sentEmails[0][2], /Your Return Request Is Submitted/);
  assert.match(sentEmails[0][2], /Swipe Test Store/);
  assert.match(sentEmails[0][2], /Meadow Blush Bouquet/);
  assert.match(sentEmails[0][2], /USD 49\.98/);
  assert.match(sentEmails[0][2], /returns\/status\/filed-return-token/);
});

test("renders the branded replacement-order email", async () => {
  sentEmails.length = 0;
  const result = await ReturnCustomerNotification.sendReplacementCreated({
    record,
    replacementOrder: { name: "#2854", email: record.customer.email },
    items: [
      {
        replacement_product_title: "Flowers",
        replacement_variant_title: "Large",
        quantity: 2,
      },
    ],
    total: 49.98,
    currency: "USD",
  });

  assert.equal(result.sent, true);
  assert.match(sentEmails[0][2], /Your Replacement Order Is Created/);
  assert.match(sentEmails[0][2], /#2854/);
  assert.match(sentEmails[0][2], /Flowers/);
  assert.match(sentEmails[0][2], /USD 49\.98/);
});

test("renders branded item and customer-credit refund emails", async () => {
  sentEmails.length = 0;
  await ReturnCustomerNotification.sendRefundProcessed({
    record,
    items: [{ item: { title: "Daisy Delight" }, quantity: 1 }],
    amount: 29.99,
    currency: "USD",
  });
  await ReturnCustomerNotification.sendRefundProcessed({
    record,
    items: [],
    amount: 39.98,
    currency: "USD",
    creditRefund: true,
  });

  assert.equal(sentEmails.length, 2);
  assert.match(sentEmails[0][2], /Your Refund Is Processed/);
  assert.match(sentEmails[0][2], /Daisy Delight/);
  assert.match(sentEmails[0][2], /USD 29\.99/);
  assert.match(sentEmails[1][2], /remaining return credit/);
  assert.match(sentEmails[1][2], /USD 39\.98/);
});

test("does not break the return action when email delivery fails", async () => {
  Notifications.__setEmailProvider({
    send: async () => {
      throw new Error("email provider unavailable");
    },
  });
  global.Logger = { error: () => {} };

  const result = await ReturnCustomerNotification.sendRefundProcessed({
    record,
    items: [],
    amount: 10,
    currency: "USD",
  });

  assert.equal(result.sent, false);
  assert.equal(result.reason, "send_failed");
  const declined = await ReturnCustomerNotification.sendDeclined({
    record: { ...record, decline_reason: "Final sale" },
  });
  assert.equal(declined.sent, false);
  assert.equal(declined.reason, "send_failed");
  delete global.Logger;
});
