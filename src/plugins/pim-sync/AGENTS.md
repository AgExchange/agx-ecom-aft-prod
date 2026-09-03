# PimSync — agent notes

## Product images — all images from ProductFile (IMPLEMENTED)

**Status:** DONE — merged to `master` via PRs #22 (image sync) + #24 (detail field).
User-facing prose lives in `docs/scripts.md` → "PIM Sync Operations" → "Product images".

### What it does

The sync imports **all** of a product's images (up to `maxProductImages`, default 5 — see
`DEFAULT_MAX_PRODUCT_IMAGES` in `constants.ts`), not just the main image. Source is AtroPIM's
`ProductFile` junction; the `Product.files` relation is `noLoad`, so it is fetched explicitly.

### Data flow

- `PimApiService.fetchProductFiles(productId)` → `GET /api/ProductFile?where=productId` returning
  `PimProductFile[]` (`fileId`, `fileName`, `isMainImage`, `sorting`). Pre-fetched in concurrent
  batches by `prefetchProductFiles()` (phase `product_file_prefetch`), same pattern as attribute
  values, so the per-variant loop is cache-served.
- `fetchProductFilesHttp` **collapses file versions** by filename (same core name = same logical
  image; prefer `isMainImage`, else highest `sorting`) and orders **main-first, then by `sorting`**.
  Blank filenames are dropped.
- `AssetSyncService.syncProductImages(ctx, product, files)` returns ordered `assetIds` (capped at
  `maxImages`); `assetIds[0]` is the main image. Per file, `syncImage()` does the two-pass dedup
  (Pass A name, Pass B fileSize+mimeType) and creates the asset under its **real PIM filename**.
- `product-upsert.service.ts` sets `featuredAssetId = assetIds[0]` and `assetIds` on both the
  variant (`upsertVariant`) and the product (from the OEM/representative variant's set).

### Invariants worth preserving

- **No renaming.** Assets keep their PIM filename. The only SKU-derived name is the read-only
  legacy `${sku}.${ext}` fallback in Pass A (main image only) so pre-existing single-image assets
  are reused, not re-downloaded. Do not reintroduce `_N` sequencing.
- **Version collapse is by filename**, not content hash — two `ProductFile` rows with the same
  name are one image even if a re-upload changed the bytes.
- `assetIds` replaces the entity's list each sync (PIM is source of truth).
- **Delta blind spot:** `ProductFile` changes don't bump `Product.modifiedAt`; a delta sync won't
  pick up image-only changes on existing products. A full sync (or touching the product in PIM) is
  required. If this becomes a pain point, the fix is a delta trigger keyed on `ProductFile` changes.

## Detail field — PIM Details → customFields.detail (IMPLEMENTED)

**Status:** DONE — PR #24. The PIM `details` value is mapped to the Product custom field
**`detail`** (defined in `vendure-config.ts`; a `localeText` field, so it is written inside the
translation object, **not** top-level `customFields`). OEM value preferred (same as `description`),
written only when non-empty so a curated value is never wiped. Previously `details` was used only
to build the product slug (`buildProductSlugSource`).

## Disable / enable lifecycle — re-enable reactivated products (IMPLEMENTED)

**Status:** DONE — implemented 2026-06-17 on branch `feat/pim-sync-enable-on-reactivate`
(off the original handoff note `docs/pim-sync-enable-on-reactivate-note`).
Counterpart to `src/scripts/disable-products-inactive-in-pim.ts`.

### Background

PIM is the source of truth for what is live. A product/variant is **active+ready** in PIM
only when it has the ecommerce data it needs (stock, price, weight); PIM deactivates the
rest (~75% of LBP — 7,605 of 10,117). The **disable** half,
`disable-products-inactive-in-pim.ts` (merged, run in prod), sets `Product.enabled=false`
**and** `ProductVariant.enabled=false` for every product whose SKUs are absent from
`fetchActiveProducts()`.

The sync previously had no **enable** half: its UPDATE path never touched `enabled`
(`enabled: true` was only set on CREATE), so a reactivated PIM product stayed hidden
forever. Reconciliation was one-directional.

### What was implemented (`product-upsert.service.ts`)

Everything reaching the upsert loop has already passed `fetchActiveProducts()`
(server-side `isActive=true AND status='ready'`, then the client-side channel filter), so
it is by definition meant to be live. On the UPDATE path:

1. **Product:** `productService.update(...)` now adds `enabled: true` — but **only when the
   product is currently disabled** (`existingProductEnabled` is captured from the
   `productService.findOne` already done when loading the product's variants).
2. **Variant:** `productVariantService.update(...)` now adds `enabled: true` — **only when
   that variant is currently disabled** (`existingSkuMap` now carries each matched variant's
   `enabled` flag). Variants reaching this path are in the current active set by construction,
   so this naturally enables only the right SKUs (handles future partial MPN groups).

### Guardrails honored

- **No-op when already enabled** — the `...(enabled ? {} : { enabled: true })` spread means a
  normal sync does NOT toggle `enabled` (and re-index) the whole catalogue; only genuinely
  disabled→reactivated rows flip.
- **Partial groups** — only variants whose SKU is in the active set are enabled (they're the
  only ones in `existingSkuMap`/`validVariants`).
- **`Product.enabled` is global, not per-channel** — same caveat as the disable script:
  enabling affects every channel the product belongs to. No cross-channel products on LBP
  today; revisit if a multi-channel product appears or if a non-PIM actor deliberately
  disables products for a channel.

### Counterpart

- Disable script: `src/scripts/disable-products-inactive-in-pim.ts` (docs:
  `docs/scripts.md` → "PIM Sync Operations"). With this change, disable + enable now form a
  full round-trip; the standalone disable script is a one-time backfill / safety net rather
  than a recurring necessity.
