# DPO Pay Plugin

> **Status: PORTED, NOT YET LIVE.** Wired into `vendure-config.ts` and fully covered by
> automated tests (see §8), but the **database migration for its 3 entities has not been
> generated/run yet** and no real DPO sandbox/production credentials have been supplied —
> both are required before this can actually process a live payment. Target: Vendure
> **3.7.0**, PostgreSQL in production / sql.js in tests.
>
> For the original design rationale (why each decision was made, the full "known gaps"
> list, and the migration walkthrough), see [`docs/dpo-plugin.md`](../../../docs/dpo-plugin.md).
> This file is the practical, at-a-glance reference for working in this folder day to day.

## 1. What this plugin does

A payment plugin for **DPO Pay by Network** (formerly DPO Group / 3G Direct Pay), a
hosted-checkout payment gateway used across Africa. No official Vendure plugin exists for
it, so this implements the integration from scratch against DPO's XML ("API3G") API.

- Customer pays on **DPO's own hosted page** — card details never touch this app.
- Talks to two DPO API versions: **v6** (createToken / refundToken / cancelToken /
  updateToken) and **v7** (verifyToken, always; verifyRefund) — v7 is the only version
  that returns a precise payment timestamp.
- Implements DPO's full result-code state machine (§7 below): paid, declined, expired,
  cancelled, several pending states, and a family of "integration error" codes that must
  never be mistaken for a customer-facing payment failure.
- **Never** trusts DPO's redirect or webhook on their own as proof of payment — both
  independently trigger a real server-side re-verification call to DPO before anything is
  marked as settled.
- Keeps a full audit trail of every request/response to and from DPO, with the
  shared-secret `CompanyToken` redacted before it's ever written to the database.

### The five-step payment flow

```
1. Shop API: initiateDpoPayment
      │  DpoPayResolver → DpoClient.createToken() → DPO issues a transToken
      │  orderService.addPaymentToOrder() → Payment created, state = Authorized (NOT Settled)
      ▼
2. Customer redirected to DPO's hosted page (getHostedPaymentUrl), pays or cancels
      ▼
3. DPO reports back TWO ways, both untrusted on their own:
      ├─ GET  /payments/dpo/return    (browser redirect — DpoRedirectController)
      └─ POST /payments/dpo/callback  (server-to-server webhook — DpoWebhookController)
      ▼
4. BOTH funnel into DpoVerifyAndSettleService.verifyAndSettle():
      │  calls DPO's verifyToken (v7) FOR REAL, server-side
      │  classifies the result code (service/dpo-result-code.ts)
      │  ONLY this response may change Payment state:
      │    paid              → orderService.settlePayment
      │    declined/expired  → orderService.transitionPaymentToState(..., 'Declined')
      │    cancelled         → orderService.cancelPayment
      │    anything else     → no transition, dpo_transaction row updated only
      ▼
5. Customer's browser lands on storefrontConfirmationUrlTemplate ({orderCode}/{status}) —
   storefront should re-query the order normally, not trust the URL as proof of anything.
```

Calling `verifyAndSettle` twice for the same transaction (webhook **and** redirect both
firing) is expected, not a bug: the persistence layer is first-write-wins
(`applyPaymentConfirmationGuard`) and Vendure's own state-machine calls return a typed
`ErrorResult` on a repeat transition, which is logged as a warning and swallowed.

## 2. File-by-file map

