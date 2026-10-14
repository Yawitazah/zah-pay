# ZAH Pay

Sell priced packages on any ZAH client site by card, into **the client's own
Stripe account**. Pay in full or in N monthly payments that stop themselves.
Honest off-state until the client's keys exist.

**Do not rebuild this per site. Install it and mount it.** Extend it here.

## Install

```bash
npm i github:Yawitazah/zah-pay
```

## Mount

```js
const zahPay = require('zah-pay');

// BEFORE app.use(express.json()) (the webhook needs the raw body) and before express.static.
zahPay.mount(app, {
  packages: require('./packages'),
  stripeKey: process.env.STRIPE_SECRET_KEY,           // THE CLIENT'S key, never Zah's
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  enabled: process.env.PAYMENTS_ENABLED === 'true',
  publicUrl: process.env.PUBLIC_URL,
  booking: { url: 'https://their-booking-page', phone: '(980) 480-5874' },
  // or, with ZAH Site MCP mounted, let the client change it themselves:
  // booking: () => ({ url: site.settings().bookingUrl, phone: site.settings().phone }),
  successPath: '/thanks',
  cancelPath: '/#packages',
  onPaid: async (info) => { /* CRM lead, email, anything. info: {package, plan, name, email, phone, amountUsd, sessionId} */ },
});
```

## Packages

An empty list is fine: the product mounts, `/healthz` reports payments off,
and nothing is sold until a `packages.js` and the client's key exist.

One array. The page prints the same numbers; keep them in step.

```js
module.exports = [
  { id: 'therapy',  name: 'Private Pay Therapy', duration: 'Ongoing', priceUsd: 145, unit: 'per session', checkout: false },
  { id: 'restore',  name: 'Restore',             duration: '4 weeks', priceUsd: 349 },
  { id: 'total',    name: 'Total Wellness Experience', duration: '12 weeks', priceUsd: 1295,
    installments: { count: 3, amountUsd: 450 } },
];
```

`checkout: false` means the button is a booking link, not a sale.
`installments` sells the package as a monthly subscription that the webhook
caps at exactly `count` charges (a Stripe subscription schedule with
`end_behavior: cancel`).

## The page

```html
<a class="btn" data-checkout="restore">Get Started</a>
<a class="btn" data-checkout="total" data-plan="installments">3 payments of $450</a>
<a class="btn" data-book>Book a Consultation</a>
<script src="/zah-pay/client.js"></script>
```

`data-book` links get the booking URL from config; `[data-phone]` elements get
the phone (text, and a `tel:` href on links). The off-state note reads
the host page's look from CSS variables, all optional:
`--zp-bg --zp-ink --zp-muted --zp-accent --zp-accent-ink --zp-line --zp-radius --zp-font --zp-heading-font`.

Thank-you page: `ZahPay.session(id)` returns `{paid, package, plan, email,
amount, booking}`; render it however the site looks. The page never trusts the
URL, it asks Stripe.

## What it owns

| Thing | Where |
|---|---|
| Routes | `/zah-pay/config`, `/zah-pay/checkout`, `/zah-pay/session`, `/zah-pay/webhook`, `/zah-pay/client.js` |
| Data | none. Stripe is the record. `onPaid` is where a site keeps its own. |
| Styling | none of its own; `--zp-*` variables |

## Switching a client on

1. In the client's Stripe dashboard create a restricted key: Checkout Sessions
   (write), Subscriptions (write), Subscription Schedules (write). Set
   `STRIPE_SECRET_KEY`.
2. Webhook endpoint `https://<site>/zah-pay/webhook`, event
   `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
   Set `STRIPE_WEBHOOK_SECRET`.
3. `PAYMENTS_ENABLED=true`, `PUBLIC_URL` the live domain. Redeploy.
4. Buy the cheapest package with a real card and refund it.

Step 2 is required for every payment integration. A completed session with
`payment_status=unpaid` is not a paid order. This package's `onPaid` fires only
for confirmed `paid` sessions marked `zah_pay=1` with a recognized package.
No-cost orders require a separate explicit fulfillment policy.

## Payment delivery contract

`onPaid(info, session, context)` must atomically record host business work using
`context.fulfillmentKey` (account plus Checkout Session ID) as a durable unique
key. The same key is also in `info`. `context` includes the Stripe event ID and
account. Verify account ownership against the host's merchant mapping before
writing an order. Separate completed and delayed-success events can refer to
one session; deduplicating only by event ID is insufficient.

Thrown callback or installment errors return HTTP 500 for Stripe retry. The
adapter coalesces concurrent deliveries within one mount, but has no persistent
receipt store and guarantees no deduplication across processes or restarts.
Do not send emails or start shipping directly in a non-idempotent callback;
write an outbox in the same transaction as the order, then deliver separately.
The thank-you endpoint reports payment status only and does not fulfill orders.
Customer contact details are no longer written into payment logs.

Installment schedule mutations use stable idempotency keys. Existing schedules
must have cancellation plus the adapter's matching count marker; unknown or
partially configured schedules fail for reconciliation instead of silently
acknowledging payment. Automatic recovery of such schedules and durable operator
alerts remain required before Commerce launch. The existing SDK/API contract is
retained here; migration to current schedule duration semantics needs separate
compatibility tests. This change has no production rollout or real transactions.

References: [Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment),
[webhook retry behavior](https://docs.stripe.com/webhooks),
[schedule creation](https://docs.stripe.com/api/subscription_schedules/create),
[schedule updates](https://docs.stripe.com/api/subscription_schedules/update).

## Failure modes already met

- **Button opens the note even with a key set.** `PAYMENTS_ENABLED` is not the
  string `true`.
- **Webhook 400 "bad signature".** Wrong `STRIPE_WEBHOOK_SECRET`, or
  `express.json()` ran before the mount and consumed the raw body.
- **`success_url` goes to the Railway domain after the client's domain went
  live.** `PUBLIC_URL` still holds the old one.

## Test

```bash
npm test
```

Off-state, config, checkout with a stubbed Stripe, the installment cap, and
a signed webhook through to `onPaid`.
