# cms

| | |
| --- | --- |
| **Source** | `src/plugins/cms/` |
| **Integration type** | Plain source folder |
| **Ported from** | `agx-stores` — `src/plugins/cms/` |
| **Ported on** | 2026-09-02 (stage 2) |
| **Status** | Ported; structurally verified. **No outbound sync tested — no Payload instance in local dev** |
| **Vendure compatibility** | `^3.0.0` |
| **External npm dependencies** | None to install |
| **External service** | Payload CMS (`PAYLOAD_API_URL`, `PAYLOAD_API_KEY`) |

## Summary

One-way sync of Vendure **Collections** into a Payload CMS instance, so marketing
pages can be built around the same category tree the store uses.

Two triggers: an event subscription that queues a job whenever a `CollectionEvent`
fires, and a scheduled task for full reconciliation. The plugin's own log line is
explicit that its scope is narrower than its name — *"CMS Plugin initialized
(collection sync only)"*.

## Files

| File | Purpose |
| --- | --- |
| `cms.plugin.ts` | Plugin class. Creates the `cms-collection-sync` job queue in `onModuleInit` and subscribes to `CollectionEvent`. |
| `services/cms-sync.service.ts` | Sync orchestration. |
| `services/payload.service.ts` | HTTP client for the Payload API. |
| `api/api-extensions.ts`, `api/cms-sync-admin.resolver.ts` | Admin API surface. |
| `config/sync-cms-task.ts` | Scheduled reconciliation task. |
| `utils/translation.utils.ts` | Locale handling. |
| `constants.ts`, `types.ts` | Options token, `loggerCtx`, job/result types. |
| `dashboard/index.tsx` | Dashboard extension — **currently disabled**, see [Known issues](#known-issues). |

## Integration points

```ts
CmsPlugin.init({
    cmsApiUrl: process.env.PAYLOAD_API_URL,
    cmsApiKey: process.env.PAYLOAD_API_KEY,
}),
```

`configuration()` does one thing:

```ts
config.schedulerOptions.tasks.push(syncCmsTask);
```

Note this is a **mutating `.push()` on a possibly-undefined array**, unlike
`quote-plugin`'s defensive `[...(config.schedulerOptions.tasks ?? []), ...]`. It
works here because `DefaultSchedulerPlugin.init()` is registered earlier and
initialises the array. Remove or reorder that plugin and `cms` throws at config
time rather than degrading. See [Known issues](#known-issues).

Beyond that: `adminApiExtensions`, `dashboard`, and a runtime event subscription.

### No custom fields

This plugin declares none, and needs none. It reads Collections through the
standard entity API.

### API surface

| Operation | Type |
| --- | --- |
| `getCmsSyncStatus` | Query |
| `syncCollectionToCms(id: ID!)` | Mutation |
| `syncAllCollectionsToCms` | Mutation |

All three confirmed present in the running admin schema.

### Job queue

`cms-collection-sync`, created in `onModuleInit`. Every `CollectionEvent`
(`created`, `updated`, `deleted`) enqueues a job carrying `entityType`,
`entityId`, `operationType`, `timestamp` and `retryCount`. Jobs are processed by
the **worker**, so with only the server running they accumulate as `PENDING`.

## Migration

**None.** No custom fields, no entities. The plugin contributes nothing to
`src/migrations/1788352280095-stage-2-cms-pim-quote-multivendor.ts`.

## Verification

**Proven:**

- Source byte-identical to agx-stores
- `npx tsc --noEmit` — exit 0
- Server boots and logs `[CmsPlugin] CMS Plugin initialized (collection sync only)`,
  confirming `onModuleInit` ran and the job queue was created
- All three admin operations present in the introspected schema
- Dashboard extension registers cleanly with an empty `actionBarItems` — the
  three broken buttons are disabled, confirmed by a clean rebuild where
  `syncEntityToCms` and `Sync to CMS` both return zero matches in `dist/dashboard/`

**Not proven — requires a Payload instance:**

- Any outbound HTTP call to Payload
- Authentication with `PAYLOAD_API_KEY`
- The payload shape Payload actually receives
- `syncCmsTask` running to completion
- Whether a `CollectionEvent` job succeeds or fails when processed

With `PAYLOAD_API_URL` and `PAYLOAD_API_KEY` unset, the plugin loads and queues
work normally; failures occur only when a job is processed and the HTTP call is
attempted. **Editing a collection in local dev will therefore enqueue a job that
fails once the worker picks it up.** That is expected, not a port defect.

## Port notes

Registered identically to agx-stores (line 998 of its `vendure-config.ts`) with
the same two options. All 10 files copied verbatim.

Only difference: the credentials are absent locally and documented as blank in
`.env.example` rather than being carried over.

## Known issues

1. **The "Sync to CMS" buttons are broken — now commented out with a TODO.**

   `dashboard/index.tsx` sent `syncEntityToCms(id, entityType)`, but the server
   declares only `syncCollectionToCms(id: ID!)` and `syncAllCollectionsToCms`.
   `syncEntityToCms` exists nowhere in this repo **or in agx-stores** — confirmed
   by grep across both — so the buttons failed with *"Cannot query field
   syncEntityToCms on type Mutation"* against the current production backend too.
   **A pre-existing bug, faithfully ported, not introduced here.**

   There is a second problem behind the first: `SyncButton` was registered on
   `product-detail`, `product-variant-detail` **and** `collection-detail`, but
   this plugin syncs Collections only (its own boot log says *"collection sync
   only"*). Renaming the mutation would fix at most one of the three buttons —
   there is no server-side product or variant sync to call under any name.

   The component and its GraphQL document are preserved verbatim as comments in
   `dashboard/index.tsx`, under a TODO explaining both problems and the two ways
   forward:

   - **(a) Collection only** — retarget the document at `syncCollectionToCms(id: $id)`,
     drop `entityType` and the switch, register on `collection-detail` alone.
     Check `CmsSyncResult`'s real fields; they may not match the four selected.
   - **(b) Full entity sync** — add a `syncEntityToCms` mutation server-side that
     dispatches on `entityType`, plus product/variant paths in `CmsSyncService`.
     The existing component then works unchanged.

   Option (a) is a few lines and makes the working case work. Option (b) is the
   feature someone started and never finished.
2. **Unguarded `config.schedulerOptions.tasks.push()`** — see
   [Integration points](#integration-points). A one-line change to the spread form
   would make it order-independent.
3. **Options are not validated.** `cmsApiUrl`/`cmsApiKey` are typed as optional
   and never checked at startup, so a misconfiguration surfaces as failing jobs
   rather than a boot error.
4. **Sync is one-way and Collection-only**, despite the plugin's generic name and
   the `entityType` field threaded through `SyncJobData`.
