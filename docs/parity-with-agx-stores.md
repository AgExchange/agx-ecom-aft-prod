# Reaching functional parity with agx-stores

**Goal:** make this backend behave the same as `agx-stores` does today.

**Where we are:** all 20 plugins are ported and registered identically (Paystack
excluded on purpose). Custom fields match on 4 of 5 entities. What remains is
**configuration, not plugins** — no more porting work.

**Estimate:** about 3.5 hours of work, in four phases. Phases 1 and 2 are quick and
carry almost no risk. Phase 3 is the bulk.

---

## Phase 1 — Quick config parity (~30 min, no dependencies)

Four small edits to `src/vendure-config.ts`. Nothing here needs a migration or a
restart of anything but the server.

### 1.1 CORS

Without this **a storefront cannot call the API at all** — probably the most visible
difference right now. agx-stores allows:

```ts
cors: {
    origin: [
        'https://agxsites.southafricanorth.cloudapp.azure.com',
        /https:\/\/.*\.vercel\.app$/,   // Vercel preview URLs
        /https:\/\/.*\.figma\.site$/,   // Figma preview domains
        'http://localhost:3000',
    ],
    credentials: true,
},
```

**Needs your input:** is that list still current, and what hostname will *this*
backend run on? Worth adding the storefront's own origin too.

### 1.2 Exact stock display

agx-stores shows precise stock numbers instead of Vendure's default
in-stock / low-stock / out-of-stock banding:

```ts
catalogOptions: {
    stockDisplayStrategy: new ExactStockDisplayStrategy(),
},
```

### 1.3 Job queue concurrency

Theirs runs 4 concurrent jobs; ours uses the default. Matters for PIM sync
throughput.

```ts
DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true, concurrency: 4 }),
```

### 1.4 Database pool size

```ts
max: parseInt(process.env.DB_POOL_MAX ?? '8', 10),
```

Their comment notes the real limit on Azure is governed by PgBouncer, not this value.

**Deliberately NOT copying:** agx-stores loads env from a hardcoded
`/opt/vendure/agx-stores/.env` path. That is machine-specific and would break here.

---

## Phase 2 — The four missing Channel custom fields (~30 min)

We ported `infoEmail`. agx-stores has four more, and the Phase 3 email handlers read
three of them, so this must come first.

| Field | Read by |
| --- | --- |
| `storefrontUrl` | EmailPlugin `globalTemplateVars`, for links in every email |
| `orderNotificationEmail` | order-admin-notification handler |
| `shippingContactEmail` | shipping-status-update handler |
| `financeContactEmail` | not yet consumed — ported for parity |

**Work:** add them to `src/custom-fields/channel-contacts.ts`, generate a migration,
read the SQL, run it.

**Watch for:** the generator will again emit a spurious
`DROP INDEX "IDX_product_customFieldsMpn"`. Delete that line before running — see
`docs/plugins/pim-sync.md`.

---

## Phase 3 — The seven missing email handlers (~2 hours, the bulk)

Right now this backend sends **one** kind of email. agx-stores sends eight. Most
visibly, the entire quote workflow currently runs and notifies nobody.

| Handler | Fires on | Goes to |
| --- | --- | --- |
| `order-admin-notification` | order reaches PaymentSettled | channel's `orderNotificationEmail` |
| `shipping-status-update` | every Fulfillment state change | channel's `shippingContactEmail` |
| `quote-sent-notification` | `QuoteSentEvent` | customer |
| `quote-accepted-notification` | `QuoteAcceptedEvent` | customer |
| `quote-expired-notification` | `QuoteExpiredEvent` | customer |
| `quote-rejected-notification` | `QuoteRejectedEvent` | customer |
| `quote-withdrawn-notification` | `QuoteWithdrawnEvent` | customer |

**Good news:** our `quote-plugin` already exports all five quote events
(`src/plugins/quote-plugin/events.ts`), so these import exactly as they do in
agx-stores. No rewiring.

### 3.1 Copy the seven template folders

They exist in `agx-stores/static/email/templates/` and use the same `header` /
`footer` partials we already have. Straight copy.

### 3.2 Port the seven handler definitions

