# contact

| | |
| --- | --- |
| **Source** | `src/plugins/contact/` |
| **Integration type** | Plain source folder (copied, not a submodule or npm package) |
| **Ported from** | `agx-stores` — `src/plugins/contact/` |
| **Ported on** | 2026-09-02 (stage 1) |
| **Status** | Ported and verified end to end |
| **Vendure compatibility** | `^3.0.0` |
| **External npm dependencies** | None — `@vendure/core` and `@nestjs/common` |

## Summary

Accepts contact form submissions from the storefront at `POST /contact`,
validates the five required fields, resolves a recipient address, and publishes a
`ContactUsEvent`. An `EmailEventListener` in `vendure-config.ts` turns that event
into an email.

It is a **REST endpoint, not a GraphQL extension** — the only plugin ported so far
that adds a Nest `@Controller`. That is deliberate: a public contact form does not
need the Shop API's session or channel-token machinery, and keeping it off the
GraphQL surface means it cannot be reached through the schema.

One file, and the most coupled thing in the batch.

## Files

| File | Purpose |
| --- | --- |
| `contact.plugin.ts` | `ContactController` (`@Post()` handler) and the `ContactPlugin` class, in one file. |

Its out-of-folder dependencies are where the real work is:

| File | Purpose |
| --- | --- |
| `src/events/contact.ts` | `ContactInput` interface and `ContactUsEvent extends VendureEvent`. |
| `src/events/index.ts` | Barrel. |
| `src/custom-fields/channel-contacts.ts` | The `infoEmail` Channel custom field. |
| `src/vendure-config.ts` | `contactAdminNotificationHandler` — the `EmailEventListener`. |
| `static/email/templates/contact-admin-notification/body.hbs` | The email template. |

## Integration points

Registered **bare** in `src/vendure-config.ts` — no `.init()`, no options:

```ts
import { ContactPlugin } from './plugins/contact/contact.plugin';
// ...
ContactPlugin,
```

The plugin declares `controllers: [ContactController]` and imports
`PluginCommonModule`. On boot, Nest logs:

```
[RoutesResolver] ContactController {/contact}:
[RouterExplorer] Mapped {/contact, POST} route
```

That log line is the cheapest proof the plugin registered.

### The event, and why it lives outside the plugin

In agx-stores, `ContactUsEvent` and `ContactInput` were declared inline in
`vendure-config.ts`, so the plugin imported from `../../vendure-config` — a
dependency on the very file that registers it.

Here they live in **`src/events/`**, a new sibling to `src/custom-fields/`. The
plugin publishes the event; an email handler in the config consumes it; neither
owns it. The rule this establishes:

> An event that crosses a plugin boundary belongs in `src/events/`. An event that
> never leaves its own plugin stays in that plugin.

### Request flow

```
POST /contact
  → validate the five required fields          (400 if any missing)
  → RequestContextService.create({ apiType: 'shop', channelOrToken })
  → recipient = channel.customFields.infoEmail
              ?? process.env.CONTACT_ADMIN_EMAIL
              ?? 'devstack@agxchange.co.za'
  → eventBus.publish(new ContactUsEvent(ctx, contact))
  → 201 { success: true }
```

The recipient is resolved **in the controller** and carried on the event, so the
email handler does not have to re-read the channel. That matters because the email
is sent from the worker, where a deserialised `event.ctx.channel` does not reliably
carry custom fields.

## Dependencies

| Dependency | Status |
| --- | --- |
| `@vendure/core` | ✅ |
| `@nestjs/common` (`Controller`, `Post`, `Body`, `Req`, `Res`, `HttpStatus`) | ⚠️ Not a direct dependency — resolves by npm hoisting from `@vendure/core`. Same arrangement as `product-info`. |
| `infoEmail` Channel custom field | ✅ [`src/custom-fields/channel-contacts.ts`](../../src/custom-fields/channel-contacts.ts) |
| `CONTACT_ADMIN_EMAIL` env var | ✅ In `.env`, documented in `.env.example` |
| `contact-admin-notification` email template | ✅ `static/email/templates/` |
| `partials/header.hbs`, `partials/footer.hbs` | ✅ Shipped by the scaffolder |

### Channel custom field

Only `infoEmail` was ported. agx-stores declares four more on `Channel` —
`storefrontUrl`, `orderNotificationEmail`, `shippingContactEmail`,
`financeContactEmail` — which belong to plugins not yet ported. They are left out
so no column lands without a consumer.

