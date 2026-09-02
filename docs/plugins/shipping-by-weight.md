# shipping-by-weight

| | |
| --- | --- |
| **Source** | `src/plugins/shipping-by-weight/` |
| **Integration type** | Plain source folder (copied, not a submodule or npm package) |
| **Ported from** | `agx-stores` — `src/plugins/shipping-by-weight/` |
| **Ported on** | 2026-09-02 (commit `888bfa8`) |
| **Status** | Ported and verified in the dashboard |
| **Vendure compatibility** | `^3.0.0` |
| **External npm dependencies** | None — `@vendure/core` only |

## Summary

Prices shipping from a tiered weight table rather than a flat rate, and gates
shipping methods on a minimum/maximum order weight. Both are exposed as
**configurable operations**, so the actual tiers and limits are set per Shipping
Method in the dashboard, not in code.

Billable weight is `max(actualWeight, volumetricWeight)` per line, multiplied by
quantity, summed across the order — the standard courier convention where a large
light parcel is charged on the space it occupies.

## Files

| File | Purpose |
| --- | --- |
| `shipping-by-weight.plugin.ts` | `@VendurePlugin` class. Its `configuration()` appends both operations onto `config.shippingOptions`. |
| `weight-based-shipping-eligibility-checker.ts` | `ShippingEligibilityChecker` + the shared `calculateTotalBillableWeightG()` helper. |
| `weight-based-shipping-calculator.ts` | `ShippingCalculator` implementing the tier lookup. |
| `constants.ts` | Options injection token and `loggerCtx`. |
| `types.ts` | `PluginInitOptions`. Currently vestigial — see [Known issues](#known-issues). |

Note that `calculateTotalBillableWeightG()` lives in the eligibility checker file
and is imported by the calculator. Both operations must agree on the weight
calculation or a method could be judged eligible and then priced from a different
number, so the shared helper is deliberate.

## Integration points

Registered in `src/vendure-config.ts`:

```ts
import { ShippingByWeightPlugin } from './plugins/shipping-by-weight/shipping-by-weight.plugin';
// ...
plugins: [
    // ...
    ShippingByWeightPlugin.init({}),
],
```

The plugin's `configuration()` appends to two arrays rather than replacing them,
so Vendure's built-in `defaultShippingCalculator` and `defaultShippingEligibilityChecker`
remain available alongside these:

```ts
config.shippingOptions.shippingEligibilityCheckers = [
    ...config.shippingOptions.shippingEligibilityCheckers,
    weightBasedShippingEligibilityChecker,
];
config.shippingOptions.shippingCalculators = [
    ...config.shippingOptions.shippingCalculators,
    weightBasedShippingCalculator,
];
```

It exposes no GraphQL API, owns no entities, and registers no jobs.

## Dependencies

### Custom fields — required, and the reason this port was non-trivial

The plugin reads two `ProductVariant` custom fields:

| Field | Type | Read by |
| --- | --- | --- |
| `dimensionWeightG` | `int` | `calculateTotalBillableWeightG()` |
| `dimensionVolumetricWeightG` | `int` | `calculateTotalBillableWeightG()` |

**These are not declared by the plugin.** They live in
[`src/custom-fields/logistics.ts`](../../src/custom-fields/logistics.ts) because
four different plugins share them (`shipping-by-weight` reads, `pim-sync` writes,
`product-info` reads in raw SQL, and the DSV courier plugins read the L/W/H set).
The rule established here: **a field owned by one plugin is declared inside that
plugin; a field shared across plugins is declared centrally.**

The consequence is that copying the plugin folder alone produces a build that
compiles, a plugin that registers, dropdowns that appear in the dashboard — and
shipping prices that are silently wrong. See
[Failure modes](#failure-modes-worth-knowing).

### Migration

`src/migrations/1788340148959-add-logistics-dimensions.ts` adds all five
Logistics columns:

```sql
ALTER TABLE "product_variant" ADD "customFieldsDimensionweightg" integer;
ALTER TABLE "product_variant" ADD "customFieldsDimensionlengthmm" integer;
ALTER TABLE "product_variant" ADD "customFieldsDimensionwidthmm" integer;
ALTER TABLE "product_variant" ADD "customFieldsDimensionheightmm" integer;
ALTER TABLE "product_variant" ADD "customFieldsDimensionvolumetricweightg" integer;
```

This migration is attributed to the shared custom fields rather than to this
plugin specifically, but it is this plugin's hard prerequisite. It matches
agx-stores' `1772026522507-add-logistics-dimensions.ts` statement for statement;
only the timestamp differs.

Column names are lowercased by Vendure's custom-field naming: `dimensionWeightG`
becomes `customFieldsDimensionweightg`. That matters when writing raw SQL against
these columns.

## Configuration

Set up under **Settings → Shipping methods** in the dashboard.

### Weight-based Eligibility Checker

`weight-based-shipping-eligibility-checker`

| Arg | Type | Default | Meaning |
| --- | --- | --- | --- |
| `minOrderWeightG` | `int` | `0` | Order must weigh at least this. `0` = no minimum. |
| `maxOrderWeightG` | `int` | `0` | Order must not exceed this. **`0` = no maximum**, not "reject everything". |

### Weight-based Shipping Calculator

`weight-based-shipping-calculator`

| Arg | Type | Default | Meaning |
| --- | --- | --- | --- |
| `weightTiersJson` | `string` (textarea) | four tiers, below | JSON array of `{ maxWeightG, price }`. |
| `taxRate` | `float` | `0` | Tax rate as a percentage. |
| `includesTax` | `select` | `auto` | `auto` follows `channel.pricesIncludeTax`; `true`/`false` override it. |

Default tiers:

```json
[
  { "maxWeightG": 500,   "price": 5000  },
  { "maxWeightG": 2000,  "price": 8000  },
  { "maxWeightG": 5000,  "price": 15000 },
  { "maxWeightG": 10000, "price": 25000 }
]
```

**Prices are in the smallest currency unit** — `5000` is R50.00, not R5 000.00.

### Typical multi-tier setup

Because each Shipping Method has exactly one calculator, banded couriers are
modelled as several Shipping Methods, each with a non-overlapping
`minOrderWeightG`/`maxOrderWeightG` window on the eligibility checker. The
checker decides which methods a customer is offered; the calculator prices the
one they pick.

## Behaviour and edge cases

- **Tiers are re-sorted at calculate time.** `[...tiers].sort((a, b) => a.maxWeightG - b.maxWeightG)`
  runs on every calculation, so the order you type them in doesn't matter, despite
  the arg description asking for ascending order.
- **The heaviest tier is the catch-all.** `sorted.find(t => totalWeightG <= t.maxWeightG) ?? sorted[sorted.length - 1]`
  — an order above the highest `maxWeightG` is charged the highest tier rather
  than being rejected. If you want heavy orders refused, that is the eligibility
  checker's job, not the calculator's.
- **Weight is per line, then multiplied by quantity.** Ten 300 g items = 3 000 g.
  There is no packaging allowance and no attempt at box-packing.
- **Volumetric weight is stored, not derived.** `dimensionVolumetricWeightG` is a
  plain nullable column that something else must populate (`(L × W × H) / 5 000 000 × 1 000`).
  Filling in L/W/H alone does **not** produce a volumetric weight.

### Failure modes worth knowing

| Condition | Behaviour | Visibility |
| --- | --- | --- |
| Custom fields missing from schema | Every order weighs 0 g → always the cheapest tier | **Silent** |
| Variants exist but weights are `null` | Same as above — `?? 0` per line | **Silent** |
| `weightTiersJson` is invalid JSON | Returns `price: 0` — free shipping | **Silent** — caught and swallowed, nothing logged |
| `weightTiersJson` is `[]` or not an array | Returns `price: 0` | **Silent** |

All four fail toward *undercharging*, and none of them log. `constants.ts` exports
a `loggerCtx` that nothing currently uses — wiring it into the two `catch`/guard
paths in the calculator would be a cheap, worthwhile improvement.

## Verification

The database half:

```sql
\d product_variant
```

Expect five nullable `integer` columns named `customFieldsDimension*`, and a
`migrations` table containing `AddLogisticsDimensions1788340148959`.

The dashboard half — **this is the check that actually proves the plugin loaded.**
Open any Shipping Method and check both dropdowns:

- Eligibility checker list contains **Weight-based Eligibility Checker**
- Calculator list contains **Weight-based Shipping Calculator**, with the tiers
  textarea pre-filled with the four defaults

Custom fields rendering on the variant page is *not* sufficient evidence — those
would appear even if `ShippingByWeightPlugin` were absent from the plugins array
entirely. Only the dropdowns prove `configuration()` ran.

The end-to-end half (not yet performed): set `dimensionWeightG` to `3000` on a
variant, add one to an order, and confirm the quote comes back as the 5 000 g
tier price (`15000`) rather than the 500 g tier (`5000`). This is the only check
that would have caught the missing-custom-fields trap.

## Port notes

Integration in `agx-stores` was identical — plain source folder, registered as
`ShippingByWeightPlugin.init({})` (line 1005 of its `vendure-config.ts`). The five
plugin files were copied verbatim.

The one deliberate difference: agx-stores declares the Logistics custom fields
inline in a single large `customFields` block inside `vendure-config.ts`. Here
they are split into `src/custom-fields/`, one module per domain, composed in
`src/custom-fields/index.ts`. This is purely organisational — the generated
migration is byte-identical to agx-stores' apart from its timestamp.

## Known issues

1. **`PluginInitOptions` is vestigial.** `types.ts` declares `{ exampleOption?: string }`,
   left over from `npx vendure add` scaffolding. It is never read. The plugin
   could drop the options plumbing and the `SHIPPING_BY_WEIGHT_PLUGIN_OPTIONS`
   provider entirely and be registered as a bare `ShippingByWeightPlugin`.
   Deferred so the port wasn't mixed with a refactor.
2. **No logging on the silent-failure paths.** See the table above.
3. **`ui: { tab: 'Logistics' }` renders as a card, not a tab** in the React
   dashboard. Cosmetic, but worth confirming before porting `pim-sync` and
   `quote-plugin`, which lean on tabs heavily.
4. **`calculateTotalBillableWeightG(order: { lines: Array<any> })`** is typed with
   `any`, so a rename of the custom fields would not be caught at compile time —
   exactly the class of error that made this port's trap silent.
