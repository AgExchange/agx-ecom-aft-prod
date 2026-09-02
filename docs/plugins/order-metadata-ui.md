# order-metadata-ui

| | |
| --- | --- |
| **Source** | `src/plugins/order-metadata-ui/` |
| **Integration type** | Plain source folder (copied, not a submodule or npm package) |
| **Ported from** | `agx-stores` — `src/plugins/order-metadata-ui/` |
| **Ported on** | 2026-09-02 (stage 1) |
| **Status** | Ported; migration applied; extension confirmed in the bundle |
| **Vendure compatibility** | `^3.0.0` |
| **External npm dependencies** | None — `@vendure/core` and `@vendure/dashboard` only |

## Summary

Adds a **"Part Metadata"** block to the order detail page in the Dashboard,
showing the machine metadata collected from the customer during checkout: which
machine the part is for, its brand and model, and category-specific details
(serial number for axles, engine number for engines, filter type for filters).

It is a **pure Dashboard UI extension** — no API, no service, no entities, no
jobs, no env vars, and no `configuration()` at all. The entire server-side plugin
is four lines:

```ts
@VendurePlugin({
    compatibility: '^3.0.0',
    dashboard: './dashboard/index.tsx',
})
export class OrderMetadataUiPlugin {}
```

This is the first plugin in this repo to use the `dashboard` property, and it
proves the extension build path that `cms`, `pim-sync`, `multivendor-plugin` and
`quote-plugin` all depend on.

## Files

| File | Purpose |
| --- | --- |
| `order-metadata-ui.plugin.ts` | The `@VendurePlugin` class. Points `dashboard` at the entry `.tsx`. |
| `dashboard/index.tsx` | Calls `defineDashboardExtension({ pageBlocks: [...] })` to place the block. |
| `dashboard/components/OrderLineMetadataBlock.tsx` | The React component — badge, per-category fields, quantity. |

## Integration points

Registered **bare** in `src/vendure-config.ts` — no `.init()`, because there are
no options:

```ts
import { OrderMetadataUiPlugin } from './plugins/order-metadata-ui/order-metadata-ui.plugin';
// ...
OrderMetadataUiPlugin,
```

