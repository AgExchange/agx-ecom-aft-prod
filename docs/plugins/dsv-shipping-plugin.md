# dsv-shipping-plugin

| | |
| --- | --- |
| **Source** | `src/plugins/dsv-shipping-plugin/` |
| **Integration type** | Plain source folder — **flattened from an npm package** |
| **Ported from** | `agx-stores` — `src/plugins/dsv-shipping-plugin/src/` |
| **Ported on** | 2026-09-03 (stage 4) |
| **Status** | Ported, structurally verified. **Contains a known production bug — see below** |
| **Vendure compatibility** | Not declared (see [Known issues](#known-issues)) |
| **External npm dependencies** | `axios`, `node-cache` — added to the root `package.json` |

## Summary

DSV shipping integration over OAuth: real-time rate quotes, shipment booking, and a
fulfillment handler. Registers a rate calculator, an eligibility checker and a
fulfillment handler onto `config.shippingOptions`.

## Flattened from a package

In agx-stores this is `@agxchange/vendure-plugin-dsv-shipping`, a `file:` npm
dependency symlinked into `node_modules`. Here it is an ordinary source folder.

What changed in the port:

- Copied the **contents of the package's `src/`**; dropped `package.json`,
  `tsconfig.json`, `dist/` and `CHANGELOG.md`.
- **Deleted `types/globals.d.ts`.** It declared `console` and `URLSearchParams` as
  globals — a workaround for compiling in isolation without `@types/node`. Inside
  this project `@types/node` is present, so those declarations conflict with the
  real ones.
- **Excluded `calculators/dsv-rate.calculator.FIXED.ts`.** Verified dead: nothing
  imports it. It appears to be an abandoned alternate version of the rate calculator.
- `axios` and `node-cache` moved into the root `package.json`; they previously
  arrived through the `file:` mechanism.
- Import changed from `@agxchange/vendure-plugin-dsv-shipping` to
  `./plugins/dsv-shipping-plugin`.

The package set `"strict": false` in its own tsconfig. Under this project's
`"strict": true` it produced **9 errors** — every strict-mode error in stage 4 came
from this plugin; `dsv-sadc-plugin` produced none.

## The dimensions bug

**Variant weight and dimensions are never read.** Three sites in this plugin read
`customFields.weight` / `.length` / `.width` / `.height`; the fields that exist are
`dimensionWeightG`, `dimensionLengthMm`, `dimensionWidthMm`, `dimensionHeightMm` —
and they are in **grams and millimetres**, not kilograms and centimetres.

Two of those sites are live:

- **`calculators/dsv-rate.calculator.ts:149`** — every quote. `variantWeight` is
  always `1`, so `totalWeight` is really the item count.
- **`utils/booking-converter.ts:260-263`** — every booking. Every package is 1 kg and
  30 x 20 x 20 cm.

The third, `utils/package-calculator.ts`, is **dead code** — none of its five exports
is referenced anywhere.

**The type system caught only the dead one.** The two live sites cast with `as any`
before reading; the dead file does not. So flattening this plugin under
`strict: true` produced errors in the harmless copy and stayed silent on the two that
matter.

Behaviour was preserved verbatim rather than fixed, because correcting it moves live
shipping quotes — a commercial decision.

**Full analysis and fix plan:**
[dsv-shipping-plugin-dimensions-bug.md](./dsv-shipping-plugin-dimensions-bug.md).

## Fixes applied during the port

Five type errors were genuine defects, fixed without changing behaviour:

| File | Was | Now |
| --- | --- | --- |
| `handlers/dsv-fulfillment.handler.ts` (x2) | `args.autoBook === 'true' \|\| args.autoBook === true` | `args.autoBook === 'true'` — the arg is declared `type: 'string'`, so the second comparison could never match |
| `utils/booking-converter.ts` | `convertVendureAddress(address: Address)` | `address: OrderAddress` — its only caller passes `order.shippingAddress`, and the body reads `countryCode`, which exists only on `OrderAddress`. Imported from `@vendure/common/lib/generated-types` |
| `utils/booking-converter.ts` (x2) | `address.streetLine1`, `address.countryCode` | `\|\| ''` fallbacks — `OrderAddress` types these optional where `Address` did not; matches the file's existing `\|\| 'Unknown'` style for city |
| `services/dsv-quote.service.ts` | `post(this.options.apiEndpoints.quote, ...)` | Guarded — `apiEndpoints.quote` is optional (Quote API is "Phase 5"), so a missing value now throws a clear error instead of POSTing to `undefined` |

## Integration points

```ts
DsvShippingPlugin.init({ auth, subscriptionKeys, apiEndpoints, testMdmAccount,
                         bookingDefaults, features, quoteCacheTTL, debugMode }),
```

`configuration()` pushes `dsvShippingEligibilityChecker` and `dsvRateCalculator`, and
appends `dsvFulfillmentHandler` — the first plugin here to touch
`config.shippingOptions.fulfillmentHandlers`. All coexist with the weight-based ops.

**`init()` calls `validateOptions()`, which throws.** ~20 options are required across
six groups. A missing value stops the server starting — this is not a warning.

`features` and `units` are **hardcoded** in `vendure-config.ts` rather than read from
env, matching agx-stores exactly: `quote: true, booking: true, tracking: false,
webhooks: false, labels: false`.

## Migration

**None from this plugin.** No custom fields, no entities.

## Verification

**Proven:**

- `npx tsc --noEmit` — exit 0 after the five fixes
- Server boots clean, zero errors in the log
- `dsv-rate-calculator` present in the Admin API `shippingCalculators`
- `dsv-shipping-eligibility` present in `shippingEligibilityCheckers`
- `dsv-fulfillment` present in `fulfillmentHandlers`
- **`validateOptions()` demonstrably runs**: blanking `DSV_CLIENT_EMAIL` and booting
  exits with code 1 and
  `Error: DSV Shipping Plugin configuration errors: - auth.clientEmail is required`

**Not proven — needs real DSV credentials:**

OAuth token exchange, quote requests, booking submission, fulfillment, and the
`node-cache` quote cache. Env values are obvious placeholders
(`unset@invalid.local`, `https://unset.invalid`).

## Known issues

1. **The dimensions bug** — see above, and the linked analysis. The most
   important item here.
2. **No `compatibility` field.** The plugin decorator omits it, so Vendure logs
   *"does not specify a compatibility range, so it is not guaranteed to be
   compatible"* on every boot. Every other ported plugin declares `^3.0.0`.
3. **`init()`'s success log never appears.** `Logger.info('DSV Shipping Plugin v3.0.3
   initialized...')` runs while the config object is being constructed, before
   Vendure's logger is configured, so it is silently dropped. Not a fault — but it
   means a successful init leaves no trace, which is why the blank-env test above was
   worth running.
4. **Extensive commented-out `console.info` calls** throughout `index.ts` and the
   services — debugging scaffolding left in place.
5. **`quote: true` and `booking: true` are hardcoded**, so the plugin will attempt
   real calls the moment a shipping method uses its calculator, regardless of env.