```
src/plugins/dpo-plugin/
├── index.ts                          Public entry point re-exported to vendure-config.ts
├── dpo-pay.plugin.ts                 @VendurePlugin — registration, config validation,
│                                       merges dpoPaymentHandler + the payment-process patch
├── dpo-payment-handler.ts            PaymentMethodHandler: createPayment (→Authorized),
│                                       settlePayment (re-checks status==='paid' itself),
│                                       cancelPayment, createRefund
│
├── api/                               DPO's wire protocol + this app's HTTP/GraphQL surface
│   ├── dpo-client.ts                  All outbound HTTP to DPO (bare `fetch`, XML in/out)
│   ├── dpo-xml-types.ts               TS interfaces for DPO's XML request/response shapes
│   ├── dpo-envelope.ts                Normalizes v6 vs v7 error/result envelope shapes
│   ├── dpo-date.ts                    DPO date parsing/formatting + PTL expiry calc
│   ├── dpo-pay.resolver.ts            Shop API mutation: initiateDpoPayment
│   ├── dpo-redirect.controller.ts     GET  /payments/dpo/return   (browser redirect)
│   └── dpo-webhook.controller.ts      POST /payments/dpo/callback (server-to-server)
│
├── service/                           Persistence, audit logging, orchestration
│   ├── dpo-transaction.service.ts     CRUD + applyVerifyTokenResult (the state-writer) +
│   │                                   applyPaymentConfirmationGuard (pure, first-write-wins)
│   ├── dpo-verify-and-settle.service.ts  The ONE function both controllers call
│   ├── dpo-refund.service.ts          requestAndVerifyRefund (refundToken + verifyRefund)
│   ├── dpo-result-code.ts             Full DPO result-code → status/class table (§7)
│   ├── dpo-request-context.helper.ts  Builds a superadmin RequestContext (no customer session
│   │                                   exists in a webhook/redirect request)
│   └── redact.ts                      Strips <CompanyToken> before anything is persisted
│
├── entities/                          TypeORM entities (§6)
│   ├── dpo-transaction.entity.ts      Main table — full transaction snapshot/state
│   ├── dpo-transaction-event.entity.ts Append-only audit log of every request/response
│   ├── dpo-refund.entity.ts           One row per refund attempt
│   └── decimal-transformer.ts         TypeORM column transformer for decimal money fields
│
├── config/
│   ├── constants.ts                   loggerCtx, DPO_PAY_METHOD_CODE = 'dpo-pay'
│   ├── dpo-plugin-options.ts          DpoPluginOptions type + validateDpoPluginOptions()
│   └── dpo-payment-process.ts         Adds the missing Authorized→Declined transition
│
└── __tests__/                         Everything test-related — see §8
```

| If you want to... | Look at |
|---|---|
| See exactly what gets sent to/parsed from DPO | `api/dpo-client.ts`, `api/dpo-xml-types.ts`, `api/dpo-envelope.ts` |
| Understand what happens for each DPO result code | `service/dpo-result-code.ts` |
| See the "always verify server-side" logic | `service/dpo-verify-and-settle.service.ts` |
| Change how the plugin is configured | `config/dpo-plugin-options.ts` |
| See how a payment starts | `api/dpo-pay.resolver.ts` |
| See how DPO's redirect/webhook are received | `api/dpo-redirect.controller.ts`, `api/dpo-webhook.controller.ts` |
| Change refund/cancel/settle behaviour | `dpo-payment-handler.ts` |
| Find or add a test | `__tests__/` (§8) |

Two extension points worth knowing about because they're easy to break by accident:

- **`config/dpo-payment-process.ts`** adds a missing `Authorized -> Declined` transition
  (stock Vendure only allows `Authorized` to move to `Settled`/`Error`/`Cancelled`).
  `dpo-pay.plugin.ts`'s `configuration` hook merges it into `config.paymentOptions.process`
  by **appending**, never replacing — replacing would silently delete
  `defaultPaymentProcess` and break `PaymentSettled`/`PaymentAuthorized` transitions for
  *every* payment method in the store, not just DPO's.
- **`DpoClient` is never dependency-injected.** `dpoPaymentHandler.init()`,
  `DpoVerifyAndSettleService`, `DpoRefundService`, and `DpoPayResolver` each construct
  their own `new DpoClient(options)`. This matters for testing (§8.3) — the only reliable
  interception point for every outbound DPO call is the global `fetch`, not constructor
  injection.

## 3. Configuration (`DpoPluginOptions`)

Set once, at boot, in `DpoPayPlugin.init({...})` in `vendure-config.ts` (right after
`PayFastPlugin.init(...)`). Changing any of these requires a server restart.

### Required — `validateDpoPluginOptions()` throws immediately at boot if any are missing

| Env var | Option | What it does |
|---|---|---|
| `DPO_COMPANY_TOKEN` | `companyToken` | DPO shared-secret GUID — authenticates every request |
| `DPO_SERVICE_TYPE` | `serviceType` | Paired with `companyToken`; DPO rejects the request if they don't match |
| `DPO_REDIRECT_URL` | `redirectUrl` | **This app's own** `/payments/dpo/return` URL — not the storefront's |
| `DPO_BACK_URL` | `backUrl` | **This app's own** `/payments/dpo/callback` URL |
| `DPO_USE_SANDBOX` | `useSandbox` | Must be explicitly `true`/`false`; logged prominently at boot as a tripwire against a sandbox token reaching production |

### Optional, with defaults

