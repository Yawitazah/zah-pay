/* Off-state, config, checkout with a stubbed Stripe, the installment cap and
   a signed webhook through to onPaid. No network, no real Stripe. */
const express = require('express');
const crypto = require('crypto');
const { mount, capInstallments } = require('..');

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  ', m); };
const PACKAGES = [
  { id: 'therapy', name: 'Therapy', priceUsd: 145, unit: 'per session', checkout: false },
  { id: 'restore', name: 'Restore', duration: '4 weeks', priceUsd: 349 },
  { id: 'total', name: 'Total', duration: '12 weeks', priceUsd: 1295, installments: { count: 3, amountUsd: 450 } },
];

// A Stripe stand-in with just what the package touches.
function stubStripe(secret) {
  const created = [];
  const schedules = [];
  return {
    created, schedules,
    checkout: { sessions: {
      create: async (params) => { created.push(params); return { url: 'https://checkout.stripe.test/cs_1', id: 'cs_1' }; },
      retrieve: async (id) => ({ id, payment_status: 'paid', status: 'complete', metadata: { package: 'total', plan: 'installments' }, customer_details: { email: 'a@b.c' }, amount_total: 45000 }),
    } },
    subscriptions: { retrieve: async (id) => ({ id, schedule: null }) },
    subscriptionSchedules: {
      create: async ({ from_subscription }) => ({ id: 'sub_sched_1', phases: [{ items: [{ price: 'price_x', quantity: 1 }], start_date: 1700000000 }] }),
      update: async (id, params) => { schedules.push({ id, params }); return { id }; },
    },
    webhooks: { constructEvent: (body, sig, s) => {
      if (s !== secret || sig !== 'good') throw new Error('bad sig');
      return JSON.parse(body.toString());
    } },
  };
}

(async () => {
  // ---- off state ----
  let app = express();
  mount(app, { packages: PACKAGES, enabled: false, booking: { url: 'https://book.test', phone: '(555) 000-1111' } });
  let srv = app.listen(0); let base = `http://127.0.0.1:${srv.address().port}`;
  let r = await fetch(base + '/zah-pay/config'); let d = await r.json();
  assert(d.payments === false && d.packages.length === 3 && d.packages[0].checkout === false, 'config: off, 3 packages, therapy not sold online');
  r = await fetch(base + '/zah-pay/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: 'restore' }) });
  d = await r.json();
  assert(r.status === 503 && d.booking === 'https://book.test' && d.phone === '(555) 000-1111', 'checkout off -> 503 with booking + phone');
  r = await fetch(base + '/zah-pay/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: 'therapy' }) });
  assert(r.status === 400, 'a checkout:false package is refused');
  r = await fetch(base + '/zah-pay/client.js');
  assert(r.ok && (await r.text()).includes('data-checkout'), 'client.js served');
  srv.close();

  // ---- on, with a stub ----
  const stripe = stubStripe('whsec_test');
  const paid = [];
  app = express();
  mount(app, {
    packages: PACKAGES, enabled: true, stripeKey: 'sk_test_stub', stripe, webhookSecret: 'whsec_test',
    publicUrl: 'https://site.test', successPath: '/thanks', cancelPath: '/#packages',
    onPaid: async (info) => { paid.push(info); },
  });
  app.use(express.json());
  srv = app.listen(0); base = `http://127.0.0.1:${srv.address().port}`;

  r = await fetch(base + '/zah-pay/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: 'restore' }) });
  d = await r.json();
  assert(r.ok && d.url && stripe.created[0].mode === 'payment' && stripe.created[0].line_items[0].price_data.unit_amount === 34900, 'full payment: payment mode, $349');
  assert(stripe.created[0].success_url === 'https://site.test/thanks?session_id={CHECKOUT_SESSION_ID}', 'success_url built from publicUrl + successPath');

  r = await fetch(base + '/zah-pay/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: 'total', plan: 'installments' }) });
  assert(r.ok && stripe.created[1].mode === 'subscription' && stripe.created[1].line_items[0].price_data.unit_amount === 45000 && stripe.created[1].line_items[0].price_data.recurring.interval === 'month', 'installments: subscription mode, $450/month');

  r = await fetch(base + '/zah-pay/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageId: 'restore', plan: 'installments' }) });
  assert(r.ok && stripe.created[2].mode === 'payment', 'installments on a package without a plan falls back to full');

  const event = { type: 'checkout.session.completed', data: { object: { id: 'cs_9', mode: 'subscription', subscription: 'sub_1', metadata: { package: 'total', plan: 'installments' }, customer_details: { email: 'a@b.c', name: 'A B' }, amount_total: 45000 } } };
  r = await fetch(base + '/zah-pay/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'good' }, body: JSON.stringify(event) });
  assert(r.ok, 'signed webhook accepted');
  assert(stripe.schedules.length === 1 && stripe.schedules[0].params.end_behavior === 'cancel' && stripe.schedules[0].params.phases[0].iterations === 3, 'installments capped at 3 with end_behavior cancel');
  assert(paid.length === 1 && paid[0].package.id === 'total' && paid[0].amountUsd === 450 && paid[0].email === 'a@b.c', 'onPaid called with the package and amount');

  r = await fetch(base + '/zah-pay/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'bad' }, body: JSON.stringify(event) });
  assert(r.status === 400, 'unsigned webhook refused');

  r = await fetch(base + '/zah-pay/session?id=cs_1'); d = await r.json();
  assert(d.paid === true && d.package.id === 'total' && d.plan === 'installments', 'session read back for the thank-you page');

  srv.close();
  console.log('\nALL PASSED');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
