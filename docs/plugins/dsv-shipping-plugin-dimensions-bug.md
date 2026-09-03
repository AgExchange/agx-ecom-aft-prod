# DSV shipping: variant dimensions are never read

**Status:** open, unfixed. Present in `agx-stores` production today and carried into
this repo verbatim.

## What is wrong

Three places in `dsv-shipping-plugin` read per-variant weight and dimensions. All
three read **field names that do not exist**.

| Field read | Field that exists | Where |
| --- | --- | --- |
| `customFields.weight` | `dimensionWeightG` | rate calculator, booking converter, package calculator |
| `customFields.length` | `dimensionLengthMm` | booking converter, package calculator |
| `customFields.width` | `dimensionWidthMm` | booking converter, package calculator |
| `customFields.height` | `dimensionHeightMm` | booking converter, package calculator |

Also tried and equally non-existent: `shippingWeight`, `packageLength`,
`packageWidth`, `packageHeight`.

The names come from the plugin's own `README.old.md`, which instructs the integrator
to declare `weight` / `length` / `width` / `height` on `ProductVariant` in
kilograms and centimetres. **agx-stores never did.** It declared
`dimensionWeightG`, `dimensionLengthMm`, `dimensionWidthMm`, `dimensionHeightMm`
instead — in **grams and millimetres** — for `shipping-by-weight`. Nothing ever
bridged the two.

## Which sites actually run

This distinction matters and was initially got wrong.

| Site | Live? | Effect |
| --- | --- | --- |
| `calculators/dsv-rate.calculator.ts:149` | **YES — every quote** | `variantWeight` is always `1`, so `totalWeight` equals the **item count**, not a weight. A 10 kg item and a 10 g item both contribute 1. |
| `utils/booking-converter.ts:260-263` | **YES — every booking** | Every package is 1 kg and 30 x 20 x 20 cm, and `volumeM3` is derived from those fabricated dimensions. |
| `utils/package-calculator.ts:51-57` | **NO — dead code** | Zero callers. None of its five exports (`calculatePackages`, `convertAddress`, `convertContact`, `validateOrderForQuote`, `DEFAULT_UNITS`) is referenced anywhere. |

`utils/quote-request-builder.ts:106-108` separately hardcodes `length: 30, width: 20,
height: 20` with no custom-field read at all.

## Why the type system did not catch the live ones

The two live sites cast before reading:

```ts
(line as any).productVariant?.customFields?.weight      // rate calculator
const customFields = variant.customFields as any || {}; // booking converter
```

The dead file does not. So when this plugin was flattened out of its npm package and
compiled under the root's `strict: true`, **only the dead copy produced errors**. The
type checker found the harmless instance and stayed silent on the two that matter.

Worth remembering as a general lesson: `as any` on a custom-fields read disables
exactly the check that would catch a renamed or mistyped field.

## Before fixing: check whether it is reachable

`features.quote` and `features.booking` are hardcoded `true`, but the calculator only
runs if a **ShippingMethod is configured to use `dsv-rate-calculator`**. If no
shipping method references it, live impact today is zero and this is latent rather
than active. Check that first — it decides urgency.

```sql
SELECT id, code, "calculatorCode" FROM shipping_method WHERE "deletedAt" IS NULL;
```

## The fix

### 1. Delete the dead file

`utils/package-calculator.ts` — 230 lines, no callers. Removing it also removes the
misleading duplicate of the bug.

### 2. Add a shared conversion helper

Both live sites need the same mapping, so it belongs in one place — a new
`utils/variant-dimensions.ts`:

```ts
// Stored fields are GRAMS and MILLIMETRES. DSV is configured for KG / CM
// (bookingDefaults.units in vendure-config.ts).
grams      / 1000 -> kg
millimetres / 10  -> cm
```

Fallbacks should stay at the current values (1 kg, 30 x 20 x 20 cm) so a variant
with no dimensions behaves exactly as it does now, rather than becoming a new
failure mode.

### 3. Decide: actual weight, or billable weight?

`shipping-by-weight` bills on `max(dimensionWeightG, dimensionVolumetricWeightG)` —
the standard courier convention, where a large light parcel is charged on the space
it occupies. DSV likely applies the same rule its own side.

Using actual weight only would make DSV quotes disagree with the weight-based
calculator on the same order. **This is a commercial decision, not a technical one.**

### 4. Fix the three call sites

- `dsv-rate.calculator.ts` — use the helper; drop the `as any`.
- `booking-converter.ts` — use the helper; drop the `as any`.
- `quote-request-builder.ts` — take real dimensions rather than hardcoding
  30 x 20 x 20.

Removing the `as any` casts is part of the fix, not tidying: it is what stops this
recurring silently the next time a field is renamed.

### 5. Expect prices to change

Today every order quotes at (item count) kg. After the fix, real weights apply.
**Quotes will move, probably upward for heavy goods**, and that is the point — but it
should be a deliberate, announced change, verified against a few known orders before
it reaches customers.

## Suggested verification

1. Pick three variants with real `dimensionWeightG` values set.
2. Before the fix, record the DSV quote for an order of each.
3. After the fix, confirm `totalWeight` matches the sum of actual weights in kg, and
   that package dimensions in the booking payload match the stored mm values divided
   by 10.
4. Confirm a variant with **no** dimensions still yields 1 kg / 30 x 20 x 20 cm.
