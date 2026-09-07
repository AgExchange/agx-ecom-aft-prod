# agx-aft-vendure documentation

## Start here

| Document | What it covers |
| --- | --- |
| [plugins/plugin-overview.md](./plugins/plugin-overview.md) | Index of all 13 ported plugins, with status, plus verification gotchas |
| [parity-with-agx-stores.md](./parity-with-agx-stores.md) | What still differs from `agx-stores`, and the plan to close it |

## Open issues

Two are inherited from `agx-stores` — keeping them *is* parity, but they are bugs in
both. The third is ours to answer.

| Issue | Where | Impact |
| --- | --- | --- |
| **Checkout hang** — `setDraftOrderShippingMethod` never returns and wedges the DB connection | [plugins/multivendor-plugin.md](./plugins/multivendor-plugin.md) (Known issues) | **Blocks every order.** Prime suspect is multivendor's `shippingLineAssignmentStrategy`, unproven |
| **DSV never reads real variant dimensions** — every package quotes as 1 kg / 30x20x20 cm | [plugins/dsv-shipping-plugin-dimensions-bug.md](./plugins/dsv-shipping-plugin-dimensions-bug.md) | Wrong shipping prices. Live in agx-stores too |
| **CMS "Sync to CMS" buttons call a mutation that does not exist** | [plugins/cms.md](./plugins/cms.md) (Known issues) | Buttons disabled with a TODO. Broken in agx-stores too |

## Things that will bite you

**The `mpn` index drift.** Every `npx vendure migrate -g` from now on emits a
spurious `DROP INDEX "IDX_product_customFieldsMpn"`. **Delete that line before
running the migration** or the PIM sync silently loses its primary lookup index.
Full explanation in [plugins/pim-sync.md](./plugins/pim-sync.md).

**`dist/dashboard/` is not emptied between builds.** Old hashed chunks accumulate, so
grepping it can return matches from a previous build. Always `rm -rf dist/dashboard`
first when the grep result is the thing you are trying to prove.

**Three plugins throw at boot on missing env vars** — `dsv-shipping-plugin`,
`dsv-sadc-plugin` and `dpo-plugin` all validate their options and refuse to start.
`.env` carries obvious placeholders (`unset@invalid.local`, `https://unset.invalid`)
so local dev boots. This is deliberate: it means a misconfigured production deploy
fails loudly at startup rather than silently at payment time.

## How the code is organised

Conventions established during the port, which differ from agx-stores' single large
config file:

| Directory | Holds |
| --- | --- |
| `src/plugins/` | One folder per plugin, all plain source, imported relatively |
| `src/custom-fields/` | One module per domain, composed in `index.ts`. A field used by one plugin lives in that plugin; a field shared across plugins lives here |
| `src/events/` | `VendureEvent` subclasses that cross a plugin boundary |
| `src/migrations/` | One migration per stage, not per plugin |
| `src/scripts/` | Maintenance scripts run by hand, grouped by purpose. `catalogue-exports/` boots a Vendure worker and writes CSVs (`npm run export:variants`); `connectivity-checks/` probes an external service without starting Vendure (`npm run check:pim`) |

## Migration strategy

The target is a **fresh, empty production database**, so the migration history stays
**regenerable** until its first production run. If a migration comes out wrong, the
cheapest fix is still to wipe the dev database and regenerate rather than hand-patch.

**That freedom ends the moment production runs these migrations.** From then on the
history is append-only.