| Env var | Option | Default | What it does |
|---|---|---|---|
| — | `serviceDescription` | none | Free-text description sent to DPO on `createToken` |
| `DPO_API_URL` | `apiUrlV6` | `https://secure.3gdirectpay.com/API/v6/` | create/refund/cancel/update calls |
| `DPO_API_URL_V7` | `apiUrlV7` | `https://secure.3gdirectpay.com/API/v7/` | `verifyToken`/`verifyRefund` calls |
| — | `hostedPaymentBaseUrl` | `https://secure.3gdirectpay.com/payv3.php` | The hosted-checkout page URL |
| — | `ptl` | `5` | "Pay Time Limit" — how long the hosted page stays valid |
| — | `ptlType` | `'hours'` | Unit for `ptl` — `'minutes' \| 'hours' \| 'days'` |
| `DPO_STOREFRONT_CONFIRMATION_URL` | `storefrontConfirmationUrlTemplate` | assumes `localhost:8080` | Where the customer lands after verification; supports `{orderCode}`/`{status}` |

`secure.3gdirectpay.com` is used for **both** sandbox and production — there is no
separate sandbox hostname. Which environment a request hits is determined entirely by
`companyToken`, not the URL.

### Admin setup

Settings → Payment methods → Create new → select handler code **`dpo-pay`**. No handler
`args` to fill in — all configuration comes from `DpoPluginOptions` above, not
per-PaymentMethod fields.

## 4. The GraphQL/HTTP surface

| Endpoint | Type | Purpose |
|---|---|---|
| `initiateDpoPayment` | Shop API mutation | Starts a payment: creates the `dpo_transaction` row, calls `createToken`, adds an `Authorized` Payment, returns the hosted-page redirect URL. Idempotent — reuses an already-open, unexpired transaction rather than always calling `createToken` again (see `DpoTransactionService.findOpenTransactionForOrder`, tested in `__tests__/dpo-transaction.service.unit-spec.ts`). |
| `GET /payments/dpo/return` | REST | DPO's browser-facing RedirectURL target. Always verifies server-side, always 302-redirects to `storefrontConfirmationUrlTemplate`, even on internal error (`status=error`). |
| `POST /payments/dpo/callback` | REST | DPO's server-to-server BackURL notification. Reads both query string and body. Always responds `200` regardless of outcome (log-not-throw) — DPO would otherwise retry a callback whose real problem is on our side. |

## 5. Amounts, encoding, and other easy-to-miss details

- **Amounts**: Vendure stores money in minor units (cents); DPO expects decimal major
  units. `api/dpo-pay.resolver.ts` and `dpo-payment-handler.ts` divide by 100 at the
  boundary — don't do this conversion twice or skip it.
- **`User-Agent` header is mandatory.** DPO's endpoint sits behind CloudFront/WAF — a
  request with no/blank `User-Agent` gets a 403 (HTML, not XML) response, confirmed
  empirically against the live sandbox and not documented by DPO. `api/dpo-client.ts`
  always sets one (`agx-stores-dpo-plugin/1.0`).
- Never use `localhost` in `DPO_REDIRECT_URL`/`DPO_BACK_URL` against the real DPO sandbox
  — use a real (even if unreachable) hostname, or tunnel with `ngrok` if the callback
  needs to actually reach a local machine.