A third registration style, after `.init({})` (`shipping-by-weight`,
`product-info`) and config-mutating (`shipping-by-weight`'s `configuration()`).

### Block placement

```ts
location: {
    pageId: 'order-detail',
    column: 'main',
    position: { blockId: 'order-table', order: 'after' },
}
```

The block is anchored **relative to an existing block** (`order-table`) rather
than to a fixed position, so it moves with the order table if the dashboard's
layout changes.

### Why there is no GraphQL query

The component reads `context.entity.lines[].customFields` directly. No
`extendDetailDocument` is needed because the order-detail page already calls
`addCustomFields(orderDetailDocument, { includeNestedFragments: ['OrderLine'] })`,
which pulls in every registered `OrderLine` custom field automatically.

That is a **load-bearing coupling to Vendure internals**: the block works only
because of what the core order-detail page happens to request. Worth re-checking
on a Vendure upgrade.

## Dependencies

### Custom fields — 14 on `OrderLine`

Declared in [`src/custom-fields/order-metadata.ts`](../../src/custom-fields/order-metadata.ts)
and composed into `src/custom-fields/index.ts`. The block reads all of them.

| Field | Type | Applies to |
| --- | --- | --- |
| `metadataCategory` | `string` | All — drives everything below |
| `machineBrand`, `machineModel` | `string` | Axle, Engine, Filter |
| `serialNumber`, `serialNumberPhotoAssetId` | `string` | Axle |
| `engineApplication`, `engineNumber` | `string` | Engine |
| `filterAirInner`, `filterAirOuter`, `filterFuel`, `filterHydraulic`, `filterOil`, `filterSteering`, `filterTransmission` | `boolean` | Filter |

The seven filter booleans are `nullable: false` with `defaultValue: false`, so
they become `NOT NULL DEFAULT false` columns. Exactly one is expected to be true
per line — multiple filter types for one machine require separate
`addItemToOrder` calls. `getFilterType()` returns the **first** true flag in
`FILTER_LABELS` order, so a line with two flags set silently reports only one.

All fourteen carry `ui: { dashboard: false }`. They are hidden from the standard
custom-field form because this block presents them itself. Removing that flag
would render them as a flat fourteen-input card *in addition to* the block.

### Migration

`src/migrations/1788351418720-stage-1-order-metadata-and-contact.ts` — a
stage-level migration shared with [contact](./contact.md). Adds 14 `order_line`
columns and 1 `channel` column; no drops.

The 14 `order_line` statements match agx-stores'
`1773332680922-add-custom-fields-to-orderline.ts` statement for statement.

Column names are lowercased by Vendure: `machineBrand` →
`customFieldsMachinebrand`, `serialNumberPhotoAssetId` →
`customFieldsSerialnumberphotoassetid`.

## Behaviour and edge cases

- **`metadataCategory` gates everything.** `OrderLineMetadataBlock` filters to
  lines where it is truthy, and `LineMetadataPanel` returns `null` without it. A
  line with `machineBrand` set but no `metadataCategory` renders nothing at all.
- **Empty state is explicit** — "No part metadata for this order." rather than a
  blank block, so the block is always visible on the order page once the plugin
  is registered. Useful for verification.
- **Unknown categories degrade gracefully.** `CATEGORY_STYLES` falls back to grey
  for any value other than `axle`, `engine`, `filter`, and the category-specific
  field groups simply don't render.
- **`Field` hides empty values** — it returns `null` for `null`, `undefined` or
  `''`, so partial metadata renders as a shorter row rather than blank labels.
- **`serialNumberPhotoAssetId` renders as text**, formatted `Asset:<id>`. It is
  not resolved to a thumbnail or a link, so staff must look the asset up
  manually.

## Verification

1. **Typecheck** — `npx tsc --noEmit`. Note the `.tsx` files are *excluded* from
   `tsconfig.json` and covered by `tsconfig.dashboard.json` instead, so a server
   typecheck does not check the component.
2. **Migration applied** — 14 `customFields*` columns on `order_line`:
   ```sql
   SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_name = 'order_line' AND column_name LIKE 'customFields%';
   ```
   The seven `filter*` columns must be `boolean`, `NOT NULL`, default `false`.
3. **Dashboard builds** — `npm run build:dashboard`.
4. **Extension is actually bundled** — a successful build is **not** sufficient
   evidence, because the Vite plugin scans the config for extensions and a plugin
   missing from the array builds cleanly and silently renders nothing. Grep the
   output for strings that can only come from this component:
   ```bash
   grep -ro "Part Metadata\|order-line-metadata\|Air Outer" dist/dashboard/
   ```
   All three present → the extension compiled in.
5. **Block renders** — open any order's detail page. With no metadata set, the
   block appears below the order table reading "No part metadata for this order."
   That alone proves placement.
6. **Content renders** — set `metadataCategory` to `axle` and `machineBrand` on an
   order line, reload, and confirm the badge and fields appear. Setting other
   fields *without* `metadataCategory` is not a valid test — the line is filtered
   out.

## Port notes

Integration in `agx-stores` was identical: plain source folder, registered bare as
`OrderMetadataUiPlugin` at line 1003 of its `vendure-config.ts`. All three files
were copied verbatim.

The one difference is where the custom fields live. agx-stores declares all 14
inline in its `vendure-config.ts` (lines ~600–840); here they are a domain module
under `src/custom-fields/`, matching the pattern set by `logistics.ts`. The
generated migration is identical either way.

Note also that agx-stores' history contains the same OrderLine migration **twice**
(`1773332680922` and `1773333339894`, byte-identical in their statements). That
kind of artefact is exactly what this repo's regenerate-while-pre-production
migration strategy is meant to avoid.

## Known issues

1. **Hardcoded hex colours.** `CATEGORY_STYLES`, `CategoryBadge` and `Field` use
   literal values (`#dbeafe`, `#111827`, …) rather than dashboard theme tokens,
   so the block does not follow light/dark mode.
2. **Inline styles throughout** — no CSS modules or utility classes, so nothing is
   shared with the rest of the dashboard's visual language.
3. **`getFilterType()` reports only the first true flag.** If data ever violates
   the one-filter-per-line assumption, the extra flags are invisible rather than
   flagged.
4. **Depends on core's `addCustomFields` call** in `order-detail-shared.tsx` to
   populate `lines[].customFields`. Undocumented as a public contract; verify on
   Vendure upgrades.
5. **`serialNumberPhotoAssetId` is not resolved** to an image or link.
