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
  successPath: '/thanks',
  cancelPath: '/#packages',
  onPaid: async (info) => { /* CRM lead, email, anything. info: {package, plan, name, email, phone, amountUsd, sessionId} */ },
});
```

## Packages

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

`data-book` links get the booking URL from config. The off-state note reads
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
   `checkout.session.completed`. Set `STRIPE_WEBHOOK_SECRET`.
3. `PAYMENTS_ENABLED=true`, `PUBLIC_URL` the live domain. Redeploy.
4. Buy the cheapest package with a real card and refund it.

Step 2 is not optional when any package has `installments`: without the
webhook the subscription would charge a fourth time.

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
