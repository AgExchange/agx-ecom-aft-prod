# pim-sync

| | |
| --- | --- |
| **Source** | `src/plugins/pim-sync/` |
| **Integration type** | Plain source folder |
| **Ported from** | `agx-stores` — `src/plugins/pim-sync/` |
| **Ported on** | 2026-09-02 (stage 2) |
| **Status** | Ported; structurally verified. **No sync tested — no AtroPIM instance in local dev** |
| **Vendure compatibility** | `^3.0.0` |
| **External npm dependencies** | None to install |
| **External service** | AtroPIM (`PIM_URL`, `PIM_USER`, `PIM_PASSWORD`) |

## Summary

Imports the product catalogue from **AtroPIM** into Vendure: products and
variants, facets, assets, and price/stock levels. Supports a full sync and a
delta sync from a watermark, both dispatched onto a job queue and run on the
worker.

It is the **largest and most consequential plugin in the batch** — it is the
thing that populates the catalogue, and it writes fields other plugins read.

The plugin ships its own `AGENTS.md` with implementation notes; that file was kept.

## Files

15 files. Notable ones:

| File | Purpose |
| --- | --- |
| `pim-sync.plugin.ts` | Plugin class. Creates the sync job queue in `onModuleInit`. |
| `services/pim-api.service.ts` | AtroPIM HTTP client. |
| `services/pim-sync.service.ts` | Orchestrates a sync run. |
| `services/product-upsert.service.ts` | Creates/updates Products and Variants. Writes `customFields.detail`. |
| `services/facet-sync.service.ts` | Facets and facet values. |
| `services/asset-sync.service.ts` | Downloads and attaches product images. |
| `services/price-stock-sync.service.ts` | Prices and stock levels. |
| `services/price-stock-audit.ts` | Audit trail for price/stock changes. |
| `api/` | Admin schema + resolver. |
| `dashboard/index.tsx` | Dashboard extension — "Catalogue Sync". |
| `AGENTS.md` | The plugin's own implementation notes. |

## Integration points

```ts
PimSyncPlugin.init({
    pimUrl: process.env.PIM_URL!,
    pimUser: process.env.PIM_USER!,
    pimPassword: process.env.PIM_PASSWORD!,
    partTypeGroupCode: process.env.PIM_PART_TYPE_GROUP_CODE,
    pageSize: ..., fetchTimeoutMs: ..., imageFetchTimeoutMs: ...,
    statusFilePath: ..., shopApiWarmupUrl: ..., warmupDelayMs: ...,
}),
```

**It has no `configuration()` at all** — it mutates nothing on `VendureConfig`.
Everything is `providers`, `adminApiExtensions`, `dashboard`, and an
`onModuleInit` that creates the sync queue.

`PimSyncOptions` declares six further options that this repo does **not** wire,
matching agx-stores exactly: `deltaMaxAgeDays`, `attrFetchConcurrency`,
`maxProductImages`, `collectionChunkSize`, `stockLocationName`,
`shopApiWarmupChannelToken`. All fall back to in-code defaults.

### API surface

| Operation | Type |
| --- | --- |
| `getPimSyncStatus` | Query |
| `triggerPimSync(includePriceStock: Boolean)` | Mutation |
| `triggerPimDeltaSync(includePriceStock: Boolean)` | Mutation |

All three confirmed present in the running admin schema.

## Dependencies

### Custom fields it writes — but does not declare

This is the important part. `pim-sync` **writes** three Product custom fields but
declares none of them:

| Field | Written where |
| --- | --- |
| `detail` | `product-upsert.service.ts:578,640` |
| `specification` | `product-upsert.service.ts` |
| `mpn` | used as the canonical key to locate the Vendure Product |

They are declared centrally in
[`src/custom-fields/product-content.ts`](../../src/custom-fields/product-content.ts),
because `mpn` and `detail` are catalogue-identity fields the storefront also
consumes. Copying the plugin folder alone would have produced a sync that writes
to columns that do not exist.