About 230 lines from agx-stores' `vendure-config.ts` (lines 91–300). The
order-admin one is the fiddliest: it resolves its recipient inside `loadData()` via
`ChannelService`, because the email is sent **from the worker**, where a deserialised
`event.ctx.channel` does not reliably carry custom fields.

Rather than growing `vendure-config.ts` by 230 lines, these should live in a new
`src/email-handlers/` directory — one module per handler, composed in an
`index.ts` — mirroring how `src/custom-fields/` and `src/events/` are already
organised. This is a small, deliberate improvement on agx-stores' single-file layout;
behaviour is identical.

### 3.3 Split EmailPlugin into dev and production modes

agx-stores switches on an `EMAIL_DEV_MODE` flag: dev writes `.json` files to disk and
serves a mailbox at `/mailbox`; production sends over real SMTP. We currently only
have the dev half.

`globalTemplateVars` also becomes a function, so email links use the channel's
`storefrontUrl` (falling back to `STOREFRONT_URL`), and `fromAddress` is built from
`SMTP_FROM_NAME` / `SMTP_FROM_ADDRESS`.

### 3.4 New environment variables

Added to `.env` (placeholders locally) and documented in `.env.example`:

```
EMAIL_DEV_MODE=true
STOREFRONT_URL=
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM_NAME=
SMTP_FROM_ADDRESS=
ORDER_NOTIFICATION_EMAIL=
SHIPPING_NOTIFICATION_EMAIL=
DB_POOL_MAX=8
```

---

## Phase 4 — Verify (~30 min)

1. `npx tsc --noEmit` — must be clean.
2. Server boots with no errors.
3. Migration applied; five `customFields*` columns on `channel`.
4. With `EMAIL_DEV_MODE=true`, trigger a quote workflow and confirm the
   notification files appear in `static/email/test-emails/`. **This is the real
   test** — it proves handlers are wired to events, not merely defined.
5. Re-run the config comparison to confirm nothing is left.

---

## What I need from you

Nothing blocks starting — I can use placeholders throughout and you fill these in
when convenient.

| # | What | Why | Urgency |
| --- | --- | --- | --- |
| 1 | **CORS origin list** — is agx-stores' list still right, and what hostname will this backend use? | Storefront cannot call the API without it | Before deploy |
| 2 | **SMTP credentials** (host, port, user, pass, from-name, from-address) | Real email in production | Before deploy, not for local |
| 3 | **`STOREFRONT_URL`** | Links inside every email | Before deploy |
| 4 | **`ORDER_NOTIFICATION_EMAIL` / `SHIPPING_NOTIFICATION_EMAIL`** | Fallback recipients when a channel has none set | Before deploy |
| 5 | **Confirm Paystack stays out** | It is the one deliberate difference from agx-stores | Worth telling your boss explicitly |

---

## What parity will NOT mean

Worth being straight about this, because it is the difference between "matches
agx-stores" and "ready to take over from it".

After all four phases, this backend will be **configured** identically to agx-stores.
It will not yet be **proven**:

- **No payment flow has ever been run.** PayFast and DPO register correctly, but no
  transaction has been attempted. PayFast in particular needs a publicly reachable
  host, since its ITN callback is server-to-server.
- **No courier call has ever been made.** DSV Shipping and DSV SADC have placeholder
  credentials.
- **`setDraftOrderShippingMethod` hangs**, reproducibly, wedging the database
  connection. Not yet isolated. `multivendor-plugin` replaces
  `shippingLineAssignmentStrategy` and is the prime suspect, but that is unproven —
  and this path is on **every order**, so it needs resolving before any real checkout.
- **DSV never reads real variant dimensions.** See
  `docs/plugins/dsv-shipping-plugin-dimensions-bug.md`. Pre-existing in agx-stores,
  so keeping it *is* parity — but it is a bug in both.
- **No automated tests.** DPO ships 8 unit specs covering payment logic; they were
  excluded because `vitest` is not installed.

## Suggested order

Phases 1 and 2 first — quick, low risk, and Phase 3 depends on Phase 2's Channel
fields. Then Phase 3, then verify.

The `setDraftOrderShippingMethod` hang is worth a separate hour, independently of
parity, because it blocks checkout.
