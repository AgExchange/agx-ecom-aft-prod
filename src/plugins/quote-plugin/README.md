# QuotePlugin

Adds a **quote** workflow to the Vendure order system. A quote is a *real Order* that spends
its entire negotiation in Vendure's own `Draft` state — **not** a parallel or duplicate
entity, and **not** a custom `OrderState`. It rejoins the standard order flow on acceptance,
with its quoted lines, adjustments and prices **preserved (no recalculation)**.

> Full design rationale (including why an earlier custom-`OrderState` design was replaced) is
> in `docs/quote-plugin.md` at the repo root. This README is the short usage reference.

## Install

Registered in `src/vendure-config.ts`:

```ts
import { QuotePlugin } from './plugins/quote-plugin';

plugins: [
    // ...
    QuotePlugin.init({
        defaultQuoteValidityDays: 7, // default expiry window (days)
        quoteReferencePrefix: 'Q',    // → Q-2026-00042
    }),
],
```

The plugin self-registers the Order custom fields, the custom `OrderProcess` (combined with
`defaultOrderProcess`) and a scheduled expiry-sweep task in its `configuration` function.
After enabling it, generate and run a migration:

```bash
npx vendure migrate --generate <name>
npx vendure migrate --run
```

> **Note:** if you ever set `orderOptions.process` manually in `vendure-config.ts`, it must
> still include `defaultOrderProcess` — the plugin appends `quoteOrderProcess` to it.

## Lifecycle (`customFields.quoteStatus`, NOT `order.state`)

```
requested ─▶ sent ─▶ accepted   (order.state: Draft -> ArrangingPayment -> normal flow)
   │           │
   │           └──▶ rejected (terminal, order.state stays Draft)
   │           └──▶ expired  (terminal, set by the hourly scheduled sweep)
   └────────────────▶ withdrawn (order.state: Draft -> AddingItems, i.e. an ordinary cart)
```

The order's actual `order.state` is `Draft` for the entire `requested`/`sent`/`rejected`/
`expired` span — the ONLY two state transitions this plugin adds are
`AddingItems <-> Draft`. This keeps a quote editable via Vendure's own generic
line/shipping/customer mutations (`addItemToOrder`, `setShippingMethod`, …) for as many
rounds of negotiation as needed — those mutations only ever accept `AddingItems`/`Draft`, so
a custom state would silently break them (see `docs/quote-plugin.md` §1 for the full story).

- **Expiry guard:** accepting a quote past its `quoteValidUntil`, or one that hasn't been
  `sent`, is blocked in `QuoteService.acceptQuote` before the transition is attempted.
- **Mandatory fields:** a customer and a shipping method are required before a quote can be
  *sent*, which guarantees the `Draft -> ArrangingPayment` transition passes the
  default-process guards on acceptance.
- **Session reattachment:** both `acceptQuote` and `withdrawQuoteRequest` explicitly
  reattach the order to the customer's session (`order.active = true` +
  `SessionService.setActiveOrder`) — Vendure never does this automatically for an order that
  wasn't already the session's active order.
- **Re-sendable:** calling `sendQuote` on an already-`sent` quote is a re-send, not an
  error — it bumps `quoteRevision` and logs a `QUOTE_SENT` history entry rather than
  requiring any state change.

## Custom fields (Order)

| Field | Type | Notes |
|---|---|---|
| `quoteValidUntil` | datetime | When the quote expires |
| `quoteReference` | string | Generated, e.g. `Q-2026-00042`; set once, never cleared |
| `quoteNotes` | text | Customer-facing notes |
| `quoteAcceptedAt` | datetime | Set on acceptance |
| `quoteStatus` | string | `requested` / `sent` / `accepted` / `rejected` / `expired` / `withdrawn` |
| `quoteRequestedAt` | datetime | Set when the quote is (re-)requested |
| `quoteSentAt` | datetime | Set on each send/re-send |
| `quoteRevision` | int | Bumped on each re-send after the first `sendQuote` |

## API

### Shop API (authenticated customers only — no guest quotes; `@Allow(Permission.Owner)`)

- `requestQuote: RequestQuoteResult!` — turns the active order into a quote request.
- `withdrawQuoteRequest(orderCode: String!): WithdrawQuoteResult!` — hands an open quote back
  as an ordinary cart.
- `acceptQuote(orderCode: String!): AcceptQuoteResult!` — validates ownership, `sent` status
  and expiry; moves the order to `ArrangingPayment`.
- `rejectQuote(orderCode: String!): RejectQuoteResult!`.
- `quoteByReference(reference: String!): Order` — look up an owned quote by its reference.

### Admin API (`@Allow(Permission.UpdateOrder)`; `createQuote` uses `CreateOrder`, `quotes` uses `ReadOrder`)

- `createQuote(orderId: ID!): Order!` — converts an existing native Draft order (built via
  `createDraftOrder`/`addItemToDraftOrder`/`setCustomerForDraftOrder`/
  `setDraftOrderShippingMethod`) into a quote.
- `sendQuote(id: ID!): Order!` — sends, or re-sends after edits.
- `setQuoteValidity(id: ID!, validUntil: DateTime!): Order!`
- `updateQuoteNotes(id: ID!, notes: String!): Order!`
- `acceptQuote(id: ID!): Order!` — accepts a `sent` quote on the customer's behalf.
- `quotes(options: OrderListOptions): OrderList!` — every order that has ever been a quote.

## Scheduled task

`quoteExpirySweepTask` (hourly, via `DefaultSchedulerPlugin`) marks open (`requested`/`sent`)
quotes past `quoteValidUntil` as `expired`, across every channel. Registered automatically —
no extra wiring needed.

## Dashboard

Action-bar panel registered on both `pageId: 'order-detail'` and `pageId:
'draft-order-detail'` (a quote spends its entire negotiation in `Draft`, which Vendure
renders via the latter), gated on `customFields.quoteReference != null`
(**Send/Re-send quote**, **Edit quote** → set validity / edit notes, **Accept on customer's
behalf**, shown only while the quote is open/sent). An ordinary staff-built draft order also
gets a **Convert to Quote** button. A `/quotes` list route (Admin API `quotes` query) is also
shipped, since the built-in order list's State filter can no longer surface "all quotes" once
quotes no longer have their own states.

## Tests

Pure-logic unit tests:

```bash
npx ts-node src/plugins/quote-plugin/helpers/quote.helpers.spec.ts
```

e2e (`@vendure/testing` + Vitest — first e2e suite in this repo):

```bash
pnpm test:e2e
# or, to run only this suite:
npx vitest run src/plugins/quote-plugin/quote.e2e-spec.ts
```
