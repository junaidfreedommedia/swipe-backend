# Finance billing controls

The Finance page now opens per-merchant Billing Controls. Existing merchants retain their original behavior until a Super Admin saves the new settings. Saving does not charge a card. For configured merchants, Generate Report is report-only; manual confirmation or the monthly scheduler creates the bill.

## Server configuration

- Use `STRIPE_SECRET_KEY` (or the existing `APP.STRIPE_API` configuration). The isolated client uses Stripe API version `2022-11-15`, matching the installed Stripe SDK, without changing existing Stripe integrations.
- Register `POST /v1/webhooks/merchant-billing-stripe` in the same Stripe account and mode as the secret key. Set its signing secret as `STRIPE_MERCHANT_BILLING_WEBHOOK_SECRET` on the backend. This route is mounted before JSON parsing and verifies raw-body signatures. Subscribe to `checkout.session.completed`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, and `invoice.marked_uncollectible`.
- Keep `REDIRECT_URL` pointed at the dashboard and existing SES email configuration working. Merchant billing uses the existing email sender, with errors propagated so pending emails can be retried.
- The existing app-process MongoCron runner installs a `MerchantBilling` job every 15 minutes. Workers do not start another scheduler. Only merchants with saved, enabled monthly settings are billed automatically. On an overdue day within the current month, it catches up the previous month. Longer historical gaps require explicit review/billing through Bill Now.
- Confirm Stripe/external billing is allowed for this app's distribution and merchant contract before rollout. Shopify App Store billing requirements still apply: https://shopify.dev/docs/apps/launch/billing.

## Merchant setup

1. Open Finance > Billing Controls and choose one merchant.
2. Select Manual, Stripe or Shopify, and choose manual click or monthly generation. Select the first unbilled month to exclude already-billed history. USD is the only supported statement currency; no implicit currency conversion is performed.
3. Set billing recipient, monthly day/time/timezone, invoice due days, review threshold and email preferences. Reporting retains its existing America/Chicago month boundaries; the schedule timezone only controls when it runs.
4. For auto-charge, create a card setup link and share it with the merchant. Stripe Checkout explicitly explains authorization for future monthly statement charges. Only a verified completed SetupIntent for this merchant's dedicated Stripe customer sets the authorized card; existing cards are not silently imported by matching email addresses.
5. Enable billing after configuring the webhook. Use Preview bill then Confirm & create bill for the first completed period. Preview returns the exact report calculation and a fingerprint; changes to the amount or settings invalidate confirmation.
6. For manual bills, record a received payment using its transaction reference and optional evidence note. Stripe bills are marked paid only using Stripe's current invoice state.

## Collection and emails

- Shopify uses the existing app billing plan (`BILLING_CONFIG`) and test/live setting (`IS_TEST_BILLING`). Save Shopify settings, create an approval link, share it with the merchant, then refresh approval status. Creating a link does not send email or charge the merchant. No Stripe webhook or saved card is needed for Shopify.
- Confirming a Shopify bill submits the frozen final net amount through `appUsageRecordCreate`. Shopify enforces its approved usage cap. Repeated attempts use the same persisted subscription line item and `swipe-bill:merchant:YYYY-MM` idempotency key, including after timeouts. API reference: https://shopify.dev/docs/api/admin-graphql/latest/mutations/appUsageRecordCreate.
- Accepted Shopify usage is recorded as `submitted_to_shopify`, not `paid`: Shopify collects it on the merchant's Shopify bill. Swipe can send the statement notice; payment receipts, collection reminders and retries are managed by Shopify. Pausing prevents new submissions but does not cancel existing Shopify charges. Resolve unsubmitted bills before switching providers.

- Without Stripe retries, auto-charge attempts the saved card once. With retries, Stripe schedules automatic collection and recovery using the account's Stripe settings; it may not charge immediately after invoice release.
- Payment-link mode creates a hosted invoice and Swipe emails the merchant the secure link when the statement-email preference is on. The invoice remains available in billing history if email is off.
- Swipe supports statement notices, payment receipts, failure/action emails and one due-date reminder. Statement notices precede saved-card attempts when enabled. These settings control Swipe's own emails. Review Stripe's account-level email settings to avoid duplicate provider messages: https://docs.stripe.com/invoicing/send-email.
- Pausing persists the local pause first and turns off advancement of open Stripe invoices. It cannot undo an in-flight payment or prevent the merchant from voluntarily paying an already-shared invoice link. If Stripe is temporarily unavailable, the modal reports the error; status refresh and the scheduler retry stopping advancement. Re-enabling does not silently resume old paused invoices: use Resume collection on the specific bill.
- Bills above the review threshold stop at `needs_review`. Zero or negative bills are report-only and never debit Stripe.

## Integrity and recovery

- Bills have a deterministic MongoDB primary key (`merchant:YYYY-MM`) and immutable amount/claim snapshots. Merchant locks serialize billing, settings migration and legacy Shopify charges. Stripe create/line/finalize/pay calls use deterministic idempotency keys. Repeated clicks resume the existing invoice.
- Existing bills retain their original collection method. Changing settings applies to future bills; the preview explicitly describes the selected bill's actual collection method. A paused unfinished draft must be previewed and confirmed again before release.
- Existing Shopify charges, ambiguous Shopify failures or older payment links block collection for that period. Resolve those in the original provider; do not delete records to bypass the check.
- If invoice creation times out and no invoice ID is saved for over 23 hours, automatic recreation stops because Stripe may expire idempotency keys after 24 hours. Reconcile the matching `swipe_billing_run` metadata in Stripe before repairing the stored association. Do not issue another invoice or delete the billing run.
- Invoice webhooks retrieve authoritative state, so delayed events cannot regress a paid invoice. Unrelated Stripe customer/exchange events are ignored by this endpoint. Billing status and hosted invoice links are displayed in Finance and the merchant's statements.
- Keep billing runs and billed statements for the audit trail. Regenerating a billed report uses its frozen amount and claims. Settings and bill operations have bounded audit history; older history can be archived separately.
- Email delivery is retried on failed sends with per-kind delivery markers. A process crash after SES accepts a message but before its marker is saved can resend that message; SES does not provide an exactly-once send guarantee. This never repeats the charge.

## Validation

`npm test` includes the existing tests and the new billing/state/report tests. Restricted Windows environments can use `node --test --experimental-test-isolation=none test/*.test.js` with Node 22 to avoid child-process restrictions.

Dashboard: `npm test -- --watchAll=false --runInBand --testPathPattern=BillingControls.test.jsx`, then `npm run build`.

Before enabling production merchants, run the full save-card → invoice → 3DS/failure/retry → paid → email workflow using a Stripe test key and test webhook with a staging database. Offline tests do not verify real account credentials, SES delivery or live Stripe configuration. No live charges, emails or production database changes were performed while implementing this feature.
