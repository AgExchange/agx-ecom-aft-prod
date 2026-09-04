# quote-plugin

| | |
| --- | --- |
| **Source** | `src/plugins/quote-plugin/` |
| **Integration type** | Plain source folder |
| **Ported from** | `agx-stores` — `src/plugins/quote-plugin/` |
| **Ported on** | 2026-09-02 (stage 2) |
| **Status** | Ported. Creation + reference generation **proven**; send/accept blocked — see [Verification](#verification) |
| **Vendure compatibility** | `^3.0.0` |
| **External npm dependencies** | None to install |

## Summary

Adds a quote/negotiation workflow. The central design decision, stated in the
plugin's own source: **a quote is a real `Order` that spends its entire
negotiation in Vendure's own `Draft` state** — never a parallel entity, never a
custom `OrderState`. The negotiation phase is tracked in
`customFields.quoteStatus` instead.

Lifecycle, all within `order.state === 'Draft'`:
`requested → sent → accepted` (the order then transitions `Draft →
ArrangingPayment`), with terminal `rejected` / `expired` / `withdrawn` — the last
returning the order to `AddingItems`, i.e. an ordinary cart. `sent` is
re-enterable: editing and re-sending bumps `quoteRevision` rather than resetting
status.

All Order writes go through the standard `OrderService`, so Vendure's normal
events keep firing and quoted prices survive acceptance without recalculation.

**This is the first plugin in this repo with a database entity.**

## Files

19 files (3 test files excluded — see [Port notes](#port-notes)). Notable ones:

| File | Purpose |
| --- | --- |
| `quote.plugin.ts` | Plugin class; registers 8 Order custom fields, the order process, and the expiry task. |
| `entities/quote-sequence.entity.ts` | `QuoteSequence` — per-channel, per-year counter for quote references. |
| `services/quote.service.ts` | The workflow. |
| `services/quote-reference.service.ts` | Generates `Q-2026-00042` style references under a pessimistic write lock. |
| `services/quote-expiry-sweep.task.ts` | Scheduled task that expires stale quotes. |
| `config/quote-order-process.ts` | Custom `OrderProcess` guarding the Draft-state transitions. |
| `api/` | Shop + admin schema, resolvers, error types, union result resolvers. |
| `dashboard/index.tsx` | Dashboard extension. |
| `README.md` | The plugin's own design notes — kept. |

## Integration points

```ts
QuotePlugin.init({
    defaultQuoteValidityDays: process.env.QUOTE_VALIDITY_DAYS ? parseInt(...) : 7,
    quoteReferencePrefix: process.env.QUOTE_REFERENCE_PREFIX || 'Q',
}),
```

Its `configuration()` does four things — **all self-contained**, which is why
this plugin needed no edits to `src/custom-fields/`:

1. Pushes **8 Order custom fields** (below).
2. Appends `quoteOrderProcess` to `config.orderOptions.process`, preserving
   whatever is already there (`[...(config.orderOptions.process ?? [defaultOrderProcess]), quoteOrderProcess]`).
3. Appends `quoteExpirySweepTask` to `config.schedulerOptions.tasks`.
4. Registers `entities: [QuoteSequence]`.

Plus `shopApiExtensions`, `adminApiExtensions`, and `dashboard`.

### Custom fields (Order) — owned by the plugin

| Field | Type | Notes |
| --- | --- | --- |
| `quoteValidUntil`, `quoteAcceptedAt`, `quoteRequestedAt`, `quoteSentAt` | `datetime` | Last two are `readonly` |
| `quoteReference` | `string` | e.g. `Q-2026-00042` |
| `quoteNotes` | `text` | |
| `quoteStatus` | `string` | `readonly`, with `options` for the six states |
| `quoteRevision` | `int` | `readonly` |

Four of these carry **both** `readonly: true` and `ui: { dashboard: false }`. The
source explains why at length and it is worth preserving: `readonly` alone does
not stop the Dashboard's generic order-customFields panel from fetching every
`public` field into form state and resubmitting the whole blob on save, which the
server then rejects — *"Field \"quoteStatus\" is not defined by type
\"UpdateOrderCustomFieldsInput\""*. `ui.dashboard: false` makes the **server**
omit them from `serverConfig.entityCustomFields` entirely, so the generic form
never learns they exist. The plugin's own dashboard panel still reads them,
because it uses hand-written GraphQL documents rather than the auto-introspected
ones.

### API surface

**Shop API** — `quoteByReference`; `requestQuote`, `withdrawQuoteRequest`,
`acceptQuote`, `rejectQuote`.

**Admin API** — `quotes`; `createQuote`, `sendQuote`, `setQuoteValidity`,
`updateQuoteNotes`, `acceptQuote`.

All confirmed present in the running schema.

## Migration

`src/migrations/1788352280095-stage-2-cms-pim-quote-multivendor.ts`, shared with
the other three stage-2 plugins. This plugin contributes:

```sql
CREATE TABLE "quote_sequence" (
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  "year" integer NOT NULL,
  "lastValue" integer NOT NULL DEFAULT '0',
  "id" SERIAL NOT NULL,
  "channelId" integer NOT NULL,
  CONSTRAINT "UQ_f107310396e81613bd0feec1563" UNIQUE ("channelId", "year"),
  CONSTRAINT "PK_0985d703eac571ebae9e02b9e2f" PRIMARY KEY ("id")
);
```

plus the 8 `order.customFieldsQuote*` columns.

### A note on the unique constraint

agx-stores needed **two** migrations to reach this state. Its original
hand-written `1782248527000-add-quote-fields.ts` created a bare
`CREATE UNIQUE INDEX "UQ_quote_sequence_channel_year"`, which TypeORM's
schema-diff did not recognise as satisfying `@Unique(['channelId', 'year'])` —
producing permanent startup drift. A second migration,
`1783400000000-fix-quote-sequence-unique-constraint.ts`, dropped the index and
added the named constraint `UQ_f107310396e81613bd0feec1563`.

Our generated `CREATE TABLE` emits that exact constraint name in one step. This
is the clearest justification so far for regenerating migrations while still
pre-production.

## Verification

**Proven:**

- Source byte-identical to agx-stores (minus excluded test files)
- `npx tsc --noEmit` — exit 0
- Server boots with no errors
- `quote_sequence` table exists with the correct `PRIMARY KEY` and named
  `UNIQUE CONSTRAINT`, verified via `\d quote_sequence`
- All 8 Order columns present
- All 5 admin mutations, 1 admin query, 4 shop mutations and 1 shop query present
  in the introspected schema
- Dashboard extension bundled (`Quote` strings present in `dist/dashboard/`)

### Workflow exercised 2026-09-03 (admin path)

**Proven by running it against the dev database:**

- `createQuote` sets `quoteStatus: "requested"`, stamps `quoteRequestedAt`, and
  defaults `quoteValidUntil` to **+7 days** — i.e. `QUOTE_VALIDITY_DAYS` from `.env`
  is read correctly.
- **Reference generation works and increments**: three quotes produced
  `Q-2026-00001`, `Q-2026-00002`, `Q-2026-00003`, and the `quote_sequence` table
  holds exactly one row — `year: 2026, lastValue: 3, channelId: 1` — correctly
  scoped per channel and year, with no gaps.
- `updateQuoteNotes` and `setQuoteValidity` both persist (validity moved +7 -> +14 days).
- **Business rules fire with clear messages**, rather than failing silently:
  - *"This order needs a customer assigned before it can become a quote."*
  - *"A quote must have a shipping method assigned before it can be sent."*

**Blocked, not failed:** `sendQuote` and `acceptQuote` could not be reached, because
the prerequisite `setDraftOrderShippingMethod` **hangs indefinitely** and wedges the
database connection. That is a Vendure core path, not a quote-plugin defect — see
[multivendor-plugin](./multivendor-plugin.md), which replaces
`shippingLineAssignmentStrategy` and is the prime suspect (unproven).

**Still not proven:**

- `sendQuote`, the re-send `quoteRevision` bump, and `acceptQuote` (blocked above)
- The pessimistic lock **under concurrency** — the test was single-threaded, so it
  proved the counter increments, not that it is race-safe
- `quoteExpirySweepTask` firing
- The dashboard panel rendering
- The shop-API path (`requestQuote` etc.), which needs a registered, verified
  customer — the dev database has none
- Interaction with `defaultOrderProcess` and multivendor's `mvOrderProcess`

To exercise it: create a draft order, call `requestQuote` on the Shop API,
`sendQuote` on the Admin API, then `acceptQuote`, checking `quoteStatus` and
`quoteReference` at each step and confirming the order lands in
`ArrangingPayment`.

## Port notes

Registered identically to agx-stores (line 1077 of its `vendure-config.ts`) with
the same two options.

**Excluded:** `quote.e2e-spec.ts`, `helpers/quote.helpers.spec.ts`, and
`e2e/fixtures/`. They require `@vendure/testing` and `vitest`, neither installed.
`quote.helpers.spec.ts` uses only `node:test` and `node:assert/strict`, so it
could be restored and run with `node --test` at no dependency cost — worth doing
when test setup becomes its own task.

## Known issues

1. **No test coverage in this repo.** The plugin ships three test files and none
   were ported. Given this is the most stateful plugin in the batch — a counter
   with a concurrency lock and a six-state machine — that is the largest gap in
   stage 2.
2. **Registration order matters and is undocumented in the plugin.** Both this
   plugin and `multivendor-plugin` append to `config.orderOptions.process`. The
   resulting order is `[defaultOrderProcess, quoteOrderProcess, mvOrderProcess]`,
   matching agx-stores only because the registration order in
   `vendure-config.ts` matches. Reordering the plugins array silently reorders
   the order process chain.
