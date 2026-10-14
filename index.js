/* =========================================================
   ZAH PAY

   Sell priced packages on any ZAH client site by card, into THE CLIENT'S
   OWN Stripe account. Born inside the New Vision Private Pay page
   (2026-09-04) and extracted the same day.

   ONE ENTRY POINT, mounted BEFORE express.json() (the webhook needs the
   raw body) and before express.static:

     const zahPay = require('zah-pay');
     zahPay.mount(app, {
       packages: require('./packages'),        // see "Packages" in the README
       stripeKey: process.env.STRIPE_SECRET_KEY,          // the client's key
       webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
       enabled: process.env.PAYMENTS_ENABLED === 'true',
       publicUrl: process.env.PUBLIC_URL,
       booking: { url: 'https://...', phone: '(980) 480-5874' },  // or a function, see README
       successPath: '/thanks',                  // ?session_id= is appended
       cancelPath: '/#packages',
       onPaid: async (info) => { ... },         // optional: CRM lead, email, log
     });

   Owns /zah-pay/* and nothing else. Renders no page of its own: the host's
   buttons carry data-checkout="<package id>", the host loads
   /zah-pay/client.js, and the host's thank-you page asks /zah-pay/session.
   Styling comes from --zp-* CSS variables on the host page.

   OFF-STATE IS THE DEFAULT. With no key or enabled=false, every button
   opens a note that says checkout is opening soon and hands the visitor to
   the booking URL and phone. Never a dead click, never a 500.
   ========================================================= */
const path = require('path');

const PREFIX = '/zah-pay';

function publicView(p) {
  return {
    id: p.id,
    name: p.name,
    duration: p.duration || '',
    priceUsd: p.priceUsd,
    unit: p.unit || 'total',
    checkout: p.checkout !== false,
    installments: p.installments ? { count: p.installments.count, amountUsd: p.installments.amountUsd } : null,
  };
}

