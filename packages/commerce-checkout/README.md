# ZAH Pay Commerce Checkout transport

Inject a server-only StripeClient (SDK23 or newer). Commerce owns canonical frozen
amounts, private recipient data, idempotency identity and durable order records.
This adapter creates one-time USD Checkout Sessions with destination shipping already
quoted. Hosted Checkout cannot edit that delivery address; a change returns to the
store for a new quote/session. No static shipping fallback or caller price is used.

`off_by_owner` is an explicit merchant tax setting, not tax advice or a finding that
no tax is owed. It is the only currently supported policy. Registration-backed tax
calculation remains separate work before another policy may be enabled.

Signed webhook delivery plus fresh Stripe session/payment readback verifies exact
merchant metadata, mode, currency, item amounts, quantity, shipping, discounts and tax.
Completed-but-unpaid sessions never authorize fulfillment. The success page is not
payment authority. No payouts, refunds, subscriptions or fulfillment are implemented
by this transport; it is additive to the existing ZAH Pay service-package API.
