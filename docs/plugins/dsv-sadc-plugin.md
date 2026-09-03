# dsv-sadc-plugin

| | |
| --- | --- |
| **Source** | `src/plugins/dsv-sadc-plugin/` |
| **Integration type** | Plain source folder — **flattened from an npm package** |
| **Ported from** | `agx-stores` — `src/plugins/dsv-sadc-plugin/src/` |
| **Ported on** | 2026-09-03 (stage 4) |
| **Status** | Ported, structurally verified. No SOAP call exercised |
| **Vendure compatibility** | `^3.0.0` |
| **External npm dependencies** | None beyond what the root already has |

## Summary

DSV ClientZone SADC integration — **SOAP/XML**, covering South Africa, Botswana,
Lesotho, Namibia and Eswatini. Rate calculation, shipment submission, label
retrieval, cancellation, and a webhook that writes tracking events into order history.

Its dashboard half is [dsv-sadc-ui](./dsv-sadc-ui.md), which renders those history
entries. The two are useless apart.

## Flattened from a package

In agx-stores this is `@agxchange/vendure-plugin-dsv-sadc`, a `file:` npm dependency.
Here it is an ordinary source folder: the contents of the package's `src/` were
copied, and `package.json`, `tsconfig.json` and `pnpm-lock.yaml` dropped.

Worth noting: **the package had no `dist/` on disk**, so in agx-stores it was in a
state where a fresh clone could not have built without first running its own
`compile` script. That fragility is exactly what flattening removes.

Despite being written with `"strict": false`, this plugin produced **zero**
strict-mode errors under the root's `"strict": true`. All 9 errors in stage 4 came
from `dsv-shipping-plugin`.

## Files

20 files. Notable:

| Area | Files |
| --- | --- |
| Plugin | `dsv-sadc.plugin.ts`, `constants.ts`, `index.ts` |
| SOAP | `services/dsv-soap.service.ts`, `utils/soap-builder.ts`, `utils/soap-parser.ts` |
| Services | `dsv-shipment.service.ts`, `dsv-label.service.ts`, `dsv-cancel.service.ts`, `dsv-address.service.ts` |
| Shipping ops | `calculators/dsv-sadc-rate.calculator.ts`, `dsv-sadc-eligibility.checker.ts`, `dsv-sadc-poa-eligibility.checker.ts` |
| Fulfillment | `handlers/dsv-sadc-fulfillment.handler.ts` |
| Webhook | `controllers/dsv-sadc-webhook.controller.ts` |
| History | `api/history-api-extensions.ts`, `types/history.types.ts` |
| Address | `utils/address-converter.ts` |

## Integration points

```ts
DsvSadcPlugin.init({ apiUrl, username, password, ediCustomerNumber,
                     ediCustomerDepartment, shipperPrefix, relationNumber,
                     warehouseSearchName, loadingAddress, defaults, features,
                     webhook, debugMode }),
```

**`init()` throws on missing config** (`dsv-sadc.plugin.ts:69,72`) — the required
values plus `defaults.serviceLevel`. The server will not start without them.

Registers a rate calculator (`dsv-sadc-rate`), two eligibility checkers
(`dsv-sadc-eligibility`, `dsv-sadc-poa-eligibility`), a fulfillment handler
(`dsv-sadc-fulfillment`), and a webhook controller at `/shipping/dsv-sadc`:

| Route | Purpose |
| --- | --- |
| `GET /shipping/dsv-sadc/label/:shipmentId` | Retrieve a shipping label |
| `POST /shipping/dsv-sadc/webhook` | DSV tracking callback |

### DSV_SADC_TRACKING — no migration needed

`api/history-api-extensions.ts` extends the `HistoryEntryType` GraphQL enum with a
`DSV_SADC_TRACKING` member, and `types/history.types.ts` exports it as a string
constant. Vendure stores `history_entry.type` as a string, so this is schema-level
only — **no database change**.

## Dependencies

### Custom fields — Address latitude / longitude

Declared centrally in [`src/custom-fields/geo.ts`](../../src/custom-fields/geo.ts),
not by this plugin. `utils/address-converter.ts` reads them off
`order.shippingAddress.customFields` and puts them in the coordinates block of DSV's
SubmitShipment call.

Storage is required rather than derivable: the storefront is the only party that can
capture precise device GPS. When the coordinates are absent the plugin falls back to
a live DSV ValidateAddress lookup, which is only suburb-accurate.

### Migration

`src/migrations/1788425213633-stage-4-dsv-geo.ts`:

```sql
ALTER TABLE "address" ADD "customFieldsLatitude" double precision;
ALTER TABLE "address" ADD "customFieldsLongitude" double precision;
```

**No `order_address` columns.** Vendure stores the order's address snapshot as an
embedded structure rather than a separate table, so Address custom fields do not
produce a second set of columns — contrary to what agx-stores' comment implies.

The generator also emitted a spurious `DROP INDEX "IDX_product_customFieldsMpn"`,
which was **deleted by hand** — the known drift documented in
[pim-sync](./pim-sync.md). Verified afterwards that the index survived.

## Verification

**Proven:**

- `npx tsc --noEmit` — exit 0, zero strict-mode errors from this plugin
- Server boots clean, logging
  `[DsvSadcPlugin] [fulfillment] handler init — configured=true`
- `DsvSadcWebhookController {/shipping/dsv-sadc}` mapped with both routes
- `dsv-sadc-rate` in `shippingCalculators`; `dsv-sadc-eligibility` and
  `dsv-sadc-poa-eligibility` in `shippingEligibilityCheckers`;
  `dsv-sadc-fulfillment` in `fulfillmentHandlers`
- Both `address` columns confirmed in Postgres

**Not proven — needs real DSV SADC credentials:**

Any SOAP call, envelope acceptance, SubmitShipment, label retrieval, cancellation,
webhook handling, and the address-coordinate path.

## Known issues

1. **The loading address is hardcoded business data in `vendure-config.ts`** —
   Landboupart, 12 Wrench Road, Kempton Park, including contact phone, email and GPS
   coordinates. Carried over verbatim from agx-stores for equivalence, but it is
   business configuration sitting in source control and should move to env before the
   VM deploy.
2. **`features: { labels: true, cancel: true, webhooks: true }` is hardcoded**, as in
   agx-stores, so those paths are always active regardless of environment.
3. **The webhook route's authentication is not obvious from the route declaration** —
   worth confirming the controller validates the DSV payload before trusting it.
4. **No test coverage.**