### Migration

`src/migrations/1788351418720-stage-1-order-metadata-and-contact.ts` — shared with
[order-metadata-ui](./order-metadata-ui.md). Contributes one statement:

```sql
ALTER TABLE "channel" ADD "customFieldsInfoemail" character varying(255);
```

## Behaviour and edge cases

- **Success returns HTTP 201, not 200.** Nest's default status for `@Post()`.
  A storefront checking `response.status === 200` will treat a successful
  submission as a failure. Check `body.success` or accept `2xx`.
- **Validation is presence-only.** `if (!firstName || !lastName || ...)` — there is
  no email-format check, no phone validation, no length limit on `message`. An
  empty string fails (falsy), but a single space passes.
- **No rate limiting, no CAPTCHA, no authentication.** A public unthrottled POST
  that triggers an email. See [Known issues](#known-issues).
- **Channel resolution is header-driven** — `vendure-token` selects the channel,
  and therefore which `infoEmail` is used. An absent or unknown token falls back to
  the default channel.
- **Errors are swallowed.** The `catch` block returns a generic 500 without logging
  anything. A misconfigured EventBus or a channel lookup failure produces no trace.
- **The email is asynchronous.** `eventBus.publish` returns before the email is
  sent; EmailPlugin enqueues a `send-email` job that the **worker** processes. A
  `{ success: true }` response therefore means "accepted", not "delivered". With
  the server running but no worker, jobs sit in `job_record` as `PENDING` forever.

## Verification

1. **Route registered** — boot the server and look for
   `[RouterExplorer] Mapped {/contact, POST} route`.
2. **Validation path**:
   ```bash
   curl -s -X POST http://localhost:3000/contact -H "Content-Type: application/json" -d '{"firstName":"Julian"}'
   ```
   → HTTP 400, `{"success":false,"message":"All fields are required"}`
3. **Success path** — all five fields → HTTP **201**, `{"success":true}`.
4. **Event was published** — check the queue:
   ```sql
   SELECT id, "queueName", state FROM job_record ORDER BY id DESC LIMIT 3;
   ```
   A `send-email` row must appear. **This is the step that matters**: a 201 alone
   only proves the controller ran. If no job appears, the event went nowhere and
   the endpoint is silently doing nothing — the same failure class as the
   shipping-weight bug.
5. **Email rendered** — run the worker (`npm run dev:worker`) to drain the queue,
   then check `static/email/test-emails/` for the generated file. EmailPlugin is in
   `devMode`, so nothing is actually sent.
6. **Channel fallback** — set `infoEmail` on the channel in the dashboard and
   confirm it takes precedence over `CONTACT_ADMIN_EMAIL` in the recipient.

## Port notes

Integration in `agx-stores` was identical: plain source folder, registered bare as
`ContactPlugin` at line 1076 of its `vendure-config.ts`. The controller was copied
verbatim apart from one line.

Deliberate differences:

1. **`ContactUsEvent` / `ContactInput` moved to `src/events/`.** The plugin's
   import changed from `'../../vendure-config'` to `'../../events'` — the only edit
   made to the copied file.
2. **Only `infoEmail` ported**, not all five Channel fields.
3. **`CONTACT_ADMIN_EMAIL` documented** in a new `.env.example`. agx-stores has no
   such file, so its env requirements are discoverable only by reading the config.

The hardcoded final fallback (`'devstack@agxchange.co.za'`) was kept as-is to match
the reference, though it should probably become a required env var before this
reaches production.

## Known issues

1. **No abuse protection.** Public, unauthenticated, unthrottled, and it sends
   email — a spam relay waiting to happen. Needs rate limiting (per IP and/or per
   email address) before it faces the internet. This is the most important
   follow-up in stage 1.
2. **Errors are silently swallowed** — the bare `catch` returns 500 with no
   `Logger.error`. A `loggerCtx` should be added, matching the other plugins.
3. **`@Body() body: any`** — no DTO, no `ValidationPipe`, so nothing constrains
   types or sizes. `message` could be megabytes.
4. **Hardcoded fallback recipient** (`devstack@agxchange.co.za`) baked into the
   plugin source.
5. **No email-format validation** on the submitter's address, so the `email` field
   in the notification may be unusable for replies.
6. **201 rather than 200** on success — harmless but easy for a storefront to get
   wrong. Worth documenting for whoever writes the frontend.