It also **writes `ProductVariant.dimensionWeightG`** — the field
[shipping-by-weight](./shipping-by-weight.md) reads. Those two plugins are the
producer and consumer of the same column, which is precisely why the logistics
fields live in `src/custom-fields/` rather than inside either plugin.

### Filesystem and network

Uses `fs`, `path`, `http`, `https`, `stream`. Writes a status file (default
`cwd/logs/pim-sync-status.json`, overridable via `PIM_SYNC_STATUS_FILE`) and
downloads images over the network.

## Migration

Contributes to `src/migrations/1788352280095-stage-2-cms-pim-quote-multivendor.ts`:

```sql
ALTER TABLE "product_translation" ADD "customFieldsDetail" text;
ALTER TABLE "product_translation" ADD "customFieldsSpecification" text;
ALTER TABLE "product_translation" ADD "customFieldsSeotitle" character varying(255);
ALTER TABLE "product_translation" ADD "customFieldsSeodescription" character varying(255);
ALTER TABLE "product"             ADD "customFieldsMpn" character varying(255);
CREATE INDEX "IDX_product_customFieldsMpn" ON "product" ("customFieldsMpn");
```

`detail` and `specification` are `localeText` and `seoTitle`/`seoDescription` are
`localeString`, so all four land on **`product_translation`**, not `product`.
Only `mpn` is a plain column on `product`.

### The `mpn` index and migration drift

**Read this before running `vendure migrate -g` again.**

Vendure's custom field config supports `unique` but has **no `index` option**
(verified against `@vendure/core` 3.7.2's `custom-field-types.d.ts`). There is
therefore no declarative way to index `customFieldsMpn`, and the `CREATE INDEX`
above is **hand-written** into the generated migration.

Because TypeORM's entity metadata does not know the index exists, **every future
`npx vendure migrate -g` will emit a spurious `DROP INDEX
"IDX_product_customFieldsMpn"`.** Delete that line from the generated file before
running it, or the sync silently loses its index and degrades to a sequential
scan on every product lookup.

This is not new. agx-stores hit it twice — both
`1783342397265-add-address-geo-coordinates.ts` and
`1783706331881-add-quote-status-fields.ts` carry comments about hand-trimming the
same statement out of their generated diffs. It is reproduced here deliberately:
`mpn` is the sync's primary lookup key, so the index matters more on the sync path
than the migration inconvenience costs.

## Verification

**Proven:**

- Source byte-identical to agx-stores
- `npx tsc --noEmit` — exit 0
- Server boots and logs `[PimSyncPlugin] PimSyncPlugin initialized`, confirming
  `onModuleInit` ran and the sync queue was created
- All three admin operations present in the introspected schema
- Dashboard extension bundled (`Catalogue Sync` / `catalogue-sync` present in
  `dist/dashboard/`)
- All five columns and the `mpn` index verified in Postgres

**Not proven — requires an AtroPIM instance:**

- Authentication against AtroPIM
- Any catalogue fetch, product upsert, facet sync, asset download, or price/stock
  update
- Delta-sync watermark handling
- Status file writing
- The shop-API warmup path
- That `detail`/`specification`/`mpn` are written in the shape the columns expect

With the credentials unset the plugin loads normally; failures occur only when a
sync is triggered.

## Port notes

Registered identically to agx-stores (line 1006 of its `vendure-config.ts`) with
the same ten wired options. All 15 files copied verbatim, `AGENTS.md` included.

The only difference is that credentials are absent locally and documented as blank
in `.env.example`.

## Known issues

1. **Non-null assertions on possibly-absent env vars.** `process.env.PIM_URL!`
   and friends assert non-null, so with the vars unset the plugin receives
   `undefined` at runtime with no startup warning. A boot-time check would turn a
   confusing runtime failure into a clear one — though it must not throw, or local
   dev without credentials would stop booting.
2. **The `mpn` index causes recurring generator drift.** See above.
3. **Six options are unwired**, matching agx-stores. If any of those defaults
   turn out to be wrong for production, the fix is in `vendure-config.ts`, not the
   plugin.
4. **No test coverage.**
