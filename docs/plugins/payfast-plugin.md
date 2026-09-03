# payfast-plugin

| | |
| --- | --- |
| **Source** | `src/plugins/payfast-plugin/` |
| **Integration type** | Plain source folder |
| **Ported from** | `agx-stores` — `src/plugins/payfast-plugin/` |
| **Ported on** | 2026-09-03 (stage 3) |
| **Status** | Ported and structurally verified |
| **Vendure compatibility** | `^3.0.0` |
| **External npm dependencies** | None to install |

## Summary

PayFast payment integration — **the South African payment path**. Redirects the
customer to PayFast, then reconciles the result through PayFast's ITN
(Instant Transaction Notification) webhook.

Credentials are **per PaymentMethod**, not global: `merchantId`, `merchantKey`,
`passphrase` and `sandbox` are handler args configured in the dashboard. That is
deliberate — "PayFast Live" and "PayFast Test" can coexist as separate,
independently channel-assignable PaymentMethods.

## Files

12 files, copied verbatim (verified identical to source with `diff -r`).

| File | Purpose |
| --- | --- |
| `payfast.plugin.ts` | Plugin class; registers handler + eligibility checker. |
| `payfast.handler.ts` | `PaymentMethodHandler`, code `payfast`. |
| `payfast.controller.ts` | `@Controller('payments/payfast')` — redirect, return, ITN. |
| `payfast.service.ts` | Signature generation, ITN validation, order settlement. |
| `payfast.helpers.ts` | Signature and payload helpers. |
| `payfast-minimum-payment.checker.ts` | `PaymentMethodEligibilityChecker`. |
| `api/api-extensions.ts`, `api/payfast.resolver.ts` | Shop API surface. |
| `constants.ts`, `types.ts`, `index.ts` | Options token, `loggerCtx`, types, barrel. |
| `FIGMA_MAKE_PAYFAST.md` | Design notes — kept. |

## Integration points

```ts
import { PayFastPlugin } from './plugins/payfast-plugin';
// ...
PayFastPlugin.init({ vendureHost: process.env.API_HOST! }),
```

`vendureHost` is the **only** option. It builds the ITN notify URL that PayFast
calls back on, so in production it must be the real public hostname — PayFast has
to reach it from the internet.

`configuration()` does two things:

```ts
config.paymentOptions.paymentMethodHandlers.push(payFastPaymentHandler);
config.paymentOptions.paymentMethodEligibilityCheckers = [
    ...(config.paymentOptions.paymentMethodEligibilityCheckers ?? []),
    payFastMinimumPaymentEligibilityChecker,
];
```

The first is a **mutating `.push()`**. The root config declares
`paymentMethodHandlers: [dummyPaymentHandler]`, so the array exists and this is
safe — but see [Known issues](#known-issues).

### HTTP routes

`PayFastController` mounts at `/payments/payfast`:

| Route | Purpose |
| --- | --- |
| `GET /payments/payfast/redirect` | Sends the customer to PayFast. |
| `GET /payments/payfast/return` | Customer returns after paying. |
| `GET /payments/payfast/notify` | ITN — GET variant. |
| `POST /payments/payfast/notify` | ITN — the real server-to-server callback. |

### Shop API

| Operation | Type |
| --- | --- |
| `payfastAvailablePaymentMethods` | Query |
| `createPayfastPaymentIntent` | Mutation |

Both confirmed present in the running schema.

### Handler args (configured per PaymentMethod in the dashboard)

**Credentials:** `merchantId` (required), `merchantKey` (required), `passphrase`,
`sandbox` (default `false`).

**Payment method toggles** — 16 booleans mapping to PayFast's `payment_method`
codes, letting each PaymentMethod expose a different subset: `ef` (EFT), `cc`
(Credit Card), `dc` (Debit Card), `mp` (Masterpass), `mc` (Mobicred), `sc`
(SCode), `ss` (SnapScan), and the rest. Defaults enable EFT, credit card, debit
card, Mobicred and SnapScan.

### Eligibility checker

`payfast-minimum-payment-eligibility-checker`, with a single `minimumAmount` arg
using the `currency-form-input` component. PayFast rejects very small payments;
this keeps the method hidden below the threshold rather than failing at checkout.

## Dependencies

| Dependency | Status |
| --- | --- |
| `@vendure/core` | Yes |
| `@nestjs/common` | Hoisted from `@vendure/core`, same as the other plugins |
| Custom fields | **None** |
| Entities | **None** |
| Env vars | `API_HOST` only |

## Migration

**None required.** No custom fields, no entities, and `configuration()` only
touches `paymentOptions`. Nothing reaches the schema.

## Verification

**Proven:**

- Source byte-identical to agx-stores (`diff -r`, no differences)
- `npx tsc --noEmit` — exit 0
- Server boots clean, logging
  `[PayFastPlugin] PayFast payment handler initialised (code: "payfast")`
- `PayFastController {/payments/payfast}` mapped with all four routes
- **Handler registered exactly once** — the Admin API `paymentMethodHandlers`
  query returns `dummy-payment-handler, mv-internal-settlement, payfast` with no
  duplicates
- Eligibility checker registered — `paymentMethodEligibilityCheckers` returns
  `mv-internal-settlement-eligibility-checker,
  payfast-minimum-payment-eligibility-checker`
- Shop API exposes `payfastAvailablePaymentMethods` and
  `createPayfastPaymentIntent`

**Not proven — needs real PayFast credentials and a public hostname:**

- Signature generation matching what PayFast expects
- The redirect handoff
- ITN callback validation and signature verification
- Order settlement on a successful payment
- Sandbox mode against `sandbox.payfast.co.za`

PayFast publishes sandbox credentials (merchant ID `10000100`, merchant key
`46f0cd694581a`) in the plugin's own header comment, so a sandbox run is possible
once the server is reachable from the internet — ITN is server-to-server, so
`localhost` will not receive callbacks.

## Port notes

Registered identically to agx-stores (line 1018 of its `vendure-config.ts`) with
the same single option. All 12 files copied verbatim; nothing edited.

The only difference is `API_HOST`, which is `http://localhost:3000` locally and
must be the real public hostname in production.

## Known issues

1. **`configuration()` is evaluated twice at startup.** The log line "Registering
   PayFast payment method handler" appears twice on every boot. Since the handler
   registration is a mutating `.push()`, this looked like it would produce a
   duplicate — it does not; the Admin API confirms exactly one `payfast` handler.
   Worth knowing the double log is expected and not a symptom.
2. **`vendureHost` is not validated.** Unlike `dsv-shipping-plugin` and
   `dpo-plugin`, nothing checks it at startup, so an unset `API_HOST` yields
   `undefined` inside the ITN notify URL and fails silently at payment time
   rather than at boot.
3. **ITN requires a publicly reachable host**, so this integration cannot be
   exercised end to end from local dev.
