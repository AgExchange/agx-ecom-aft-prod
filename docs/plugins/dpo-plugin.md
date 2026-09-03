# dpo-plugin

| | |
| --- | --- |
| **Source** | `src/plugins/dpo-plugin/` |
| **Integration type** | Plain source folder |
| **Ported from** | `agx-stores`, branch **`feat/dpo_pay_plugin`**, commit `810ac4f` |
| **Ported on** | 2026-09-03 (stage 5) |
| **Status** | Ported, structurally verified. No payment exercised |
| **Vendure compatibility** | `^3.0.0` |
| **External npm dependencies** | `fast-xml-parser` — added to the root `package.json` |

## Summary

DPO Pay integration — **payments outside South Africa, and RSA as a fallback**
(PayFast is the primary RSA path). Redirects the customer to DPO, then verifies and
settles via a webhook plus a token-verification call.

Communicates in **XML over DPO's v6/v7 APIs**, and keeps its own audit trail: every
transaction, every API exchange (request and response XML retained), and every
refund.

## Ported from a feature branch

Unlike the other twelve, this came from `feat/dpo_pay_plugin` rather than a merged
branch. Its two most recent commits are `30ee2bd dpo_plugin initial (un-tested) plain
source file integration` and `810ac4f dpo-plugin: fix enum column types, enable
unit-spec glob, add test suite`.

So this is **newer and less production-proven than everything else in this repo**.
Worth knowing when triaging.

## Files

