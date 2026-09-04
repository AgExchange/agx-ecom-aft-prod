# multivendor-plugin

| | |
| --- | --- |
| **Source** | `src/plugins/multivendor-plugin/` |
| **Integration type** | Plain source folder |
| **Ported from** | `agx-stores` — `src/plugins/multivendor-plugin/` |
| **Ported on** | 2026-09-02 (stage 2) |
| **Status** | Ported; structurally verified. Marketplace flow not exercised |
| **Vendure compatibility** | `^3.0.0` |
| **External npm dependencies** | None to install |

## Summary

Turns the store into a marketplace: sellers are onboarded into their own channels,
a single customer order is split into per-seller orders, a platform fee is
deducted per seller, and settlement is handled by a dedicated payment method.

**It replaces more core configuration than any other plugin in this repo** — two
outright strategy replacements plus four appends. That makes registration order
significant, and makes this the plugin most likely to interact badly with a
future one.

## Files

16 files (2 test files excluded). Notable ones:

| File | Purpose |
| --- | --- |
| `multivendor.plugin.ts` | Plugin class; 3 custom fields and six config mutations. |
| `config/mv-order-seller-strategy.ts` | `MultivendorSellerStrategy` — splits orders and applies the platform fee in `afterSellerOrdersCreated`. |
| `config/mv-order-process.ts` | Marketplace-specific `OrderProcess`. |
| `config/mv-settlement-payment-handler.ts` | Settlement payment method handler + eligibility checker. |
| `config/mv-shipping-line-assignment-strategy.ts` | Assigns shipping lines to seller orders. |
| `config/mv-shipping-eligibility-checker.ts` | Marketplace shipping eligibility. |
| `services/mv.service.ts` | Seller onboarding, channel creation, payouts. |
| `api/` | Admin + shop schema, three resolvers. |
| `dashboard/index.tsx` | Dashboard extension (uses `@tanstack/react-router`). |

## Integration points

```ts
MultivendorPlugin.init(),
```

No options — but note it is `.init()` with no argument, not a bare class.

### What `configuration()` changes

| Target | Operation |
| --- | --- |
| `config.customFields.Seller` | **push** `sellerOnboardingNote`, `platformFeePercent` |
| `config.customFields.Order` | **push** `payoutStatus` |
| `config.orderOptions.orderSellerStrategy` | **replace** with `MultivendorSellerStrategy` |
| `config.orderOptions.process` | **append** `mvOrderProcess` |
| `config.shippingOptions.shippingEligibilityCheckers` | **append** `mvShippingEligibilityChecker` |
| `config.shippingOptions.shippingLineAssignmentStrategy` | **replace** with `mvShippingLineAssignmentStrategy` |
| `config.paymentOptions.paymentMethodHandlers` | **append** `mvSettlementPaymentHandler` |
| `config.paymentOptions.paymentMethodEligibilityCheckers` | **append** `mvSettlementPaymentEligibilityChecker` |

The two **replacements** are the ones to watch: `orderSellerStrategy` and
`shippingLineAssignmentStrategy` are single-valued, so this plugin wins outright
over anything set earlier. Nothing else in this repo sets either today.

The appends are all defensive (`[...(config.X ?? []), ...]`), so they coexist
with earlier plugins. In particular `mvShippingEligibilityChecker` sits alongside
[shipping-by-weight](./shipping-by-weight.md)'s
`weightBasedShippingEligibilityChecker` — both appear in the dashboard dropdown
and both remain selectable per shipping method.

### Custom fields — owned by the plugin

| Entity | Field | Type | Notes |
| --- | --- | --- | --- |
| `Seller` | `sellerOnboardingNote` | `text` | Nullable, admin-only. |
| `Seller` | `platformFeePercent` | `float` | **Not nullable**, default `10`, `min: 0`, `max: 100`. Replaces a former global `MV_PLATFORM_FEE_PERCENT` env var — editable per seller. |
| `Order` | `payoutStatus` | `string` | `readonly` + `ui: { dashboard: false }`, for the same reason quote-plugin's fields are — the source cross-references `quote-plugin/quote.plugin.ts`. |

Declared inside the plugin, so nothing was added to `src/custom-fields/`.

### API surface

**Admin** — `onboardSeller`, `markPayoutsPaid` (alongside core's `createSeller`,
`updateSeller`, `deleteSeller`, `deleteSellers`).
**Shop** — registered via `shopApiExtensions` with `MultivendorShopResolver`.