function mount(app, cfg) {
  if (!app || typeof app.post !== 'function') throw new Error('zah-pay: mount(app, cfg) needs an Express app');
  // An EMPTY list is allowed since 0.3.0: a site that has not priced
  // anything yet (every self-serve site from zahbrandsolutions.com/start on
  // day one) still mounts the product, reports checkout off, and sells
  // nothing, so switching payments on later is a packages file and a key,
  // never a rebuild.
  if (!cfg || !Array.isArray(cfg.packages)) throw new Error('zah-pay: cfg.packages must be an array (empty is allowed)');
  for (const p of cfg.packages) {
    if (!p.id || !p.name || typeof p.priceUsd !== 'number') throw new Error(`zah-pay: package needs id, name, priceUsd (got ${JSON.stringify(p)})`);
  }

  const express = cfg.express || require('express');
  const packages = cfg.packages;
  const getPackage = (id) => packages.find((p) => p.id === String(id || '')) || null;
  const stripeKey = String(cfg.stripeKey || '');
  const webhookSecret = String(cfg.webhookSecret || '');
  // `booking` may be a function, so a site can hand the value to ZAH Site
  // MCP settings and let the client change it without a developer.
  const booking = () => Object.assign({ url: '', phone: '' }, typeof cfg.booking === 'function' ? cfg.booking() : (cfg.booking || {}));
  const successPath = cfg.successPath || '/thanks';
  const cancelPath = cfg.cancelPath || '/';
  const publicUrl = String(cfg.publicUrl || '').replace(/\/$/, '');
  const enabled = () => cfg.enabled === true && !!stripeKey;
  const offMessage = cfg.offMessage || 'Online checkout is opening soon. Book a consultation and we will get you started on this path in person.';

  // Injectable for tests. Real callers never set cfg.stripe.
  let stripe = cfg.stripe || null;
  if (!stripe && stripeKey) {
    const Stripe = require('stripe');
    stripe = new Stripe(stripeKey);
  }

  const offState = () => ({ error: offMessage, booking: booking().url, phone: booking().phone });
  // Coalesce deliveries within this mount. Durable exactly-once work belongs
  // in the host's transaction, keyed by account + Checkout Session ID.
  const pendingPayments = new Map();

  // ---------- webhook (raw body) ----------
  app.post(`${PREFIX}/webhook`, express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !webhookSecret) return res.status(503).send('webhook not configured');
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } catch (e) {
      console.warn('[zah-pay] bad webhook signature:', e.message);
      return res.status(400).send('bad signature');
    }
    try {
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const session = event.data.object;
        if (session.payment_status !== 'paid') return res.json({ received: true });
        const pkg = getPackage(session.metadata && session.metadata.package);
        if (!pkg || session.metadata.zah_pay !== '1') return res.json({ received: true });
        const fulfillmentKey = `${event.account || 'direct'}:${session.id}`;
        let pending = pendingPayments.get(fulfillmentKey);
        if (!pending) {
          pending = (async () => {
        const info = {
          package: pkg ? publicView(pkg) : null,
          plan: (session.metadata && session.metadata.plan) || 'full',
          email: session.customer_details && session.customer_details.email,
          name: session.customer_details && session.customer_details.name,
          phone: session.customer_details && session.customer_details.phone,
          amountUsd: (session.amount_total || 0) / 100,
          sessionId: session.id,
          mode: session.mode,
          fulfillmentKey,
        };
        if (session.mode === 'subscription' && session.subscription && pkg && pkg.installments) {
          await capInstallments(stripe, session.subscription, pkg.installments.count);
        }
        if (typeof cfg.onPaid === 'function') {
          await cfg.onPaid(info, session, { eventId: event.id, account: event.account || null, fulfillmentKey });
        }
          })();
          pendingPayments.set(fulfillmentKey, pending);
        }
        try { await pending; }
        finally { if (pendingPayments.get(fulfillmentKey) === pending) pendingPayments.delete(fulfillmentKey); }
      }
    } catch (e) {
      // Never acknowledge a failed durable host write: Stripe must retry.
      console.error('[zah-pay] payment processing failed');
      return res.status(500).json({ error: 'Payment processing must be retried.' });
    }
    res.json({ received: true });
  });

  const json = express.json({ limit: '32kb' });

  // ---------- config for the page ----------
  app.get(`${PREFIX}/config`, (_req, res) => res.json({
    payments: enabled(),
    booking: booking().url,
    phone: booking().phone,
    offMessage,
    packages: packages.map(publicView),
  }));

  // ---------- checkout ----------
  app.post(`${PREFIX}/checkout`, json, async (req, res) => {
    const pkg = getPackage(req.body && req.body.packageId);
    if (!pkg || pkg.checkout === false) return res.status(400).json({ error: 'That package is not sold online.' });
    if (!enabled()) return res.status(503).json(offState());

    const plan = req.body.plan === 'installments' && pkg.installments ? 'installments' : 'full';
    const origin = publicUrl || `${req.protocol}://${req.get('host')}`;
    const lineItem = plan === 'installments'
      ? { quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(pkg.installments.amountUsd * 100), recurring: { interval: 'month' }, product_data: { name: `${pkg.name} (${pkg.installments.count} monthly payments)` } } }
      : { quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(pkg.priceUsd * 100), product_data: { name: pkg.duration ? `${pkg.name}, ${pkg.duration}` : pkg.name } } };
    const metadata = { package: pkg.id, plan, zah_pay: '1' };
    try {
      const session = await stripe.checkout.sessions.create({
        mode: plan === 'installments' ? 'subscription' : 'payment',
        line_items: [lineItem],
        metadata,
        ...(plan === 'installments' ? { subscription_data: { metadata } } : {}),
        phone_number_collection: { enabled: true },
        success_url: `${origin}${successPath}${successPath.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}${cancelPath}`,
      });
      res.json({ url: session.url });
    } catch (e) {
      console.error('[zah-pay] checkout failed:', e.message);
      res.status(502).json({ error: 'Checkout could not start just now. Please book a consultation or call us and we will sort it out.', booking: booking().url, phone: booking().phone });
    }
  });

  // ---------- what the thank-you page shows ----------
  app.get(`${PREFIX}/session`, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'not configured' });
    const id = String(req.query.id || '').slice(0, 100);
    if (!id) return res.status(400).json({ error: 'missing id' });
    try {
      const s = await stripe.checkout.sessions.retrieve(id);
      const pkg = getPackage(s.metadata && s.metadata.package);
      if (!pkg || s.metadata.zah_pay !== '1') return res.status(404).json({ error: 'could not read that session' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        paid: s.payment_status === 'paid',
        package: pkg ? publicView(pkg) : null,
        plan: (s.metadata && s.metadata.plan) || 'full',
        email: s.customer_details && s.customer_details.email,
        amount: s.amount_total,
        booking: booking().url,
      });
    } catch (e) {
      res.status(404).json({ error: 'could not read that session' });
    }
  });

  // ---------- the page script ----------
  app.get(`${PREFIX}/client.js`, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript').sendFile(path.join(__dirname, 'public', 'zah-pay.js'));
  });

  console.log(`[zah-pay] ${packages.length} packages, checkout ${enabled() ? 'ON' : 'off (' + (stripeKey ? 'enabled=false' : 'no Stripe key') + ')'}, webhook ${stripe && webhookSecret ? 'ON' : 'off'}`);
  return { enabled, packages: packages.map(publicView), getPackage };
}

/** Turn an open-ended subscription into exactly N monthly charges, then cancel. */
async function capInstallments(stripe, subscriptionId, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 120) throw new Error('Invalid installment count');
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  if (sub.schedule) {
    const scheduleId = typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id;
    const existing = await stripe.subscriptionSchedules.retrieve(scheduleId);
    // A created-but-uncapped schedule must not become a successful payment
    // acknowledgement on retry. Unknown schedules need operator reconciliation.
    if (existing.end_behavior !== 'cancel' || existing.metadata?.zah_pay_installments !== String(count)) {
      throw new Error('Installment schedule needs reconciliation');
    }
    return scheduleId;
  }
  const schedule = await stripe.subscriptionSchedules.create({ from_subscription: subscriptionId },
    { idempotencyKey: `zah-pay-installments:${subscriptionId}` });
  const phase = schedule.phases[0];
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: 'cancel',
    metadata: { zah_pay_installments: String(count) },
    proration_behavior: 'none',
    phases: [{
      items: phase.items.map((it) => ({ price: it.price, quantity: it.quantity || 1 })),
      start_date: phase.start_date,
      iterations: count,
    }],
  }, { idempotencyKey: `zah-pay-installments:${subscriptionId}:${count}:cap` });
  console.log(`[zah-pay] ${subscriptionId} capped at ${count} payments (schedule ${schedule.id})`);
  return schedule.id;
}

module.exports = { mount, capInstallments, publicView, PREFIX };