24 files copied; the `__tests__/` directory was excluded — see
[Known issues](#known-issues).

| Area | Files |
| --- | --- |
| Plugin | `dpo-pay.plugin.ts`, `index.ts` |
| Options | `config/dpo-plugin-options.ts`, `config/constants.ts` |
| Payment | `dpo-payment-handler.ts`, `config/dpo-payment-process.ts` |
| API client | `api/dpo-client.ts`, `dpo-envelope.ts`, `dpo-date.ts`, `dpo-xml-types.ts` |
| HTTP | `api/dpo-webhook.controller.ts`, `api/dpo-redirect.controller.ts`, `api/dpo-pay.resolver.ts` |
| Services | `service/dpo-transaction.service.ts`, `dpo-verify-and-settle.service.ts`, `dpo-refund.service.ts`, `dpo-result-code.ts`, `dpo-request-context.helper.ts`, `redact.ts` |
| Entities | `entities/dpo-transaction.entity.ts`, `dpo-transaction-event.entity.ts`, `dpo-refund.entity.ts`, `decimal-transformer.ts`, `index.ts` |
| Docs | `DPO_README.md` — kept |

## Integration points

```ts
DpoPayPlugin.init({
    companyToken, serviceType, redirectUrl, backUrl,
    apiUrlV6, apiUrlV7, storefrontConfirmationUrlTemplate, useSandbox,
}),
```

**`validateDpoPluginOptions()` runs inside `configuration()` and throws** on a
missing `companyToken`, `serviceType`, `redirectUrl` or `backUrl`, or if `useSandbox`
is not a real boolean. The server will not start without them.

### The payment-process append is load-bearing

```ts
config.paymentOptions.process = [...(config.paymentOptions.process ?? []), dpoPaymentProcessExtension];
```

The source carries an explicit warning worth preserving here: Vendure's `mergeConfig`
treats arrays as a single value to be **replaced wholesale**, not merged. Overwriting
this array would silently drop `defaultPaymentProcess` — which drives order-level
`PaymentSettled` / `PaymentAuthorized` transitions **for every payment method in the
store**, not just this one. Always append.

### HTTP routes

| Route | Purpose |
| --- | --- |
| `POST /payments/dpo/callback` | DPO webhook |
| `GET /payments/dpo/return` | Customer returns after paying; redirects to the storefront |

`storefrontConfirmationUrlTemplate` substitutes `{orderCode}` and `{status}`.

### Shop API

`initiateDpoPayment` — confirmed present in the running schema.

Payment handler code: **`dpo-pay`**.

## Migration

`src/migrations/1788425684600-stage-5-dpo.ts` — three tables, 11 indexes, 5 foreign
keys.

| Table | Purpose |
| --- | --- |
| `dpo_transaction` | 35 columns: tokens, amounts, card details, fraud flags, PTL expiry, settlement dates |
| `dpo_transaction_event` | Per-API-exchange audit, retaining `rawRequestXml` and `rawResponseXml` |
| `dpo_refund` | Refund requests and outcomes |

Two details checked rather than skimmed, per the plan:

- **Money.** `entities/decimal-transformer.ts` produces `numeric(14,2)` for
  `paymentAmount` and `refundAmount`, and `numeric(14,4)` for `transactionAmount` /
  `transactionFinalAmount` — four decimal places for FX-converted values.
- **Enums.** `status` on both `dpo_transaction` and `dpo_refund` is
  `character varying` with a string default (`'pending_redirect'`, `'requested'`),
  **not** a Postgres enum. That is the intended state after commit `810ac4f`
  "fix enum column types".

Foreign keys: `orderId` and `dpoTransactionId` cascade on delete; `paymentId` and
`vendureRefundId` are `SET NULL`, so removing a Vendure payment or refund leaves the
DPO audit row intact.

The generator also emitted the spurious `DROP INDEX "IDX_product_customFieldsMpn"`
again, which was **deleted by hand** — see [pim-sync](./pim-sync.md). Verified
afterwards that the index survived.

### agx-stores has no reference migration for these tables

Grepping its `src/migrations/` for `dpo_transaction` or `dpo_refund` returns nothing —
the same situation as multivendor's custom fields. **This repo's migration is more
complete than the reference.** Correct, but worth recording.

## Dependencies

| Dependency | Status |
| --- | --- |
| `@vendure/core`, `@nestjs/common`, `@nestjs/graphql` | Available |
| `fast-xml-parser` | **Added** — `^4.5.7`, matching agx-stores. Pinned to v4 deliberately; v5 has breaking changes |
| Custom fields | **None** |
| Entities | **Three** |

`DPO_README.md` notes that `fast-xml-parser` was once "declared in `package.json` but
never actually installed" in agx-stores — the same gap, hit again here and fixed.

## Verification

**Proven:**

- Source identical to agx-stores (`diff -r --exclude=__tests__`, no differences)
- `npx tsc --noEmit` — exit 0
- Server boots clean, zero errors
- All three tables created, confirmed in `pg_tables`
- Payment handler `dpo-pay` present in the Admin API, **exactly once**
- `DpoWebhookController` and `DpoRedirectController` mapped
- `initiateDpoPayment` present in the Shop API schema

**Not proven — needs a real DPO transaction:**

Token creation, the redirect handoff, webhook signature/payload handling,
verify-and-settle, refunds, XML envelope construction, and result-code mapping.
Sandbox test credentials are in `.env` (`useSandbox: true`), but no payment was
attempted — `redirectUrl` and `backUrl` point at `example.com` placeholders.

## Known issues

1. **The `__tests__/` directory was excluded**, and it is the most valuable test
   suite in the whole codebase: 8 unit specs covering XML envelope construction,
   date handling, result codes, refunds, verify-and-settle and redaction, plus an
   e2e spec. Commit `810ac4f` added them deliberately. They need `vitest`, which is
   not installed. **This is the first thing to restore when test setup becomes a
   task** — more so than for any other plugin, because this is payment code and the
   least production-proven of the thirteen.
2. **Ported from an unmerged feature branch.** If that branch changes before it
   lands, this port needs revisiting.
3. **Raw XML is persisted** in `dpo_transaction_event.rawRequestXml` /
   `rawResponseXml`. There is a `service/redact.ts`, so redaction is clearly
   intended — worth confirming it covers everything sensitive before this stores real
   card data.