Also registers `MultivendorSellerEntityResolver`, a field resolver extending the
`Seller` type.

## Migration

Contributes to `src/migrations/1788352280095-stage-2-cms-pim-quote-multivendor.ts`:

```sql
ALTER TABLE "order"  ADD "customFieldsPayoutstatus" character varying(255);
ALTER TABLE "seller" ADD "customFieldsSelleronboardingnote" text;
ALTER TABLE "seller" ADD "customFieldsPlatformfeepercent" double precision NOT NULL DEFAULT '10';
```

### agx-stores has no migration for these

Grepping agx-stores' entire `src/migrations/` for `platformfeepercent`,
`selleronboardingnote` or `payoutstatus` returns **nothing**. Its production
database must have acquired these columns by some route other than a committed
migration.

This repo's stage-2 migration is therefore **more complete than the reference**.
That is the correct state, but it is a difference worth knowing about: if the
production database is ever rebuilt from agx-stores' migration history, these
three columns would be missing.

## Verification

**Proven:**

- Source byte-identical to agx-stores (minus excluded test files)
- `npx tsc --noEmit` — exit 0
- Server boots with no errors and no strategy-conflict warnings
- All three columns present in Postgres
- `onboardSeller` and `markPayoutsPaid` present in the introspected admin schema
- Dashboard extension bundled

**Not proven — no marketplace flow was exercised:**

- Seller onboarding and channel creation
- Order splitting by `MultivendorSellerStrategy`
- Platform fee calculation in `afterSellerOrdersCreated`
- The settlement payment handler
- Shipping line assignment across seller orders
- `markPayoutsPaid`
- The dashboard route rendering

This is the largest untested surface in stage 2, because the plugin's value is
entirely in behaviour that only appears during a real multi-seller checkout.

## Port notes

Registered identically to agx-stores (line 1083 of its `vendure-config.ts`), as
`MultivendorPlugin.init()`.

**Excluded:** `multivendor.e2e-spec.ts` and `e2e/fixtures/` (an `initial-data.ts`
and a products CSV). They require `@vendure/testing` and `vitest`. Note the
fixtures are not just test scaffolding — they describe a working marketplace
setup, so they are worth restoring when test setup becomes its own task.

## Known issues

0. **SUSPECTED: `setDraftOrderShippingMethod` hangs.** Reproducible in a clean
   environment with this plugin active — the request never returns, the Postgres
   session is left `idle in transaction` waiting on `ClientRead` after a
   `ShippingMethodTranslation` query, and the server logs
   *"Calling client.query() when the client is already executing a query"* — i.e.
   two queries racing on one connection, which `node-postgres` does not support.
   The connection is unusable afterwards.

   This plugin **replaces** `config.shippingOptions.shippingLineAssignmentStrategy`,
   so `MultivendorShippingLineAssignmentStrategy` runs on exactly this path, which
   makes it the prime suspect. **It is not proven.** Reading the strategy
   (`config/mv-shipping-line-assignment-strategy.ts`) shows only sequential awaits
   and no `Promise.all`, so the mechanism is not obvious. An isolation run — one
   server, this plugin commented out, single request — would settle it in minutes.

   One untested lead: an order *with* a shipping address behaved differently from one
   without, so a missing address may be the trigger.

   **This path is on every order**, so it blocks real checkout and should be resolved
   before go-live. It also blocked verification of
   [quote-plugin](./quote-plugin.md)'s send/accept steps.

1. **Two single-valued strategy replacements.** `orderSellerStrategy` and
   `shippingLineAssignmentStrategy` are overwritten, not composed. Any future
   plugin needing either will conflict silently — last registration wins, with no
   warning.
2. **Registration order is load-bearing.** This plugin and
   [quote-plugin](./quote-plugin.md) both append to `config.orderOptions.process`,
   producing `[defaultOrderProcess, quoteOrderProcess, mvOrderProcess]`. That
   matches agx-stores only because the plugins array order matches. Reordering
   silently reorders the order-process chain.
3. **No migration exists upstream** for its three custom fields. See above.
4. **`platformFeePercent` is `nullable: false` with a default of 10**, so applying
   the migration silently sets a 10% platform fee on every existing seller.
5. **No test coverage** — and the excluded e2e spec is the only description of the
   intended end-to-end flow.
