# product-info

| | |
| --- | --- |
| **Source** | `src/plugins/product-info/` |
| **Integration type** | Plain source folder (copied, not a submodule or npm package) |
| **Ported from** | `agx-stores` — `src/plugins/product-info/` |
| **Ported on** | 2026-09-02 |
| **Status** | Ported and typechecks; **runtime verification outstanding** |
| **Vendure compatibility** | `^3.0.0` |
| **External npm dependencies** | None to install — see [Dependencies](#dependencies) |

## Summary

Exports product variant data to CSV for stock-takes and offline analysis. Two
reports: every live variant, and only those below a low-stock threshold.

It is **headless** — no GraphQL API, no REST controller, no entities, no custom
fields, no jobs, and a `configuration()` that returns `config` untouched. The
service is reachable only by running one of the maintenance scripts by hand.

This makes it the structural opposite of [shipping-by-weight](./shipping-by-weight.md),
which registers into `VendureConfig` and is invoked by Vendure itself. Useful
contrast: **a plugin's shape determines what a port has to bring across**, and
here the plugin folder is barely half of it.

## Files

### The plugin

| File | Purpose |
| --- | --- |
| `product-info.plugin.ts` | `@VendurePlugin` class. Registers `ProductInfoService` in DI. `configuration()` is a no-op. |
| `services/product-info.service.ts` | Both export methods, plus a dead `exampleMethod()`. |
| `constants.ts` | Options injection token and `loggerCtx` (`loggerCtx` is unused — the service uses a local `logCtx` instead). |
| `types.ts` | `PluginInitOptions`. Vestigial — see [Known issues](#known-issues). |

### The callers — outside the plugin folder

| File | Purpose |
| --- | --- |
| `src/scripts/export-all-variants.ts` | Boots a worker, calls `exportAllVariantsToCsv()`. |
| `src/scripts/export-low-stock-variants.ts` | Boots a worker, calls `exportLowStockVariantsToCsv()`. |

Both follow the same three steps:

```ts
const { app } = await bootstrapWorker(config);
const productInfoService = app.get(ProductInfoService);
const ctx = await app.get(RequestContextService).create({ apiType: 'admin' });
```

`bootstrapWorker` rather than `bootstrap` because the script needs the DI
container and a DB connection but no HTTP listener.

**Copying only `src/plugins/product-info/` yields a service that compiles,
registers, and can never be called.** Nothing inside the plugin invokes it.

## Integration points

Registered in `src/vendure-config.ts`:

```ts
import { ProductInfoPlugin } from './plugins/product-info/product-info.plugin';
// ...
ProductInfoPlugin.init({}),
```

Registration is required — not because the plugin adds anything to the config,
but because it is what puts `ProductInfoService` in the DI container for
`app.get()` to find.

Run via the aliases added to `package.json`:

```bash
npm run export:variants
npm run export:low-stock
```

## Dependencies

| Dependency | Status |
| --- | --- |
| `@vendure/core` | ✅ Already a dependency |
| `@nestjs/common` (`Injectable`, `Inject`) | ⚠️ **Not a direct dependency.** Resolves by npm hoisting from `@vendure/core`'s own `^11.0.12` (11.2.3 installed). `@vendure/core` does not re-export `Injectable`. Works, but implicit — the same arrangement agx-stores relies on. |
| `fs`, `path` | Node builtins — nothing to install |
| `ts-node` | Already a devDependency; used by the npm aliases |

### Custom fields

Reads `ProductVariant.dimensionWeightG` — but as a **raw SQL string**, not through
the entity:

```ts
'variant."customFieldsDimensionweightg" AS "dimensionWeightG"'
```

Declared centrally in [`src/custom-fields/logistics.ts`](../../src/custom-fields/logistics.ts)
and created by `src/migrations/1788340148959-add-logistics-dimensions.ts` during
the shipping-by-weight port. This plugin **consumes** that column; it does not
own or create it.

Because the reference is a hand-written string, TypeScript cannot check it. A
mismatch surfaces at runtime as `column variant.customFieldsDimensionweightg
does not exist`.

### Database portability

The queries are **Postgres-only**: `STRING_AGG`, `DISTINCT ON`, `::bigint[]`, and
a `GROUP BY` that relies on Postgres's functional-dependency rule to select
non-grouped columns. Fine for this project, which is Postgres-only by design.

## Migrations

**None required, and none should be generated.**

No custom fields, no entities, no `configuration()` changes — `npx vendure migrate -g`
would emit an empty `up()`/`down()` and add a no-op row to the `migrations` table.

## Build and deployment

`agx-stores` excludes `src/scripts/**/*` from its tsconfig, so its scripts are
ts-node-only and never reach `dist/`. **This repo deliberately does not.** With
`include: ["src/**/*.ts"]` and no exclusion, the scripts compile to
`dist/scripts/` and can run on the VM as:

```bash
node dist/scripts/export-all-variants.js
```

`ts-node` is a devDependency and won't necessarily be installed in production, so
compiling them is what makes these scripts usable against the prod database.

`exports/` is gitignored.

## Behaviour and edge cases

- **`LOW_STOCK_THRESHOLD` is hardcoded to `100`** at the top of the service, and
  the comparison is `< 100`, not `<= 100`. Vendure's sample-data populate tends
  to set `stockOnHand` to exactly `100`, so a fresh dev database can produce a
  header-only low-stock CSV. That is correct behaviour, not a failure.
- **`stockOnHand` is gross, not sellable.** The query sums `stockLevel.stockOnHand`
  across all stock locations and ignores `stockAllocated` entirely. Fine for a
  stock-take; misleading if read as availability.
- **No channel filter.** Both queries `leftJoin` channels and `STRING_AGG` their
  codes into a column, but never filter by `ctx.channel`. The export always covers
  every channel regardless of the `RequestContext` it was given.
- **Price selection is arbitrary under multi-currency.** Prices come from a
  separate raw query using `DISTINCT ON ("variantId") ... ORDER BY "variantId", id`,
  which picks the lowest-id price row per variant. With several currencies or
  channel-specific prices, the CSV shows one of them, not necessarily the relevant
  one. The `currency` column at least says which.
- **Output path follows the launch directory.** `path.join(process.cwd(), 'exports')`
  — run from the repo root and files land in `<repo>/exports`; run from anywhere
  else and they follow. See [Known issues](#known-issues).
- **Timestamped filenames**, colons and dots replaced (`new Date().toISOString().replace(/[:.]/g, '-')`),
  so runs never overwrite each other and the directory grows unbounded.
- **CSV quoting** covers `sku`, `variantName`, `channels`, `productGroups` and
  `variantOptions` by doubling embedded quotes. Numeric columns are unquoted.
  Embedded newlines in a product name would still break the row.

## Verification

Four levels, each proving something distinct.

**1. Does it load?**

```bash
npm run export:variants
```

`app.get(ProductInfoService)` throws `Nest could not find ProductInfoService element`
if the plugin isn't registered. Reaching the query at all proves registration.

**2. Does the raw SQL match the schema?**

Implied by level 1 succeeding. If `customFieldsDimensionweightg` were absent,
Postgres would throw rather than return nulls.

**3. Is the data right?**

Compare CSV rows to the database:

```sql
SELECT COUNT(*) FROM product_variant v
  JOIN product p ON p.id = v."productId"
 WHERE v."deletedAt" IS NULL AND p."deletedAt" IS NULL;
```

These must match. A short CSV means the `GROUP BY variant.id, product.id,
translation.name` is collapsing rows — possible where a variant has translations
in more than one language.

Then the round-trip that actually matters: set `dimensionWeightG` to a
recognisable value such as `3000` on one variant, re-run, and confirm it appears
in the `variant:dimensionWeightG` column. This distinguishes "the column exists"
from "the plugin reads the right column" — a typo hitting a different column
would still return a valid column of nulls.

**4. Is the low-stock filter correct?**

```bash
npm run export:low-stock
```

Must be a strict subset of the all-variants export with every `stockOnHand` under
100. Check the distribution first (`SELECT "stockOnHand", COUNT(*) FROM stock_level
GROUP BY 1`) before treating an empty result as a bug.

### CSV columns

`export:variants` —
`productId,variantId,sku,variantName,stockOnHand,channels,currency,price,variant:dimensionWeightG,productGroups,variantOptions`

`export:low-stock` —
`variantId,productId,sku,variantName,stockOnHand,channels,currency,price,variant:dimensionWeightG`

Note the first two columns are swapped between the two reports.

## Port notes

Integration in `agx-stores` was identical — plain source folder, registered as
`ProductInfoPlugin.init({})` (line 1002 of its `vendure-config.ts`), driven by the
same two scripts. All four plugin files were copied verbatim and verified
identical to the source.

Two deliberate differences:

1. **Scripts are compiled**, not excluded from the build. See
   [Build and deployment](#build-and-deployment).
2. **Named npm aliases** (`export:variants`, `export:low-stock`) instead of
   remembering `ts-node ./src/scripts/...`. agx-stores has no such aliases despite
   having ~50 scripts.

This port also establishes `src/scripts/` as the home for maintenance scripts in
this repo — relevant, since agx-stores has 50 of them waiting.

## Known issues

1. **`exampleMethod()` is dead code.** Fetches a `Product` by id and returns it.
   `npx vendure add` scaffolding; nothing calls it. Delete.
2. **`PluginInitOptions { exampleOption?: string }` is vestigial** — never read.
   Same boilerplate as shipping-by-weight.
3. **`process.cwd()` output directory is a deployment hazard.** Under systemd or
   pm2 the CSVs land wherever the unit's `WorkingDirectory` points. The natural
   fix folds #2 and #3 together: replace `exampleOption?: string` with
   `outputDir?: string`, defaulting to the current behaviour, and pass it at
   registration.
4. **`loggerCtx` in `constants.ts` is unused** — the service defines its own
   local `const logCtx = 'ProductInfoService'`. Pick one.
5. **No channel scoping**, despite taking a `RequestContext`. See
   [Behaviour and edge cases](#behaviour-and-edge-cases).
6. **Unbounded `exports/` growth** — nothing prunes old timestamped files.
