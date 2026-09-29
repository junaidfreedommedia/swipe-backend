const crypto = require('crypto');
const moment = require('moment-timezone');
const policy = require('../utils/merchantBillingPolicy');
const getStripe = require('../utils/merchantBillingStripe');
const terminal = ['paid', 'void', 'uncollectible', 'skipped', 'submitted_to_shopify'];
const idOf = value => typeof value === 'string' ? value : value?.id;
// Explicit test resets get fresh Stripe requests; ordinary runs keep their original keys.
const stripeKey = (operation, run) => `${operation}:${run._id}${run.stripe_test_reset_id ? `:test-reset:${run.stripe_test_reset_id}` : ''}`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Dependency injection keeps financial tests entirely offline.
function createService(deps = {}) {
    const models = () => deps.models || global.Models;
    const services = () => deps.services || global.Services;
    const stripe = () => deps.stripe || getStripe();
    const now = () => deps.now ? deps.now() : new Date();
    const service = {};
    const audit = (action, actor, detail) => ({ action, actor: String(actor || 'scheduler'), at: now(), detail });
    const updateRun = async (id, values, entry) => models().MerchantBillingRun.findByIdAndUpdate(id, {
        $set: values, ...(entry ? { $push: { audit: { $each: [entry], $slice: -100 } } } : {}),
    }, { new: true }).lean();
    async function merchant(id) {
        if (!/^[a-f0-9]{24}$/i.test(String(id))) policy.fail('Invalid merchant.', 400);
        const m = await models().Merchant.findById(id).lean();
        if (!m || m.is_deleted) policy.fail('Merchant not found.', 404);
        return m;
    }
    service.withLock = async (id, work) => {
        id = String(id).toLowerCase();
        const token = crypto.randomUUID();
        const locked = await models().Merchant.findOneAndUpdate({ _id: id, $or: [
            { billing_lock_until: { $exists: false } }, { billing_lock_until: null }, { billing_lock_until: { $lt: now() } },
        ] }, { $set: { billing_lock_token: token, billing_lock_until: new Date(now().getTime() + 600000) } }, { new: true }).lean();
        if (!locked) policy.fail('Billing is busy for this merchant. Please retry shortly.', 409);
        const heartbeat = setInterval(() => {
            models().Merchant.updateOne({ _id: id, billing_lock_token: token }, { $set: { billing_lock_until: new Date(now().getTime() + 600000) } })
                .catch(error => (global.Logger || console).error(`Billing lock renewal: ${error.message}`));
        }, 60000);
        heartbeat.unref?.();
        const assertLock = async () => {
            const current = await models().Merchant.findById(id).lean();
            if (current?.billing_lock_token !== token || new Date(current.billing_lock_until) <= now()) policy.fail('Billing lock expired. Reload before continuing.', 409);
        };
        try { return await work(locked, assertLock); }
        finally {
            clearInterval(heartbeat);
            await models().Merchant.updateOne({ _id: id, billing_lock_token: token }, { $unset: { billing_lock_token: '', billing_lock_until: '' } });
        }
    };
    service.get = async id => {
        id = String(id).toLowerCase();
        const m = await merchant(id);
        const runs = await models().MerchantBillingRun.find({ merchant: id }).sort({ period: -1 }).limit(24).lean();
        return { merchant: { _id: m._id, name: m.name }, configured: Boolean(m.billing_controls?.version),
            legacy_provider: m.billing_type, settings: m.billing_controls || policy.defaults(m),
            card: { ready: Boolean(m.billing_consent_at && m.billing_payment_method), label: m.billing_card_label, consent_at: m.billing_consent_at },
            runs, audit: (m.billing_audit || []).slice(-20).reverse(),
            stripe_ready: Boolean(process.env.STRIPE_MERCHANT_BILLING_WEBHOOK_SECRET),
        };
    };
    service.save = async (id, input, actor) => {
        id = String(id).toLowerCase();
        await merchant(id);
        return service.withLock(id, async m => {
            if (input.revision !== (m.billing_controls?.revision || 0)) policy.fail('Settings changed. Reload before saving.', 409);
            const settings = policy.validateSettings(input, m);
            if (settings.provider === 'shopify' && !m.shop_id) policy.fail('Connect this store to Shopify first.');
            if (settings.enabled && !m.is_active) policy.fail('Activate the merchant before enabling billing.');
            if (settings.enabled && settings.provider === 'stripe' && !process.env.STRIPE_MERCHANT_BILLING_WEBHOOK_SECRET && !deps.stripe) {
                policy.fail('Configure the Stripe merchant-billing webhook before enabling Stripe billing.', 503);
            }
            const open = await models().MerchantBillingRun.find({ merchant: id, status: { $nin: terminal } }).lean();
            if (open.some(r => r.provider !== settings.provider)) policy.fail('Resolve existing bills before changing the billing method.', 409);
            // Freeze configuration first. A paused merchant cannot start new billing work.
            await models().Merchant.updateOne({ _id: id }, { $set: { billing_controls: settings, billing_type: settings.provider, ...(settings.enabled ? { is_billing: true } : {}) },
                $push: { billing_audit: { $each: [audit('settings_saved', actor, { provider: settings.provider, enabled: settings.enabled })], $slice: -100 } } });
            if (!settings.enabled) {
                for (const run of open.filter(r => r.stripe_invoice_id)) {
                    await stripe().invoices.update(run.stripe_invoice_id, { auto_advance: false });
                    await updateRun(run._id, { collection_paused: true }, audit('collection_paused', actor));
                }
            }
            return service.get(id);
        });
    };
    service.shopifyStatus = async id => {
        id = String(id).toLowerCase();
        const m = await merchant(id);
        if (!m.shop_id) return { approved: false, connected: false };
        const session = await services().ShopifySession.get({ shop: m.shop_id });
        if (!session) return { approved: false, connected: false };
        return { connected: true, approved: Boolean(await services().Billing.checkBillingStatus(session, { throwOnError: true })) };
    };
    service.shopifyApproval = async (id, actor) => {
        id = String(id).toLowerCase();
        await merchant(id);
        return service.withLock(id, async m => {
            if (m.billing_controls?.provider !== 'shopify') policy.fail('Save Shopify billing settings first.');
            if (!m.shop_id) policy.fail('Connect this store to Shopify first.');
            const result = await services().Billing.sendBillingRequest(m.shop_id, { sendEmail: false });
            await models().Merchant.updateOne({ _id: id }, { $push: { billing_audit: { $each: [audit('shopify_approval_link_created', actor)], $slice: -100 } } });
            return result;
        });
    };
    async function getSnapshot(m, period) {
        const old = await models().Statement.find({ merchant: m._id, statement_month: period }).lean();
        policy.assertUncharged(old);
        const [year, month] = period.split('-').map(Number);
        const result = await services().Statement.CreatePdf({ merchantIds: [String(m._id)], year, month, captureOnly: true });
        const snapshot = result.billingSnapshots?.find(s => s.merchant === String(m._id));
        if (!snapshot) policy.fail('No statement records found for this month.');
        return snapshot;
    }
    function configured(m, period) {
        if (!m.billing_controls?.version) policy.fail('Save billing settings first.');
        policy.validatePeriod(period, m.billing_controls, now());
    }
    service.preview = async (id, period) => {
        id = String(id).toLowerCase();
        const m = await merchant(id); configured(m, period);
        const existing = await models().MerchantBillingRun.findById(`${id}:${period}`).lean();
        const snapshot = existing?.snapshot || await getSnapshot(m, period);
        const revision = m.billing_controls.revision;
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ period, revision, snapshot })).digest('hex');
        return { period, snapshot, revision, fingerprint, existing,
            review_required: snapshot.amount_cents > m.billing_controls.review_limit * 100 };
    };
    async function ensureCustomer(m) {
        if (m.billing_customer_id) return m.billing_customer_id;
        const customer = await stripe().customers.create({ name: m.name, email: m.billing_controls.email,
            metadata: { swipe_merchant: String(m._id), purpose: 'merchant_billing' } }, { idempotencyKey: `merchant-billing-customer:${m._id}` });
        await models().Merchant.updateOne({ _id: m._id }, { $set: { billing_customer_id: customer.id } });
        m.billing_customer_id = customer.id;
        return customer.id;
    }
    service.setup = async (id, actor) => {
        id = String(id).toLowerCase();
        await merchant(id);
        return service.withLock(id, async m => {
            if (m.billing_controls?.provider !== 'stripe') policy.fail('Save Stripe billing settings first.');
            const customer = await ensureCustomer(m);
            const base = process.env.REDIRECT_URL || global.Config?.get('APP')?.REDIRECT_URL;
            let origin;
            try { origin = new URL(base).origin; } catch { policy.fail('Dashboard URL is not configured.', 503); }
            const metadata = { swipe_merchant: String(m._id), purpose: 'merchant_billing_setup' };
            const session = await stripe().checkout.sessions.create({ mode: 'setup', customer,
                payment_method_types: ['card'], currency: 'usd', metadata,
                setup_intent_data: { metadata },
                custom_text: { submit: { message: 'By saving this card, you authorize Swipe to charge it for your monthly merchant statements. Contact Swipe to stop automatic billing.' } },
                success_url: `${origin}/dashboard/finance?billing_setup=success`,
                cancel_url: `${origin}/dashboard/finance?billing_setup=cancelled`,
            });
            await models().Merchant.updateOne({ _id: id }, { $set: { billing_setup_session_id: session.id },
                $push: { billing_audit: { $each: [audit('card_setup_link_created', actor)], $slice: -100 } } });
            return { url: session.url };
        });
    };
    async function syncInvoice(run, invoice, actor, failure = false) {
        if (idOf(invoice.customer) !== run.stripe_customer_id || invoice.metadata?.swipe_billing_run !== run._id) {
            policy.fail('Invoice ownership did not match this merchant.', 409);
        }
        const status = invoice.status === 'open' && (failure || (invoice.attempted && !invoice.paid))
            ? 'payment_failed' : invoice.status === 'open' ? 'awaiting_payment' : invoice.status;
        const next = await updateRun(run._id, { status, invoice_url: invoice.hosted_invoice_url || '',
            invoice_pdf: invoice.invoice_pdf || '', paid_at: invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : null,
            due_at: invoice.due_date ? new Date(invoice.due_date * 1000) : run.due_at,
        }, run.status !== status ? audit('payment_status', actor, status) : null);
        await models().Statement.updateMany({ merchant: run.merchant, statement_month: run.period }, { $set: {
            billing_run_id: run._id, billing_status: status, billing_provider: 'stripe', billing_amount_cents: run.snapshot.amount_cents,
            ...(invoice.hosted_invoice_url ? { payment_link: invoice.hosted_invoice_url } : {}),
        } });
        return next;
    }
    async function notify(run, m, kind) {
        const settings = m.billing_controls;
        if (!settings?.[`${kind}_email`] || run.notified?.[kind]) return;
        const amount = `USD ${(run.snapshot.amount_cents / 100).toFixed(2)}`;
        const titles = { statement: 'Your Swipe statement is ready', receipt: 'Swipe payment received', failure: 'Action needed for your Swipe payment', reminder: 'Your Swipe invoice is due' };
        const descriptions = {
            statement: run.provider === 'shopify' ? 'This charge has been submitted to Shopify and will be collected through your Shopify bill.' : run.provider === 'manual' ? 'Please arrange payment with Swipe. This statement does not charge a card.' :
                run.settings.collection === 'send_invoice' ? 'Use the secure invoice link below to pay.' : 'We will attempt payment using your authorized saved card.',
            receipt: 'Thank you. Your payment has been recorded.',
            failure: 'Please open the invoice to complete verification or update your payment details.',
            reminder: 'Please pay your outstanding invoice using the secure link below.',
        };
        const link = run.invoice_url || run.report_url || '';
        const safeLink = /^https:\/\//.test(link) ? link : '';
        const html = `<div style="font-family:Arial,sans-serif;background:linear-gradient(120deg,#fbe6e9,#e6e4f6);padding:32px"><div style="background:white;padding:32px;border-radius:16px;max-width:560px;margin:auto"><h2>swipe</h2><h1>${esc(titles[kind])}</h1><p>${esc(m.name)} · ${esc(run.period)}</p><h2>${esc(amount)}</h2><p>${esc(descriptions[kind])}</p>${safeLink ? `<a href="${esc(safeLink)}" style="display:inline-block;background:#675496;color:white;padding:14px 20px;border-radius:8px">${run.provider === 'shopify' ? 'View statement' : 'View invoice'}</a>` : ''}<p>Questions? Contact support@swipe.ai.</p></div></div>`;
        const send = deps.sendEmail || ((...args) => global.Email.send(...args));
        await send([settings.email], titles[kind], html, undefined, [], { throwOnError: true });
        await updateRun(run._id, { [`notified.${kind}`]: now() }, audit('email_sent', 'system', kind));
    }
    async function notifications(run, m) {
        if (run.status === 'submitted_to_shopify') await notify(run, m, 'statement');
        else if (run.status === 'paid') await notify(run, m, 'receipt');
        else if (run.status === 'payment_failed') await notify(run, m, 'failure');
        else if (['awaiting_payment', 'awaiting_manual'].includes(run.status)) {
            await notify(run, m, 'statement');
            if (run.due_at && new Date(run.due_at) <= now()) await notify(run, m, 'reminder');
        }
    }
    async function invoiceRun(run, m) {
        const s = run.settings;
        if (s.collection === 'charge_automatically' && (!m.billing_consent_at || !m.billing_payment_method)) policy.fail('Merchant must save and authorize a card first.');
        const customer = run.stripe_customer_id || await ensureCustomer(m);
        let invoice;
        if (run.stripe_invoice_id) invoice = await stripe().invoices.retrieve(run.stripe_invoice_id);
        else {
            // Stripe may prune idempotency keys after 24h. Never recreate an ambiguous old request.
            if (run.stripe_started_at && now() - new Date(run.stripe_started_at) > 23 * 3600000) {
                policy.fail('Invoice creation needs reconciliation in Stripe. Do not create another invoice.', 409);
            }
            run = await updateRun(run._id, { stripe_started_at: run.stripe_started_at || now(), stripe_customer_id: customer,
                stripe_payment_method: run.stripe_payment_method || m.billing_payment_method });
            await stripe().customers.update(customer, { email: m.billing_controls.email });
            invoice = await stripe().invoices.create({ customer, currency: 'usd', collection_method: s.collection,
                auto_advance: false, pending_invoice_items_behavior: 'exclude', automatic_tax: { enabled: false },
                default_tax_rates: [], discounts: '',
                ...(s.collection === 'send_invoice' ? { days_until_due: s.due_days } : { default_payment_method: run.stripe_payment_method }),
                description: `Swipe merchant statement ${run.period}`, metadata: { swipe_billing_run: run._id, purpose: 'merchant_billing' },
            }, { idempotencyKey: stripeKey('invoice', run) });
            run = await updateRun(run._id, { stripe_invoice_id: invoice.id });
        }
        if (invoice.status === 'draft') {
            const lines = await stripe().invoices.listLineItems(invoice.id, { limit: 100 });
            const ours = lines.data.filter(l => l.metadata?.swipe_billing_run === run._id);
            if (!ours.length) {
                await stripe().invoiceItems.create({ customer, invoice: invoice.id, currency: 'usd', amount: run.snapshot.amount_cents,
                    description: `Swipe net merchant fees - ${run.period}`, discountable: false,
                    metadata: { swipe_billing_run: run._id },
                }, { idempotencyKey: stripeKey('line', run) });
            }
            invoice = await stripe().invoices.retrieve(invoice.id);
            if (invoice.total !== run.snapshot.amount_cents || invoice.amount_due !== run.snapshot.amount_cents) {
                policy.fail('Stripe amount differs from the approved statement. Review the draft invoice.', 409);
            }
            invoice = await stripe().invoices.finalizeInvoice(invoice.id, { auto_advance: false }, { idempotencyKey: stripeKey('finalize', run) });
        }
        // Resume always works on the same invoice, never a new payment link or bill.
        if (!run.stripe_released && invoice.status === 'open') {
            run = await updateRun(run._id, { invoice_url: invoice.hosted_invoice_url || '', invoice_pdf: invoice.invoice_pdf || '' });
            // Deliver the statement notice before attempting the saved card.
            await notify(run, m, 'statement');
            if (s.collection === 'charge_automatically' && s.stripe_retries) {
                invoice = await stripe().invoices.update(invoice.id, { auto_advance: true });
            } else if (s.collection === 'charge_automatically' && !invoice.attempted) {
                if (now() - new Date(run.stripe_started_at) > 23 * 3600000) policy.fail('Review the pending invoice in Stripe before attempting collection.', 409);
                try { invoice = await stripe().invoices.pay(invoice.id, {}, { idempotencyKey: stripeKey('pay', run) }); }
                catch (error) {
                    if (error.type !== 'StripeCardError') throw error;
                    invoice = await stripe().invoices.retrieve(invoice.id);
                }
            }
            run = await updateRun(run._id, { stripe_released: true });
        }
        return syncInvoice(run, invoice, 'stripe');
    }
    async function syncShopifyStatement(run) {
        await models().Statement.updateMany({ merchant: run.merchant, statement_month: run.period }, { $set: {
            billing_run_id: run._id, billing_status: run.status, billing_provider: 'shopify', billing_amount_cents: run.snapshot.amount_cents,
            shopify_usage_charge_id: run.shopify_usage_charge_id, shopify_charge_amount: run.snapshot.amount_cents / 100,
            shopify_charge_status: 'charged', shopify_charged_at: run.shopify_submitted_at,
        } });
    }
    async function shopifyRun(run, m) {
        if (!run.shopify_usage_charge_id) {
            if (!run.shopify_subscription_line_item_id) {
                const subscription = await services().Billing.prepareMerchantShopifyCharge(m.shop_id);
                if (!subscription?.id) policy.fail('Shopify billing approval is required.');
                run = await updateRun(run._id, { shopify_subscription_line_item_id: subscription.id });
            }
            const result = await services().Billing.chargeMerchantShopifyBill({ shop: m.shop_id,
                amount: run.snapshot.amount_cents / 100, description: `Swipe merchant statement ${run.period}`,
                subscriptionLineItemId: run.shopify_subscription_line_item_id, idempotencyKey: `swipe-bill:${run._id}` });
            if (!result?.usageChargeId) policy.fail('Shopify did not confirm the charge. Retry this same bill.');
            run = await updateRun(run._id, { shopify_usage_charge_id: result.usageChargeId, shopify_submitted_at: now() });
        }
        // Accepted usage is not confirmation that Shopify has collected payment.
        return updateRun(run._id, { status: 'submitted_to_shopify' }, audit('submitted_to_shopify', 'shopify', run.shopify_usage_charge_id));
    }
    service.bill = async (id, period, approval = {}, actor, automatic = false) => {
        id = String(id).toLowerCase();
        await merchant(id);
        return service.withLock(id, async (m, assertLock) => {
            configured(m, period);
            if (!m.billing_controls.enabled || !m.is_active) policy.fail('Billing is paused for this merchant.');
            const preview = await service.preview(id, period);
            if (!automatic && (approval.fingerprint !== preview.fingerprint || approval.revision !== preview.revision)) {
                policy.fail('The amount or settings changed. Preview the bill again.', 409);
            }
            let run = preview.existing;
            if (!run) {
                const status = preview.snapshot.amount_cents <= 0 ? 'skipped' : automatic && preview.review_required ? 'needs_review' : 'prepared';
                run = await models().MerchantBillingRun.create({ _id: `${id}:${period}`, merchant: id, period,
                    provider: m.billing_controls.provider, settings: m.billing_controls, snapshot: preview.snapshot,
                    status, due_at: moment(now()).add(m.billing_controls.due_days, 'days').toDate(),
                    audit: [audit('bill_prepared', actor, { amount_cents: preview.snapshot.amount_cents })] });
                run = run.toObject();
            }
            try {
                // Build the Finance report from the frozen bill before contacting the provider.
                if (!run.report_ready) {
                    const [year, month] = period.split('-').map(Number);
                    await services().Statement.CreatePdf({ merchantIds: [id], year, month });
                    const reports = await models().Statement.find({ merchant: id, statement_month: period }).lean();
                    run = await updateRun(run._id, { report_ready: true, report_url: reports.find(r => r.url)?.url || '' });
                }
                if (run.status === 'submitted_to_shopify') {
                    await syncShopifyStatement(run);
                    await notifications(run, m);
                    await updateRun(run._id, { last_error: '' });
                    return run;
                }
                if (terminal.includes(run.status) || (automatic && (run.status === 'needs_review' || run.collection_paused))) return run;
                if (run.collection_paused) {
                    if (run.stripe_released) policy.fail('Use Resume collection on this existing invoice.', 409);
                    run = await updateRun(run._id, { collection_paused: false }, audit('draft_resumed', actor));
                }
                if (!automatic && run.status === 'needs_review') run = await updateRun(run._id, { status: 'prepared' }, audit('amount_approved', actor));
                await assertLock();
                if (run.provider === 'manual') {
                    if (run.status !== 'awaiting_manual') run = await updateRun(run._id, { status: 'awaiting_manual' }, audit('manual_bill_created', actor));
                } else if (run.provider === 'shopify') run = await shopifyRun(run, m);
                else if (run.provider === 'stripe') run = await invoiceRun(run, m);
                else policy.fail('Unsupported billing method.');
                if (run.status === 'submitted_to_shopify') await syncShopifyStatement(run);
                await models().Statement.updateMany({ merchant: id, statement_month: period }, { $set: {
                    billing_run_id: run._id, billing_status: run.status,
                    billing_provider: run.provider, billing_amount_cents: run.snapshot.amount_cents,
                } });
                await notifications(run, m);
                await updateRun(run._id, { last_error: '' });
                return run;
            } catch (error) {
                await updateRun(run._id, { last_error: error.message }, audit('billing_error', actor, error.message));
                throw error;
            }
        });
    };
    service.recordPayment = async (id, period, input, actor) => {
        id = String(id).toLowerCase();
        await merchant(id);
        return service.withLock(id, async m => {
            const run = await models().MerchantBillingRun.findById(`${id}:${period}`).lean();
            if (!run || run.provider !== 'manual' || run.status !== 'awaiting_manual') policy.fail('Only an outstanding manual bill can be marked paid.', 409);
            const reference = String(input.reference || '').trim();
            const note = String(input.note || '').trim();
            if (reference.length < 3 || reference.length > 150 || note.length > 1000) policy.fail('Enter a payment reference (3–150 characters).');
            if (input.amount_cents !== run.snapshot.amount_cents) policy.fail('Payment amount must match the statement.', 409);
            const paid = await updateRun(run._id, { status: 'paid', paid_at: now(), payment_reference: reference, payment_note: note }, audit('manual_payment_recorded', actor, reference));
            await models().Statement.updateMany({ merchant: id, statement_month: period }, { $set: { billing_run_id: run._id, billing_provider: 'manual', billing_status: 'paid', billing_amount_cents: run.snapshot.amount_cents } });
            await notifications(paid, m);
            return paid;
        });
    };
    service.refresh = async (id, period) => {
        id = String(id).toLowerCase();
        await merchant(id);
        return service.withLock(id, async m => {
            let run = await models().MerchantBillingRun.findById(`${id}:${period}`).lean();
            if (!run) policy.fail('Bill not found.', 404);
            if (run.provider === 'shopify' && run.status === 'submitted_to_shopify') await syncShopifyStatement(run);
            if (run.stripe_invoice_id) {
                let invoice = await stripe().invoices.retrieve(run.stripe_invoice_id);
                if (!m.billing_controls?.enabled && !terminal.includes(invoice.status)) {
                    invoice = await stripe().invoices.update(invoice.id, { auto_advance: false });
                    run = await updateRun(run._id, { collection_paused: true });
                }
                run = await syncInvoice(run, invoice, 'refresh');
            }
            await notifications(run, m);
            return run;
        });
    };
    service.resume = async (id, period, actor) => {
        id = String(id).toLowerCase();
        await merchant(id);
        return service.withLock(id, async m => {
            if (!m.billing_controls?.enabled || !m.is_active) policy.fail('Enable billing before resuming collection.');
            let run = await models().MerchantBillingRun.findById(`${id}:${period}`).lean();
            if (!run?.stripe_invoice_id || terminal.includes(run.status)) policy.fail('No open Stripe invoice to resume.');
            if (run.settings.collection !== 'charge_automatically') policy.fail('The merchant pays this invoice through its payment link.');
            if (!m.billing_payment_method || !m.billing_consent_at) policy.fail('An authorized card is required.');
            const current = await stripe().invoices.retrieve(run.stripe_invoice_id);
            if (idOf(current.customer) !== run.stripe_customer_id || current.metadata?.swipe_billing_run !== run._id) policy.fail('Invoice ownership mismatch.', 409);
            if (current.status === 'paid') return syncInvoice(run, current, actor);
            if (current.status !== 'open' || current.total !== run.snapshot.amount_cents) policy.fail('Preview and complete the draft bill before resuming collection.', 409);
            const invoice = await stripe().invoices.update(run.stripe_invoice_id, { default_payment_method: m.billing_payment_method, auto_advance: true });
            run = await updateRun(run._id, { collection_paused: false, stripe_released: true }, audit('collection_resumed', actor));
            return syncInvoice(run, invoice, actor);
        });
    };
    service.webhook = async event => {
        const obj = event.data.object;
        if (event.type === 'checkout.session.completed' && obj.metadata?.purpose === 'merchant_billing_setup') {
            const id = obj.metadata.swipe_merchant;
            await merchant(id);
            return service.withLock(id, async m => {
                if (idOf(obj.customer) !== m.billing_customer_id) policy.fail('Setup customer mismatch.', 409);
                const intent = await stripe().setupIntents.retrieve(idOf(obj.setup_intent));
                if (intent.status !== 'succeeded' || idOf(intent.customer) !== m.billing_customer_id || intent.metadata?.swipe_merchant !== id) policy.fail('Card setup is incomplete.', 409);
                const pm = await stripe().paymentMethods.retrieve(idOf(intent.payment_method));
                if (idOf(pm.customer) !== m.billing_customer_id || pm.type !== 'card') policy.fail('Payment method ownership mismatch.', 409);
                // A delayed old setup event must not overwrite a newer authorized card.
                if (m.billing_consent_at && new Date(m.billing_consent_at).getTime() > event.created * 1000) return;
                await models().Merchant.updateOne({ _id: id }, { $set: { billing_payment_method: pm.id,
                    billing_card_label: `${pm.card.brand} •••• ${pm.card.last4}`, billing_consent_at: new Date(event.created * 1000) },
                    $push: { billing_audit: { $each: [audit('card_authorized', 'merchant', obj.id)], $slice: -100 } } });
            });
        }
        if (!event.type.startsWith('invoice.') || obj.metadata?.purpose !== 'merchant_billing') return;
        const run = await models().MerchantBillingRun.findById(obj.metadata.swipe_billing_run).lean();
        if (!run || run.stripe_invoice_id !== obj.id) return;
        // Retrieve authoritative current state so old/replayed events cannot turn Paid back into Failed.
        return service.refresh(String(run.merchant), run.period);
    };
    service.runScheduled = async () => {
        const merchants = await models().Merchant.find({ 'billing_controls.version': 1, is_active: true, is_deleted: { $ne: true } }).lean();
        for (const m of merchants) {
            try {
                const period = policy.duePeriod(m.billing_controls, now());
                if (period) {
                    try { await service.bill(String(m._id), period, {}, 'scheduler', true); }
                    catch (error) { (global.Logger || console).error(`Merchant billing ${m._id}: ${error.message}`); }
                }
                const runs = await models().MerchantBillingRun.find({ merchant: m._id, status: { $nin: ['void', 'uncollectible', 'skipped'] } }).lean();
                for (const run of runs) {
                    if (run.status === 'paid' && run.notified?.receipt) continue;
                    if (run.status === 'submitted_to_shopify' && run.notified?.statement) continue;
                    await service.refresh(String(m._id), run.period);
                }
            } catch (error) {
                (global.Logger || console).error(`Merchant billing ${m._id}: ${error.message}`);
            }
        }
    };
    return service;
}
module.exports = { ...createService(), createService };