- `TransactionPaymentDate` (v7) carries **no timezone offset** and is currently parsed
  assuming UTC (`api/dpo-date.ts`'s `parseDpoDateTimeAssumeUtc`) — flagged as an
  unconfirmed assumption pending DPO confirmation. The raw string is always retained
  (`dpo_transaction.payment_date_raw`) so this is correctable later without re-querying
  DPO.

## 6. Data model

### `dpo_transaction` (main table — one row per payment attempt)

Key fields beyond the obvious (`id`, `order`, `payment`, timestamps): `companyRef` (the
Vendure order code, possibly retry-suffixed — `ORDER-1`, `ORDER-1-R1`, ...), `transToken`
/ `transRef` (DPO's own identifiers, `transToken` unique+nullable), `status`
(`DpoTransactionStatus` — see §7 for how each DPO result code maps here), `ptlExpiresAt`
(when the hosted page stops accepting payment), `lastResultCode`/`lastResultExplanation`
(populated **only** from `verifyToken`'s result — `createToken`'s own `000` means "token
created," not "payment confirmed," and is deliberately not written here),
`paymentDate`/`paymentDateRaw`/`verifyTokenConfirmedAt` (first-write-wins, only settable
when `lastResultCode === '000'` — enforced by `applyPaymentConfirmationGuard`), plus a
snapshot of DPO's own transaction metadata (card type/last-four/first-six-BIN-only,
approval number, fraud alert code/explanation, settlement amounts/currencies).

### `dpo_transaction_event` (append-only audit log)

One row per DPO API request or response, or inbound notification — logged
**unconditionally**, regardless of outcome (a callback for a declined transaction still
gets a row). `eventType` is one of: `create_token_request`/`_response`,
`redirect_return`, `push_callback`, `verify_token_request`/`_response`,
`refund_token_request`/`_response`, `cancel_token_request`/`_response`,
`update_token_request`/`_response`, `verify_refund_request`/`_response`. `rawRequestXml`
always has `<CompanyToken>` redacted before it's written (`service/redact.ts`).

### `dpo_refund` (one row per refund attempt)

`refundAmount`, `refundDetails`, `status` (`'requested' | 'succeeded' | 'failed'`),
`resultCode`/`resultExplanation` (from `verifyRefund`'s envelope). Does **not** track
cumulative refunds across multiple partial refunds against the same transaction — only
the latest refund's amount vs. the original payment amount (a known gap, not a bug).

## 7. DPO result-code reference (`service/dpo-result-code.ts`)

The single source of truth for what each DPO result code means and what it's allowed to
do. Exhaustively unit-tested in `__tests__/dpo-result-code.unit-spec.ts`.

| Code | Meaning | Class | `dpo_transaction.status` | Poll again? |
|---|---|---|---|---|
| `000` | Transaction paid | terminal-success | `paid` | no |
| `001` | Authorized | non-terminal | `authorized` | yes |
| `002` | Overpaid or underpaid | needs-review | `overpaid_underpaid` | no |
| `003` | Pending bank | non-terminal | `pending_bank` | yes |
| `005` | Queued authorization | non-terminal | `queued_authorization` | yes |
| `007` | Pending split payment (not fully paid) | non-terminal | `pending_split_payment` | yes |
| `900` | Transaction not paid yet | non-terminal | `awaiting_payment` | yes |
| `901` | Transaction declined | terminal-failure | `declined` | no |
| `903` | Payment time limit exceeded | terminal-failure | `expired` | no |
| `904` | Transaction cancelled | terminal-failure | `cancelled` | no |
| `801` | Request missing company token | **integration-error** | *(never written)* | no |
| `802` | Company token does not exist | **integration-error** | *(never written)* | no |
| `803` | No request or error in request type name | **integration-error** | *(never written)* | no |
| `804` | Error in XML | **integration-error** | *(never written)* | no |
| `902` | Data mismatch in one of the fields | **integration-error** | *(never written)* | no |
| `950` | Request missing transaction-level mandatory fields | **integration-error** | *(never written)* | no |
| *(anything else)* | Unrecognized | **integration-error** (fail-safe) | *(never written)* | no |

**The one rule that matters most**: `integration-error` codes mean *our* request was
malformed or credentials are wrong — never the customer's payment failing. They must
never be written to `dpo_transaction.status`, and `applyVerifyTokenResult` enforces this
centrally (tested explicitly in `__tests__/dpo-transaction.service.unit-spec.ts`).

Order-side Payment-state effect, from `DpoVerifyAndSettleService.verifyAndSettle`:

| `transactionStatus` | Vendure call |
|---|---|
| `paid` | `orderService.settlePayment` |
| `declined`, `expired` | `orderService.transitionPaymentToState(..., 'Declined')` |
| `cancelled` | `orderService.cancelPayment` |
| everything else (non-terminal / needs-review / integration-error / no code) | none — `dpo_transaction` row updated, Payment left `Authorized`, eligible for re-poll |

## 8. Testing

Three layers, all under `__tests__/`, all running through the repo's existing Vitest
setup (`pnpm test:e2e`, which despite the name now runs both unit and e2e suites — see
`vitest.config.mts`'s `test.include`). **98 tests, 9 files, all colocated in this one
`__tests__/` folder** — deliberately *not* scattered alongside the source files it
covers, so the plugin's real source tree (`api/`, `service/`, `entities/`, `config/`)
stays test-free and the whole test surface is browsable in one place.

```
__tests__/
├── dpo-result-code.unit-spec.ts              Phase 1 — pure functions, no DB, no mocks
├── dpo-date.unit-spec.ts
├── dpo-envelope.unit-spec.ts
├── redact.unit-spec.ts
│
├── dpo-client.unit-spec.ts                   Phase 2 — mocked collaborators, no DB,
├── dpo-transaction.service.unit-spec.ts       no bootstrapped server
├── dpo-verify-and-settle.service.unit-spec.ts
├── dpo-refund.service.unit-spec.ts
│
├── dpo.e2e-spec.ts                           Phase 3 — full bootstrapped Vendure server
└── fixtures/                                  (@vendure/testing + sql.js)
    ├── dpo-fetch-mock.ts                      Scriptable stand-in for DPO's live API
    ├── initial-data.ts                        InitialData incl. a 'dpo-pay' PaymentMethod
    └── e2e-products.csv                       One test product/variant
```

(`__data__/` also appears here at runtime — the sql.js database cache. It's gitignored
via the repo's blanket `*.sqlite` rule and safe to delete any time; it regenerates.)

### 8.1 Why tests are grouped in `__tests__/` instead of colocated with source

Colocating `*.spec.ts` next to each source file is a common convention, but this plugin
deliberately doesn't use it — everything test-related, including the fixtures and the
`DpoClient` fetch mock, lives in one `__tests__/` folder instead. Nothing in the setup
depends on file location:

- `vitest.config.mts`'s `test.include` is a repo-wide glob (`**/*.e2e-spec.ts`,
  `**/*.unit-spec.ts`) — it matches by filename suffix, not folder, so tests are found
  regardless of where they live.
- Mocking here is done via `vi.stubGlobal('fetch', ...)` / `vi.spyOn(...)`, not
  Vitest/Jest's `__mocks__`-folder auto-mocking convention — so there's no special
  location `fetch` mocking depends on either.
- Relative imports are just one path segment different (`../service/...` instead of
  `./...`), fixed once at file-creation time.

So the split is purely organizational, and safe: `api/`, `service/`, `entities/`,
`config/` now contain only real plugin source, and the entire test surface — including
what a DPO response looks like when mocked — is one `ls __tests__/` away.

### 8.2 Running the tests

```bash
# Everything in the repo (all plugins' e2e + unit suites)
pnpm test:e2e

# Just this plugin
pnpm vitest run src/plugins/dpo-plugin

# One layer only
pnpm vitest run src/plugins/dpo-plugin/__tests__/dpo-result-code.unit-spec.ts
pnpm vitest run src/plugins/dpo-plugin/__tests__/dpo.e2e-spec.ts

# Verbose Vendure server logging during the e2e suite (silent by default)
LOG=true pnpm vitest run src/plugins/dpo-plugin/__tests__/dpo.e2e-spec.ts

# Filter by test name
pnpm vitest run src/plugins/dpo-plugin/__tests__/dpo.e2e-spec.ts -t "callback"
```

### 8.3 How DPO itself is mocked

`DpoClient` is never dependency-injected (§2) — every consumer builds its own instance
and always calls the global `fetch`. So the one mocking seam that works everywhere is
`vi.spyOn(global, 'fetch')` / `vi.stubGlobal('fetch', ...)`. No `msw`/`nock` dependency
was added; it wasn't needed.

- **Phase 1** (pure functions) needs no mocking at all.
- **Phase 2** (service-level) stubs `global.fetch` directly per test and constructs the
  service under test with hand-built mock collaborators (`TransactionalConnection`,
  `OrderService`, etc.) — no DB, no bootstrapped Vendure app.
- **Phase 3** (e2e) uses `__tests__/fixtures/dpo-fetch-mock.ts`'s `DpoFetchMock`: it
  parses the outgoing XML body's own `<Request>` element (`createToken`, `verifyToken`,
  `refundToken`, `verifyRefund`, `cancelToken`) and returns a canned XML response queued
  by the test (`dpoFetchMock.queue('verifyToken', '<Result>000</Result>...')`) — an
  unqueued request type throws immediately rather than silently reaching the real DPO
  sandbox. Anything that **doesn't** parse as DPO XML (i.e. every GraphQL call the test's
  own `adminClient`/`shopClient` makes, since `SimpleGraphQLClient` also talks over plain
  `fetch` to the same in-process server) is passed straight through to `realFetch` — the
  genuinely un-stubbed `fetch`, captured once at module load before any stubbing happens.
  That same `realFetch` is what the e2e suite uses to hit its own server's
  `/payments/dpo/callback` and `/payments/dpo/return` REST endpoints directly, since
  GraphQL clients can't reach plain REST routes.

### 8.4 What's covered, file by file

| File | Covers |
|---|---|
| `dpo-result-code.unit-spec.ts` | Every documented result code's classification + fail-safe handling of an unknown code |
| `dpo-date.unit-spec.ts` | `formatServiceDate`, `parseDpoDateTimeAssumeUtc`, `parseDpoDateOnly`, `computePtlExpiresAt` |
| `dpo-envelope.unit-spec.ts` | v6 vs v7 (`Result`/`ResultExplanation` vs `Code`/`Explanation`) envelope normalization |
| `redact.unit-spec.ts` | `<CompanyToken>` redaction, including multiple occurrences and no-op on absent tag |
| `dpo-client.unit-spec.ts` | XML request building + response parsing for every `DpoClient` method, the mandatory `User-Agent` header, PTL defaults/overrides, `getHostedPaymentUrl` |
| `dpo-transaction.service.unit-spec.ts` | `applyPaymentConfirmationGuard` (webhook-twice, webhook/redirect races both directions, stale results), `applyVerifyTokenResult` (integration-error never writes state, terminal codes do), `findOpenTransactionForOrder` (retry-reuse logic, status/PTL-expiry filtering) |
| `dpo-verify-and-settle.service.unit-spec.ts` | Every `transactionStatus` → Vendure-call branch, no-transaction-found path, no-linked-Payment-yet path |
| `dpo-refund.service.unit-spec.ts` | Full-refund vs partial-refund status, refundToken-succeeds/verifyRefund-disagrees failure path, no-transToken guard, audit-log event sequence |
| `dpo.e2e-spec.ts` | `initiateDpoPayment` happy path + linkage, webhook settles a real order/payment, webhook tolerates an unknown token and still returns 200, redirect 302s with the verified status, webhook-then-redirect convergence, refund success and failure through the real Admin `refundOrder` mutation |

### 8.5 Known test-only nuances (don't "fix" these without re-reading why)

- **The idempotency guard is not a same-session double-click guard.** After the first
  successful `initiateDpoPayment`, Vendure marks the order inactive (payment
  Authorized), so a second call in the *same* session/order legitimately returns "No
  active order" — this was confirmed empirically while writing the e2e suite. The real
  purpose of `findOpenTransactionForOrder` is reuse-on-retry-after-partial-failure (e.g.
  `createToken` succeeds but `addPaymentToOrder` fails), which is why that logic is
  tested directly against the service (`dpo-transaction.service.unit-spec.ts`) rather
  than by calling the resolver twice end-to-end.
- **`refundOrder`'s e2e test passes `shipping: 0, adjustment: 0` alongside `amount`.**
  Those two fields are deprecated in `RefundOrderInput`, but this installed Vendure
  version's `PaymentService.createRefund` still writes them unconditionally onto the
  `Refund` entity's `NOT NULL` columns — omit them and the mutation throws a raw SQLite
  constraint error, not a GraphQL error.

## 9. Real bugs found (and fixed) while writing the tests

These weren't test artifacts — they blocked the plugin from working at all, not just from
being testable:

1. **`fast-xml-parser` was declared in `package.json` but never actually installed** —
   missing from both `node_modules` and `pnpm-lock.yaml`. Fixed by running `pnpm install`.
2. **`DpoTransaction.status`, `DpoRefund.status`, `DpoTransactionEvent.eventType`** used
   bare `@Column()` (or `@Column({ default: ... })`) on TS string-literal-union types with
   no explicit `type`. TypeORM's schema builder rejected this outright ("Data type
   'Object' ... is not supported") the moment a real DataSource tried to initialize
   against these entities. Fixed by declaring `type: 'varchar'` explicitly on all three.

## 10. Known gaps (unchanged from the original design doc)

- `verifyRefund`'s (v7) response fields aren't modelled — spec unconfirmed; only the
  normalized envelope's `code` determines refund success.
- No scheduled re-poll job for non-terminal transactions (codes `003`/`005`/`007`/`900`)
  that never receive a webhook or redirect.
- Cumulative multi-partial-refund tracking isn't modelled (§6).
- `TransactionPaymentDate`'s UTC assumption is unconfirmed (§5).
- The production Postgres migration for the 3 entities has not been generated/run — see
  [`docs/dpo-plugin.md`](../../../docs/dpo-plugin.md) §5 for the exact steps.
- No CI wiring — `pnpm test:e2e` runs locally but nothing currently runs it automatically
  on a PR (true for every suite in this repo, not just DPO's).
