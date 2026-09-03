# dsv-sadc-ui

| | |
| --- | --- |
| **Source** | `src/plugins/dsv-sadc-ui/` |
| **Integration type** | Plain source folder |
| **Ported from** | `agx-stores` — `src/plugins/dsv-sadc-ui/` |
| **Ported on** | 2026-09-03 (stage 4) |
| **Status** | Ported; extension confirmed in the bundle |
| **Vendure compatibility** | Not declared (see [Known issues](#known-issues)) |
| **External npm dependencies** | None |

## Summary

Dashboard-only companion to [dsv-sadc-plugin](./dsv-sadc-plugin.md). Two pieces:

- a **DSV Labels** block for retrieving shipping labels
- a custom timeline component for `DSV_SADC_TRACKING` order-history entries, which
  localises DSV's event timestamps (stored as canonical UTC) into the viewer's
  timezone

No backend logic, no entities, no API. The entire server-side plugin is:

```ts
@VendurePlugin({ dashboard: './dashboard/index.tsx' })
export class DsvSadcUiPlugin {}
```

Same shape as [order-metadata-ui](./order-metadata-ui.md).

## Why it cannot be ported alone

The history entry type, its GraphQL enum member, and the webhook that emits those
entries all live in `dsv-sadc-plugin`. Without it, this renders a timeline for events
that are never created. The two were ported together in stage 4 for that reason.

## Files

| File | Purpose |
| --- | --- |
| `dsv-sadc-ui.plugin.ts` | Plugin class — four lines. |
| `dashboard/index.tsx` | `defineDashboardExtension` entry. |
| `dashboard/components/DsvSadcLabels.tsx` | Label retrieval block. |
| `dashboard/components/DsvSadcTrackingEntry.tsx` | Timeline component for tracking entries. |

## Integration points

Registered **bare** — no `.init()`, no options:

```ts
import { DsvSadcUiPlugin } from './plugins/dsv-sadc-ui/dsv-sadc-ui.plugin';
// ...
DsvSadcUiPlugin,
```

## Migration

**None.** No custom fields, no entities.

## Verification

**Proven:**

- `npx tsc --noEmit` — exit 0
- Server boots clean
- **Extension bundled**, confirmed after `rm -rf dist/dashboard` and a clean rebuild:
  `dsv-sadc-labels` (1), `DSV Labels` (1) and `DSV_SADC_TRACKING` (2) all present in
  `dist/dashboard/`. The clean rebuild matters — the directory is not emptied between
  builds, so a stale chunk can otherwise produce a false positive.

**Not proven:**

- The blocks rendering in the dashboard (needs a browser)
- Label retrieval, which requires real DSV SADC credentials
- The tracking timeline, which requires `DSV_SADC_TRACKING` history entries — created
  only by the webhook, so it needs a live DSV callback

## Known issues

1. **No `compatibility` field**, so Vendure logs *"does not specify a compatibility
   range"* on every boot. Every other ported plugin except `dsv-shipping-plugin`
   declares `^3.0.0`.
2. **No `imports: [PluginCommonModule]`** — harmless for a dashboard-only plugin, but
   inconsistent with the rest.
3. **The dependency on `dsv-sadc-plugin` is implicit.** Nothing enforces it; removing
   that plugin leaves this one rendering an empty timeline with no warning.
