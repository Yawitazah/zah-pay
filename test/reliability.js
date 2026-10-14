const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mount, capInstallments } = require('..');

const event = (payment_status = 'paid', type = 'checkout.session.completed') => ({
  id: 'evt_test', type, data: { object: { id: 'cs_test', mode: 'payment',
    status: 'complete', payment_status, amount_total: 2500,
    metadata: { package: 'actual', zah_pay: '1' } } },
});
async function server(t, onPaid, session = event().data.object) {
  const app = express();
  mount(app, { packages: [{ id: 'actual', name: 'Fixture', priceUsd: 25 }],
    stripeKey: 'test-only', webhookSecret: 'test-only', onPaid,
    stripe: { webhooks: { constructEvent: (body, signature) => {
      if (signature !== 'valid') throw new Error('signature');
      return JSON.parse(body.toString());
    } }, checkout: { sessions: { retrieve: async () => session } } },
  });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(resolve => srv.once('listening', resolve));
  t.after(() => new Promise(resolve => srv.close(resolve)));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, post: body => fetch(`${base}/zah-pay/webhook`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 'valid' }, body: JSON.stringify(body) }) };
}
test('completed unpaid checkout is neither paid nor fulfilled', async t => {
  let calls = 0;
  const s = await server(t, () => { calls++; }, event('unpaid').data.object);
  assert.equal((await s.post(event('unpaid'))).status, 200);
  assert.equal(calls, 0);
  assert.equal((await (await fetch(`${s.base}/zah-pay/session?id=cs_test`)).json()).paid, false);
  assert.equal((await s.post(event('no_payment_required'))).status, 200);
  assert.equal(calls, 0);
});
test('host failure retries and delayed success provides stable durable key', async t => {
  let calls = 0;
  const committed = new Set();
  const s = await server(t, async (info, session, context) => {
    calls++;
    assert.equal(info.fulfillmentKey, context.fulfillmentKey);
    assert.equal(session.payment_status, 'paid');
    assert.equal(context.eventId, 'evt_test');
    if (calls === 1) throw new Error('unavailable database');
    // Represents the host's durable unique-key transaction, not adapter storage.
    committed.add(context.fulfillmentKey);
  });
  assert.equal((await s.post(event())).status, 500);
  assert.equal(committed.size, 0);
  assert.equal((await s.post(event('paid', 'checkout.session.async_payment_succeeded'))).status, 200);
  assert.equal((await s.post(event())).status, 200);
  assert.equal(committed.size, 1);
  assert.equal(calls, 3, 'successful delivery is not falsely cached across retries');
});
test('concurrent deliveries coalesce while host work is pending', async t => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const s = await server(t, async () => { calls++; await gate; });
  const responses = Array.from({ length: 8 }, () => s.post(event()));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls, 1);
  release();
  for (const response of await Promise.all(responses)) assert.equal(response.status, 200);
});
test('other integrations and failure notifications never fulfill', async t => {
  let calls = 0;
  const s = await server(t, () => { calls++; });
  const foreign = event(); delete foreign.data.object.metadata.zah_pay;
  assert.equal((await s.post(foreign)).status, 200);
  assert.equal((await s.post(event('paid', 'checkout.session.async_payment_failed'))).status, 200);
  assert.equal(calls, 0);
});
test('thank-you reads hide foreign integration sessions and forbid caching', async t => {
  const session = event().data.object;
  const s = await server(t, () => {}, session);
  let response = await fetch(`${s.base}/zah-pay/session?id=cs_test`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  delete session.metadata.zah_pay;
  response = await fetch(`${s.base}/zah-pay/session?id=cs_test`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).email, undefined);
});
test('existing uncapped schedule cannot silently acknowledge a paid installment', async () => {
  let writes = 0;
  const stripe = { subscriptions: { retrieve: async () => ({ schedule: 'sched_existing' }) },
    subscriptionSchedules: { retrieve: async () => ({ end_behavior: 'release', metadata: {} }),
      update: async () => { writes++; } } };
  await assert.rejects(capInstallments(stripe, 'sub_existing', 3), /reconciliation/);
  assert.equal(writes, 0, 'foreign or incomplete schedules are never rewritten');
  stripe.subscriptionSchedules.retrieve = async () => ({ end_behavior: 'cancel', metadata: { zah_pay_installments: '3' } });
  assert.equal(await capInstallments(stripe, 'sub_existing', 3), 'sched_existing');
  await assert.rejects(capInstallments(stripe, 'sub_existing', 4), /reconciliation/);
  await assert.rejects(capInstallments(stripe, 'sub_existing', 0), /count/);
});
test('schedule mutation requests have stable provider retry keys', async () => {
  const calls = [];
  const stripe = { subscriptions: { retrieve: async () => ({ schedule: null }) },
    subscriptionSchedules: {
      create: async (params, options) => { calls.push(options); return { id: 'sched_test', phases: [{ items: [{ price: 'price_test', quantity: 1 }], start_date: 1700000000 }] }; },
      update: async (id, params, options) => { calls.push({ ...options, params }); },
    } };
  await capInstallments(stripe, 'sub_test', 3);
  await capInstallments(stripe, 'sub_test', 3);
  assert.equal(calls[0].idempotencyKey, calls[2].idempotencyKey);
  assert.equal(calls[1].idempotencyKey, calls[3].idempotencyKey);
  assert.equal(calls[1].params.metadata.zah_pay_installments, '3');
  assert.equal(calls[1].params.proration_behavior, 'none');
});
