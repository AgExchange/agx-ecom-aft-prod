import { Inject, Injectable } from '@nestjs/common';
import { GlobalFlag } from '@vendure/common/lib/generated-types';
import {
    ListQueryOptions,
    Logger,
    Product,
    ProductService,
    ProductVariant,
    ProductVariantService,
    RequestContext,
} from '@vendure/core';
import { PIM_SYNC_OPTIONS, loggerCtx } from '../constants';
import { MpnGroup, PimAttributeValue, PimProduct, PimSyncOptions } from '../types';
import { AssetSyncService } from './asset-sync.service';
import { FacetSyncService } from './facet-sync.service';
import { PimApiService } from './pim-api.service';
import { PriceStockSyncService } from './price-stock-sync.service';

interface VariantErrorDetail {
    sku: string;
    error: string;
}

interface UpsertResult {
    action: 'created' | 'updated' | 'skipped';
    vendureProductId: string | null;
    variantErrors: number;
    variantErrorDetails: VariantErrorDetail[];
    /** Vendure variant rows actually created (new SKUs). */
    variantsCreated: number;
    /** Vendure variant rows actually updated (existing SKUs). */
    variantsUpdated: number;
}

@Injectable()
export class ProductUpsertService {
    constructor(
        @Inject(PIM_SYNC_OPTIONS) private _options: PimSyncOptions,
        private productService: ProductService,
        private productVariantService: ProductVariantService,
        private facetSyncService: FacetSyncService,
        private assetSyncService: AssetSyncService,
        private pimApiService: PimApiService,
        private priceStockSyncService: PriceStockSyncService,
    ) {}

    async upsertMpnGroup(ctx: RequestContext, group: MpnGroup): Promise<UpsertResult> {

        // ════════════════════════════════════════════════════════════════════
        // PHASE 1 — Pre-validation (pure data checks, zero DB access)
        // Any variant that cannot be cleanly written is excluded before we
        // touch the database. The service layer is never called with invalid data.
        // ════════════════════════════════════════════════════════════════════
        const productsWithSku = group.products.filter(p => p.number != null && p.number !== '');
        if (productsWithSku.length === 0) {
            Logger.warn(`  MPN group "${group.mpn}" has no products with a SKU — skipping`, loggerCtx);
            return { action: 'skipped', vendureProductId: null, variantErrors: 0, variantErrorDetails: [], variantsCreated: 0, variantsUpdated: 0 };
        }

        const preValidationErrors: VariantErrorDetail[] = [];
        const validVariants: PimProduct[] = [];
        for (const pimProduct of productsWithSku) {
            // group.mpn is the effective base MPN for suffix derivation.
            // For singleton groups (unknown suffix), group.mpn === pimProduct.number,
            // so deriveSuffix returns '' → OEM / ORIGINAL EQUIPMENT.
            const reason = this.validateVariant(pimProduct, group.mpn);
            if (reason) {
                const sku = pimProduct.number ?? pimProduct.id;
                preValidationErrors.push({ sku, error: reason });
                Logger.error(`  [Pre-validation] SKU ${sku} in MPN "${group.mpn}" rejected: ${reason}`, loggerCtx);
            } else {
                validVariants.push(pimProduct);
            }
        }

        // Never create a product if no variants would be valid — orphaned products
        // with no variants are a data integrity violation.
        if (validVariants.length === 0) {
            Logger.warn(
                `  MPN group "${group.mpn}": all ${productsWithSku.length} variant(s) failed ` +
                `pre-validation — skipping entire group, no database writes performed`,
                loggerCtx,
            );
            return {
                action: 'skipped', vendureProductId: null,
                variantErrors: preValidationErrors.length, variantErrorDetails: preValidationErrors,
                variantsCreated: 0, variantsUpdated: 0,
            };
        }

        // Resolved once here — used by the dedup check in Phase 2,
        // the conflict check in Phase 2, and addOptionGroupToProduct in Phase 3.
        const partTypeGroupId  = this.facetSyncService.getPartTypeGroupId();

        // ════════════════════════════════════════════════════════════════════
        // PHASE 2 — Read-only lookups and idempotent side-effects before writes.
        //  • Facet value ensures may commit new rows; those commits must not be
        //    coupled to product writes so facet IDs remain valid on failure.
        //  • Image uploads commit to storage immediately; they are independent
        //    of product writes by design.
        //  • Slug uniqueness and tax category lookups are read-only.
        // ════════════════════════════════════════════════════════════════════

        // Facet values: classification (L1 ancestor) + CollectionsID (per category code)
        const facetValueIds: string[] = [];
        if (group.classificationName) {
            const classId = await this.facetSyncService.resolveClassificationFacetValueId(
                ctx, group.classificationName,
            );
            if (classId !== null) {
                facetValueIds.push(String(classId));
                Logger.verbose(
                    `  MPN "${group.mpn}": classification "${group.classificationName}" → facet value id=${classId}`,
                    loggerCtx,
                );
            }
        }
        if (group.collectionCodes?.length) {
            const collectionFvIds = await this.facetSyncService.resolveCollectionIdFacetValueIds(
                ctx, group.collectionCodes,
            );
            for (const id of collectionFvIds) facetValueIds.push(String(id));
        }

        // Existing variant lookup (read-only, channel-scoped). Used to build the
        // SKU→variant map (UPDATE vs CREATE) and for cross-product detection — NOT to
        // decide the product identity (that is the MPN key, resolved below).
        const skus = validVariants.map(p => p.number as string);
        const existingSkuMap = new Map<string, { id: string; productId: string; enabled: boolean }>();
        let vendureProductId: string | null = null;
        // Current Product.enabled — captured when the product is loaded so the re-enable
        // on the UPDATE path is a no-op when the product is already live (see Phase 3).
        let existingProductEnabled = false;
        // Loaded once if a product exists; used for cross-product detection AND the
        // option-combo conflict check to avoid a separate query in each.
        let allProductVariants: ProductVariant[] = [];

        const existingResult = await this.productVariantService.findAll(ctx, {
            filter: { sku: { in: skus } },
            take: skus.length + 10,
        });

        // ── Resolve the Vendure Product for this MPN group ───────────────────────
        // PRIMARY KEY — Product.customFields.mpn. The MPN is the canonical, stable link
        // between a PIM MPN group and its Vendure Product, independent of SKU (which can be
        // reassigned across alternate-part sources) and slug (now SEO-generated from name).
        // The two fallbacks below only matter for products synced before the MPN field
        // existed; the sync backfills customFields.mpn on every UPDATE, so after one full
        // sync the MPN lookup is authoritative for all products.
        vendureProductId = await this.findProductIdByMpn(ctx, group.mpn);

        // FALLBACK 1 — SKU: the parent product of any already-matched variant. Covers
        // legacy products that do not yet carry the MPN custom field.
        // Translated<ProductVariant> extends ProductVariant — no cast needed.
        if (!vendureProductId && existingResult.items.length > 0) {
            const parentProduct = await this.productVariantService.getProductForVariant(ctx, existingResult.items[0]);
            vendureProductId = String(parentProduct.id);
        }

        // FALLBACK 2 — Orphan detection by the legacy MPN-based slug. Handles a product row
        // created by a previous sync that failed to write translations or variants
        // (e.g. the withTransaction translation bug). Treat it as an UPDATE target so we
        // repair the name and create the missing variants rather than attempting a
        // duplicate CREATE that would either collide or produce a second orphan.
        // (SEO slugs won't match here, but the MPN lookup above already covers those.)
        if (!vendureProductId) {
            const expectedSlug = this.toSlug(group.mpn);
            const bySlug = await this.productService.findOneBySlug(ctx, expectedSlug);
            if (bySlug) {
                vendureProductId = String(bySlug.id);
                Logger.warn(
                    `  MPN "${group.mpn}": no MPN/SKU match but orphaned product id=${vendureProductId} ` +
                    `exists with slug "${expectedSlug}" — will repair name and add variants via UPDATE path`,
                    loggerCtx,
                );
            }
        }

        // ── Load the resolved product's variants + build the SKU map ─────────────
        // Runs for ANY resolved product regardless of how it was found above. The MPN
        // key is authoritative: a SKU whose variant lives on a different product is the
        // anomaly and is excluded (cross-product detection below).
        if (vendureProductId) {
            // Load all non-deleted variants of this product with options resolved.
            // options is required for the option-combo conflict check further below.
            const productWithVariants = await this.productService.findOne(ctx, Number(vendureProductId), ['variants', 'variants.options']);
            allProductVariants = (productWithVariants?.variants ?? []).filter(v => !v.deletedAt);
            existingProductEnabled = productWithVariants?.enabled ?? false;
            const productVariantIdSet = new Set(allProductVariants.map(v => String(v.id)));

            for (const variant of existingResult.items) {
                if (!productVariantIdSet.has(String(variant.id))) {
                    // This SKU-matched variant belongs to a different product than the one
                    // resolved for this MPN group — data inconsistency from a previous sync
                    // or bulk-import. Fetch its actual parent for a useful error message.
                    const actualParent = await this.productVariantService.getProductForVariant(ctx, variant);
                    const actualProductId = String(actualParent.id);
                    Logger.warn(
                        `  [Cross-product] SKU ${variant.sku} in MPN "${group.mpn}" belongs to ` +
                        `product ${actualProductId}, expected ${vendureProductId}. ` +
                        `Excluding from this sync — run fix-null-variant-names.ts to repair the name.`,
                        loggerCtx,
                    );
                    preValidationErrors.push({
                        sku: variant.sku,
                        error:
                            `SKU exists in Vendure product ${actualProductId} instead of ` +
                            `the expected product ${vendureProductId} for MPN group "${group.mpn}". ` +
                            `This is a data inconsistency from a previous sync. ` +
                            `Run fix-null-variant-names.ts to repair the variant name, then ` +
                            `consolidate-duplicate-products.ts to fix the product assignment.`,
                    });
                    // Do NOT add to existingSkuMap — this variant will be skipped entirely.
                    // Updating it would pass optionIds for a product that may not have the
                    // Part Standards group, causing validateVariantOptionIds to throw.
                } else {
                    existingSkuMap.set(variant.sku, { id: String(variant.id), productId: vendureProductId, enabled: variant.enabled });
                }
            }

            // After cross-product exclusions, remove the affected SKUs from validVariants.
            // These variants cannot be safely updated in this run.
            if (preValidationErrors.length > 0) {
                const errorSkus = new Set(preValidationErrors.map(e => e.sku));
                const filtered = validVariants.filter(p => !errorSkus.has(p.number as string));
                if (filtered.length < validVariants.length) {
                    validVariants.length = 0;
                    validVariants.push(...filtered);
                    if (validVariants.length === 0) {
                        Logger.warn(
                            `  MPN group "${group.mpn}": all variants excluded (cross-product or pre-validation) — skipping`,
                            loggerCtx,
                        );
                        return {
                            action: 'skipped', vendureProductId: null,
                            variantErrors: preValidationErrors.length,
                            variantErrorDetails: preValidationErrors,
                            variantsCreated: 0, variantsUpdated: 0,
                        };
                    }
                }
            }
        }

        // ── Within-group duplicate dedup — CREATE candidates only ────────────────
        // UPDATE candidates already exist in Vendure with their current options.
        // Vendure only validates uniqueness on the option IDs you WRITE; existing
        // co-existing variants (e.g. from a bulk import) are not re-validated.
        // Only new variants (CREATEs) can introduce a fresh duplicate combination.
        {
            const createCandidateSkus = new Set(
                validVariants.filter(p => !existingSkuMap.has(p.number!)).map(p => p.number!),
            );
            if (createCandidateSkus.size > 1 && partTypeGroupId !== null) {
                const seenCombinations = new Set<string>();
                const conflictSkus    = new Set<string>();
                for (const pimProduct of validVariants.filter(p => createCandidateSkus.has(p.number!))) {
                    const sku       = pimProduct.number!;
                    const partStdId = this.facetSyncService.resolvePartTypeOptionId(sku, group.mpn);
                    const comboKey  = `${partStdId ?? 'none'}`;
                    if (seenCombinations.has(comboKey)) {
                        preValidationErrors.push({
                            sku,
                            error:
                                `Duplicate option combination (Online Option id ${partStdId}): ` +
                                `another new SKU in MPN group "${group.mpn}" already maps to the same option. ` +
                                `Each new variant must have a unique option. Check the PIM for duplicate grade variants.`,
                        });
                        Logger.warn(
                            `  [Dedup] SKU ${sku} excluded from MPN "${group.mpn}": ` +
                            `option combo "${comboKey}" already used by another new variant in this group`,
                            loggerCtx,
                        );
                        conflictSkus.add(sku);
                    } else {
                        seenCombinations.add(comboKey);
                    }
                }
                if (conflictSkus.size > 0) {
                    const filtered = validVariants.filter(p => !conflictSkus.has(p.number!));
                    validVariants.length = 0;
                    validVariants.push(...filtered);
                    if (validVariants.length === 0) {
                        Logger.warn(
                            `  MPN group "${group.mpn}": all new variants excluded after deduplication — skipping`,
                            loggerCtx,
                        );
                        return {
                            action: 'skipped', vendureProductId: null,
                            variantErrors: preValidationErrors.length, variantErrorDetails: preValidationErrors,
                            variantsCreated: 0, variantsUpdated: 0,
                        };
                    }
                }
            }
        }

        // ── Existing-product option-combo conflict check ───────────────────────
        // If the Vendure product exists and already has variants (from a previous
        // import or older sync run) that use the SAME option combination as a CREATE
        // candidate, productVariantService.create() will throw
        // error.product-variant-options-combination-already-exists. Detecting
        // conflicts here lets us skip the offending candidates and still process
        // the rest of the group rather than aborting the whole group.
        //
        // The key is the sorted combination of ALL option IDs on the existing variant,
        // mirroring what Vendure's validateVariantOptionIds actually checks.
        if (vendureProductId !== null && partTypeGroupId !== null) {
            const createCandidates = validVariants.filter(p => !existingSkuMap.has(p.number!));
            if (createCandidates.length > 0) {
                const knownIds = new Set([...existingSkuMap.values()].map(v => v.id));
                // allProductVariants was loaded with options during the existing variant
                // lookup — no additional query needed here.
                const usedCombinations = new Map<string, { id: string; sku: string }>();
                for (const v of allProductVariants) {
                    if (knownIds.has(String(v.id))) continue;
                    const comboKey = v.options
                        .map(o => Number(o.id))
                        .sort((a, b) => a - b)
                        .join(',');
                    if (comboKey) usedCombinations.set(comboKey, { id: String(v.id), sku: v.sku });
                }
                if (usedCombinations.size > 0) {
                    const conflictSkus = new Set<string>();
                    for (const pimProduct of createCandidates) {
                        const sku = pimProduct.number!;
                        const partStdId = this.facetSyncService.resolvePartTypeOptionId(sku, group.mpn);
                        const newIds    = [partStdId]
                            .filter((id): id is number => id !== null)
                            .sort((a, b) => a - b);
                        const comboKey  = newIds.join(',');
                        const conflict  = usedCombinations.get(comboKey);
                        if (conflict) {
                            Logger.warn(
                                `  [Option conflict] CREATE candidate SKU ${sku} in MPN "${group.mpn}" ` +
                                `conflicts with existing variant ${conflict.sku} (id ${conflict.id}) — ` +
                                `same option combo "${comboKey}". Skipping.`,
                                loggerCtx,
                            );
                            preValidationErrors.push({
                                sku,
                                error:
                                    `Cannot create: product already has variant ${conflict.sku} with the ` +
                                    `same option combination (ids ${comboKey}). Consolidate or remove the ` +
                                    `conflicting variant, then re-run the sync.`,
                            });
                            conflictSkus.add(sku);
                        }
                    }
                    if (conflictSkus.size > 0) {
                        const filtered = validVariants.filter(p => !conflictSkus.has(p.number!));
                        validVariants.length = 0;
                        validVariants.push(...filtered);
                        if (validVariants.length === 0) {
                            Logger.warn(
                                `  MPN group "${group.mpn}": all CREATE candidates have option conflicts — skipping`,
                                loggerCtx,
                            );
                            return {
                                action: 'skipped', vendureProductId: null,
                                variantErrors: preValidationErrors.length, variantErrorDetails: preValidationErrors,
                                variantsCreated: 0, variantsUpdated: 0,
                            };
                        }
                    }
                }
            }
        }

        // Product name: derived from the OEM variant among the already-validated set,
        // falling back to the first valid variant. All validVariants passed validateVariant
        // which enforces non-null name, so this is always a real PIM name — no placeholders.
        // group.productName is intentionally NOT used here because it is computed before
        // pre-validation and may reference a variant that was excluded for a failed read.
        const oemValidVariant = validVariants.find(p => p.number?.trim() === group.mpn)
            ?? validVariants[0];
        const productName = oemValidVariant.name!.trim();
        if (!productName) {
            // Assertion failure — validateVariant should have caught this.
            throw new Error(
                `BUG: productName is empty for MPN group "${group.mpn}" despite passing validation`,
            );
        }

        // Product slug: keep imported product URLs aligned with the SEO-friendly PIM data.
        const slugSource = this.buildProductSlugSource(group.mpn, productName, oemValidVariant);
        const slug = await this.uniqueSlug(ctx, slugSource, vendureProductId);

        // PIM "Details" → Vendure Product.customFields.detail (localeText, so it is written
        // inside the translation, not top-level customFields). Prefer the OEM's value, same
        // as description. Only written when PIM has a value so a manually-curated detail is
        // never wiped by an empty PIM field.
        const productDetail = (group.oem?.details ?? group.products[0].details ?? '').trim();

        // Image sync per variant — commits assets independently before the product
        // transaction so a rollback does not leave orphaned storage files
        const variantAssets = new Map<string, { assetIds: string[]; featuredAssetId: string | undefined }>();
        for (const pimProduct of validVariants) {
            // ProductFile is the authoritative image source (up to maxProductImages,
            // main image first). assetIds[0] is the main image → the variant's featuredAsset.
            const files = await this.pimApiService.fetchProductFiles(pimProduct.id);
            const assetIds = await this.assetSyncService.syncProductImages(ctx, pimProduct, files);
            variantAssets.set(pimProduct.number!, {
                assetIds,
                featuredAssetId: assetIds[0],
            });
        }

        // Product-level assets: prefer the OEM variant's images so the product list shows a
        // photo. Falls back to the first variant that has any. assetIds[0] is the featured.
        const oemSku = group.oem?.number?.trim();
        const productAssetIds: string[] =
            (oemSku && variantAssets.get(oemSku)?.assetIds.length ? variantAssets.get(oemSku)!.assetIds : undefined)
            ?? [...variantAssets.values()].find(a => a.assetIds.length)?.assetIds
            ?? [];
        const productFeaturedAssetId: string | undefined = productAssetIds[0];

        // ── Attribute → Facet value resolution ───────────────────────────────
        // Fetch attribute values per PIM product, resolve to Vendure FacetValue IDs.
        // Product-level attributes (not in variantSpecificAttributesIds) use OEM values.
        // Variant-specific attributes are resolved per variant SKU.
        const oemProduct = validVariants.find(p => p.number?.trim() === group.mpn) ?? validVariants[0];
        const productAttrFvIds: string[] = [];
        const variantAttrFvMap = new Map<string, string[]>();

        // Fetch attribute values for every valid variant
        const attrValuesByProductId = new Map<string, Awaited<ReturnType<typeof this.pimApiService.fetchAttributeValues>>>();
        for (const pimProduct of validVariants) {
            const values = await this.pimApiService.fetchAttributeValues(pimProduct.id);
            attrValuesByProductId.set(pimProduct.id, values);
            Logger.verbose(
                `  MPN "${group.mpn}" SKU "${pimProduct.number}": ` +
                `${values.length} attribute value(s) fetched from PIM` +
                (values.length > 0
                    ? ` (attrIds: ${values.map(v => v.attributeId).join(', ')})`
                    : ' — no attributes'),
                loggerCtx,
            );
        }

        // Resolve product-level attribute FV IDs from OEM variant
        const oemAttrValues = attrValuesByProductId.get(oemProduct.id) ?? [];
        const variantSpecificIds = new Set(oemProduct.variantSpecificAttributesIds ?? []);
        Logger.verbose(
            `  MPN "${group.mpn}" OEM SKU "${oemProduct.number}": ` +
            `${oemAttrValues.length} attr value(s); variantSpecificIds=[${[...variantSpecificIds].join(', ')}]`,
            loggerCtx,
        );

        let noDefSkipped = 0;
        for (const av of oemAttrValues) {
            if (variantSpecificIds.has(av.attributeId)) {
                Logger.verbose(
                    `  MPN "${group.mpn}" attr ${av.attributeId}: skipping at product level — variant-specific`,
                    loggerCtx,
                );
                continue;
            }
            const def = this.facetSyncService.getAttributeDef(av.attributeId);
            if (!def) {
                noDefSkipped++;
                Logger.verbose(
                    `  MPN "${group.mpn}" attr ${av.attributeId}: no definition in attrDefMap — not in channel scope, skipping`,
                    loggerCtx,
                );
                continue;
            }
            const scalars = this.flattenAttrValue(av);
            Logger.verbose(
                `  MPN "${group.mpn}" attr "${def.code}" (${def.name}): raw value=${JSON.stringify(av.value)}, ` +
                `unit=${av.valueUnitName ?? 'none'}, type=${av.type}, scalars=[${scalars.join(', ')}]`,
                loggerCtx,
            );
            for (const scalar of scalars) {
                const fvId = await this.facetSyncService.resolveAttributeFacetValueId(ctx, def.code, def.name, scalar);
                if (fvId) productAttrFvIds.push(fvId);
            }
        }
        if (noDefSkipped > 0) {
            Logger.verbose(
                `  MPN "${group.mpn}": ${noDefSkipped} OEM attribute value(s) skipped — attributeId not in ` +
                `attrDefMap (${this.facetSyncService.getAttrDefCount()} defs loaded for this channel). ` +
                `These attributes belong to a different channel in PIM.`,
                loggerCtx,
            );
        }
        Logger.verbose(
            `  MPN "${group.mpn}": product-level attribute FacetValues: ${productAttrFvIds.length} resolved ` +
            `from ${oemAttrValues.length - noDefSkipped - variantSpecificIds.size} in-scope non-variant attrs`,
            loggerCtx,
        );

        // Resolve variant-specific attribute FV IDs per SKU
        for (const pimProduct of validVariants) {
            const values = attrValuesByProductId.get(pimProduct.id) ?? [];
            const ids: string[] = [];
            let varNoDefSkipped = 0;
            for (const av of values) {
                if (!(pimProduct.variantSpecificAttributesIds ?? []).includes(av.attributeId)) continue;
                const def = this.facetSyncService.getAttributeDef(av.attributeId);
                if (!def) {
                    varNoDefSkipped++;
                    Logger.verbose(
                        `  MPN "${group.mpn}" SKU "${pimProduct.number}" attr ${av.attributeId}: no def in attrDefMap — skipping`,
                        loggerCtx,
                    );
                    continue;
                }
                const scalars = this.flattenAttrValue(av);
                Logger.verbose(
                    `  MPN "${group.mpn}" SKU "${pimProduct.number}" variant attr "${def.code}": raw=${JSON.stringify(av.value)}, unit=${av.valueUnitName ?? 'none'}, scalars=[${scalars.join(', ')}]`,
                    loggerCtx,
                );
                for (const scalar of scalars) {
                    const fvId = await this.facetSyncService.resolveAttributeFacetValueId(ctx, def.code, def.name, scalar);
                    if (fvId) ids.push(fvId);
                }
            }
            if (varNoDefSkipped > 0) {
                Logger.verbose(
                    `  MPN "${group.mpn}" SKU "${pimProduct.number}": ${varNoDefSkipped} variant attr(s) skipped — not in attrDefMap for this channel`,
                    loggerCtx,
                );
            }
            variantAttrFvMap.set(pimProduct.number!, ids);
        }

        // Build combined facetValueIds: base (classification + collection) + product-level attrs
        const combinedProductFvIds = [...facetValueIds, ...productAttrFvIds];
        Logger.verbose(
            `  MPN "${group.mpn}": combinedProductFvIds: ${combinedProductFvIds.length} total ` +
            `(classification+collection=${facetValueIds.length}, attrs=${productAttrFvIds.length})`,
            loggerCtx,
        );

        // ════════════════════════════════════════════════════════════════════
        // PHASE 3 — Write product and variants.
        // Both CREATE and UPDATE use direct service calls without withTransaction.
        // Vendure 3.6 / TypeORM 0.3 does not route TranslatableSaver writes
        // through an outer transaction manager, causing translations to be
        // written with null names (product) or not written at all (variant).
        // Direct calls — the same pattern used by bulk-import.ts — work correctly.
        // ════════════════════════════════════════════════════════════════════

        // Option groups are only meaningful when a product has more than one
        // variant. Single-variant products must not have option groups attached —
        // Vendure requires every variant to carry exactly one option from each
        // attached group. When a second variant arrives in a future sync run,
        // groups are attached then and the new variant receives its option IDs.
        const createCandidateCount  = validVariants.filter(p => !existingSkuMap.has(p.number!)).length;
        const hasCandidatesToCreate = createCandidateCount > 0;
        const totalVariantCount     = allProductVariants.length + createCandidateCount;
        const needsOptionGroups     = hasCandidatesToCreate && totalVariantCount > 1;

        let variantsCreatedCount = 0;
        let variantsUpdatedCount = 0;

        try {
            let prodId: string;
            let prodAction: 'created' | 'updated';

            if (vendureProductId) {
                // ── UPDATE path ──────────────────────────────────────────────
                prodAction = 'updated';
                prodId = vendureProductId;

                Logger.verbose(
                    `  Updating product id=${vendureProductId} name="${productName}" MPN="${group.mpn}"`,
                    loggerCtx,
                );
                await this.productService.update(ctx, {
                    id: Number(vendureProductId),
                    translations: [{
                        languageCode: ctx.languageCode,
                        name:        productName,
                        slug,
                        description: group.oem?.description ?? group.products[0].description ?? '',
                        ...(productDetail ? { customFields: { detail: productDetail } } : {}),
                    }],
                    // Only replace facet values when PIM provided category or attribute data.
                    // Passing [] clears existing values, removing the product from all facet-driven collections.
                    ...(combinedProductFvIds.length > 0 ? { facetValueIds: combinedProductFvIds } : {}),
                    ...(productAssetIds.length > 0 ? { featuredAssetId: productFeaturedAssetId, assetIds: productAssetIds } : {}),
                    // Backfill/maintain the canonical MPN key. Partial customFields patch —
                    // leaves detail/specification/SEO fields untouched.
                    customFields: { mpn: group.mpn },
                    // Re-enable products PIM has reactivated (counterpart to
                    // disable-products-inactive-in-pim.ts). Everything reaching this loop
                    // passed fetchActiveProducts() (server-side isActive=true AND ready),
                    // so it is by definition meant to be live. No-op when already enabled,
                    // so a normal sync does not toggle enabled (and re-index) the whole catalogue.
                    ...(existingProductEnabled ? {} : { enabled: true }),
                });

                if (needsOptionGroups) {
                    if (partTypeGroupId) {
                        await this.productService.addOptionGroupToProduct(ctx, Number(prodId), String(partTypeGroupId));
                    }
                    await this.backfillExistingVariantOptions(ctx, group.mpn, allProductVariants);
                }

                for (const pimProduct of validVariants) {
                    const assets = variantAssets.get(pimProduct.number!)!;
                    const isNewVariant = !existingSkuMap.has(pimProduct.number!);
                    const dimensionWeightG = this.resolveDimensionWeightG(pimProduct.number!, attrValuesByProductId.get(pimProduct.id) ?? []);
                    try {
                        await this.upsertVariant(ctx, prodId, group.mpn, pimProduct, existingSkuMap, [...combinedProductFvIds, ...(variantAttrFvMap.get(pimProduct.number!) ?? [])], assets, needsOptionGroups, dimensionWeightG);
                        if (isNewVariant) variantsCreatedCount++; else variantsUpdatedCount++;
                    } catch (varErr: unknown) {
                        const msg = varErr instanceof Error ? varErr.message : String(varErr);
                        preValidationErrors.push({ sku: pimProduct.number!, error: msg });
                        Logger.error(
                            `  [Variant error] SKU ${pimProduct.number!} in MPN "${group.mpn}": ${msg}`,
                            loggerCtx,
                        );
                    }
                }

            } else {
                // ── CREATE path ──────────────────────────────────────────────
                // No withTransaction wrapper: Vendure 3.6 / TypeORM 0.3 routes
                // TranslatableSaver writes through a context that does not join
                // the outer transaction manager, causing translation rows to be
                // written with null names (product) or not written at all (variant).
                // Direct service calls — the same pattern used by bulk-import.ts —
                // write translations correctly. Orphan detection above handles the
                // case where a partial CREATE from a previous run left a product
                // without variants.
                prodAction = 'created';
                Logger.verbose(
                    `  Creating product name="${productName}" MPN="${group.mpn}"`,
                    loggerCtx,
                );
                const created = await this.productService.create(ctx, {
                    translations: [{
                        languageCode: ctx.languageCode,
                        name:        productName,
                        slug,
                        description: group.oem?.description ?? group.products[0].description ?? '',
                        ...(productDetail ? { customFields: { detail: productDetail } } : {}),
                    }],
                    facetValueIds: combinedProductFvIds,
                    enabled: true,
                    ...(productAssetIds.length > 0 ? { featuredAssetId: productFeaturedAssetId, assetIds: productAssetIds } : {}),
                    // Canonical MPN key — primary lookup for this product on future syncs.
                    customFields: { mpn: group.mpn },
                });
                prodId = String(created.id);
                Logger.verbose(
                    `  Created product id=${prodId} name="${productName}" MPN="${group.mpn}"`,
                    loggerCtx,
                );

                if (needsOptionGroups) {
                    if (partTypeGroupId) {
                        await this.productService.addOptionGroupToProduct(ctx, Number(prodId), String(partTypeGroupId));
                    }
                }

                for (const pimProduct of validVariants) {
                    const assets = variantAssets.get(pimProduct.number!)!;
                    const dimensionWeightG = this.resolveDimensionWeightG(pimProduct.number!, attrValuesByProductId.get(pimProduct.id) ?? []);
                    try {
                        await this.upsertVariant(ctx, prodId, group.mpn, pimProduct, existingSkuMap, [...combinedProductFvIds, ...(variantAttrFvMap.get(pimProduct.number!) ?? [])], assets, needsOptionGroups, dimensionWeightG);
                        variantsCreatedCount++;
                    } catch (varErr: unknown) {
                        const msg = varErr instanceof Error ? varErr.message : String(varErr);
                        preValidationErrors.push({ sku: pimProduct.number!, error: msg });
                        Logger.error(
                            `  [Variant error] SKU ${pimProduct.number!} in MPN "${group.mpn}": ${msg}`,
                            loggerCtx,
                        );
                    }
                }
            }

            return {
                action:           prodAction,
                vendureProductId: prodId,
                variantErrors:    preValidationErrors.length,
                variantErrorDetails: preValidationErrors,
                variantsCreated: variantsCreatedCount,
                variantsUpdated: variantsUpdatedCount,
            };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            const stack   = err instanceof Error ? (err.stack ?? '') : '';
            Logger.error(
                `  MPN group "${group.mpn}" — write failed (${validVariants.length} variant(s)): ${message}` +
                (stack ? `\n${stack}` : ''),
                loggerCtx,
            );
            return {
                action: 'skipped',
                vendureProductId: null,
                variantErrors: preValidationErrors.length + 1,
                variantErrorDetails: [
                    ...preValidationErrors,
                    { sku: group.mpn, error: `Write failed: ${message}` },
                ],
                variantsCreated: variantsCreatedCount,
                variantsUpdated: variantsUpdatedCount,
            };
        }
    }

    /**
     * Pre-flight check for a single PIM product before any database write.
     * Returns null if the variant is safe to write, or a human-readable error
     * string describing precisely what data is missing or incompatible.
     */
    private validateVariant(pimProduct: PimProduct, effectiveMpn: string): string | null {
        const sku = pimProduct.number?.trim();
        if (!sku) {
            return 'No SKU — this product has no part number in the PIM';
        }

        // Name is mandatory in the PIM — a null/empty name is a failed API read,
        // not valid data. Reject and let the next sync re-attempt this variant.
        // Never substitute a placeholder: placeholders mask read failures and corrupt
        // the catalogue with data that did not originate from the PIM.
        if (!pimProduct.name?.trim()) {
            return (
                `PIM returned null/empty name for SKU ${sku} — this is a failed read. ` +
                `The variant will be re-synced automatically on the next sync run.`
            );
        }

        // optionIds compatibility: if the Part Standards option group is present in Vendure,
        // every variant must resolve to exactly one option value. Vendure's
        // validateVariantOptionIds() throws AFTER potentially mutating translation rows if we
        // reach it with invalid data. Pre-validating here prevents the service layer from
        // being called with incompatible combinations.
        //
        // effectiveMpn is group.mpn — for normal groups it equals pimProduct.mpn;
        // for singleton groups of unknown-suffix products it equals the SKU itself,
        // so deriveSuffix yields '' → OEM / ORIGINAL EQUIPMENT automatically.
        const suffix = sku.startsWith(effectiveMpn)
            ? (sku.slice(effectiveMpn.length).replace(/^-/, '') || '(none)')
            : '(unknown)';

        const partTypeGroupId = this.facetSyncService.getPartTypeGroupId();
        if (partTypeGroupId !== null) {
            const partTypeOptionId = this.facetSyncService.resolvePartTypeOptionId(sku, effectiveMpn);
            if (partTypeOptionId === null) {
                return (
                    `SKU suffix "${suffix}" has no Online Option value in Vendure. ` +
                    `Add suffix "${suffix}" to the Online Option (part-standards) group, then re-run the sync.`
                );
            }
        }

        return null;
    }

    private async upsertVariant(
        ctx: RequestContext,
        productId: string,
        effectiveMpn: string,
        pimProduct: PimProduct,
        existingSkuMap: Map<string, { id: string; productId: string; enabled: boolean }>,
        facetValueIds: string[],
        assets: { assetIds: string[]; featuredAssetId: string | undefined },
        useOptionGroups: boolean,
        dimensionWeightG: number | null,
    ): Promise<void> {
        const sku = pimProduct.number!; // guaranteed non-empty by validateVariant

        // Name is guaranteed non-null by validateVariant in Phase 1.
        // A null name here is an assertion failure, not a data condition to accommodate.
        const variantName = pimProduct.name!.trim();
        if (!variantName) {
            throw new Error(
                `BUG: variant ${sku} reached upsertVariant with null/empty name — ` +
                `this should have been caught by validateVariant in Phase 1`,
            );
        }

        const { assetIds, featuredAssetId } = assets;
        const existing = existingSkuMap.get(sku);

        if (existing) {
            // UPDATE: do NOT pass optionIds — options are assigned at CREATE time and are
            // immutable. Passing them triggers validateVariantOptionIds, which fails when
            // other variants share a combo. Name, facets, and assets are updated; options
            // are left as-is in Vendure.
            Logger.verbose(`  Updating variant sku=${sku} name="${variantName}"`, loggerCtx);
            await this.productVariantService.update(ctx, [{
                id: Number(existing.id),
                sku,
                // Only replace facet values when PIM provided category data — passing []
                // clears variant facet values.
                ...(facetValueIds.length > 0 ? { facetValueIds } : {}),
                assetIds,
                featuredAssetId,
                // When price/stock sync is on, the variant becomes stock-tracked so the
                // synced stock level is enforced. Otherwise leave tracking as-is.
                ...(this.priceStockSyncService.isEnabled() ? { trackInventory: GlobalFlag.TRUE } : {}),
                // Re-enable a variant PIM has reactivated — its SKU is in the current active
                // set by construction. No-op when already enabled.
                ...(existing.enabled ? {} : { enabled: true }),
                // Partial customFields patch — sets the logistics weight from PIM and leaves
                // every other variant custom field untouched. Omitted entirely when PIM has
                // no usable weight, so an existing value is never wiped.
                ...(dimensionWeightG !== null ? { customFields: { dimensionWeightG } } : {}),
                translations: [{ languageCode: ctx.languageCode, name: variantName }],
            }]);
            await this.priceStockSyncService.applyToVariant(ctx, {
                variantId: existing.id,
                sku,
                mpn: effectiveMpn,
                variantName,
                pimProduct,
                action: 'updated',
            });
        } else {
            // CREATE: only pass optionIds when the product has multiple variants and
            // option groups have been attached. Single-variant products have no option
            // groups, so passing optionIds would trigger "variant option incompatible".
            const optionIds = useOptionGroups ? this.resolveVariantOptionIds(sku, effectiveMpn) : [];
            Logger.verbose(
                `  Creating variant sku=${sku} name="${variantName}"` +
                `${useOptionGroups ? '' : ' (no option groups — single-variant product)'}`,
                loggerCtx,
            );
            const [created] = await this.productVariantService.create(ctx, [{
                productId,
                sku,
                ...(optionIds.length > 0 ? { optionIds } : {}),
                facetValueIds,
                assetIds,
                featuredAssetId,
                // Stock-tracked when price/stock sync is on (so synced stock is enforced),
                // otherwise untracked — preserving the catalogue-only default.
                trackInventory: this.priceStockSyncService.isEnabled() ? GlobalFlag.TRUE : GlobalFlag.FALSE,
                // Logistics weight from PIM; omitted when PIM has no usable weight.
                ...(dimensionWeightG !== null ? { customFields: { dimensionWeightG } } : {}),
                translations: [{ languageCode: ctx.languageCode, name: variantName }],
            }]);
            Logger.verbose(
                `  Created variant sku=${sku} id=${created.id} name="${variantName}"`,
                loggerCtx,
            );
            await this.priceStockSyncService.applyToVariant(ctx, {
                variantId: created.id,
                sku,
                mpn: effectiveMpn,
                variantName,
                pimProduct,
                action: 'created',
            });
        }
    }

    private async backfillExistingVariantOptions(
        ctx: RequestContext,
        effectiveMpn: string,
        allProductVariants: ProductVariant[],
    ): Promise<void> {
        for (const variant of allProductVariants) {
            const sku = variant.sku;
            if (!sku.startsWith(effectiveMpn)) {
                Logger.warn(
                    `  Skipping option backfill for existing variant sku=${sku}: ` +
                    `SKU does not start with MPN "${effectiveMpn}"`,
                    loggerCtx,
                );
                continue;
            }
            const optionIds = this.resolveVariantOptionIds(sku, effectiveMpn);
            if (optionIds.length === 0) continue;

            const currentOptionIds = (variant?.options ?? [])
                .map(o => Number(o.id))
                .sort((a, b) => a - b);
            const desiredOptionIds = [...optionIds].sort((a, b) => a - b);
            if (this.sameNumberArray(currentOptionIds, desiredOptionIds)) continue;

            Logger.verbose(
                `  Backfilling option IDs for existing variant sku=${sku}: ` +
                `[${currentOptionIds.join(',') || 'none'}] -> [${desiredOptionIds.join(',')}]`,
                loggerCtx,
            );
            await this.productVariantService.update(ctx, [{
                id: Number(variant.id),
                sku,
                optionIds: desiredOptionIds,
            }]);
        }
    }

    private resolveVariantOptionIds(sku: string, effectiveMpn: string): number[] {
        const id = this.facetSyncService.resolvePartTypeOptionId(sku, effectiveMpn);
        return id !== null ? [id] : [];
    }

    private sameNumberArray(a: number[], b: number[]): boolean {
        return a.length === b.length && a.every((value, index) => value === b[index]);
    }

    /** Flattens an attribute value to a list of scalar strings.
     *  Array-type attributes produce one entry per element (for model-fit filtering).
     *  Numeric attributes with a valueUnitName are formatted as "52 MM".
     *  Null, empty string, and empty arrays produce an empty list (value skipped). */
    private flattenAttrValue(av: PimAttributeValue): Array<string | number | boolean> {
        const { value, valueUnitName } = av;
        if (value === null || value === undefined || value === '') return [];
        if (Array.isArray(value)) {
            // Array-type attributes embed units in their string values already — don't append.
            return (value as unknown[])
                .filter((v): v is string | number | boolean =>
                    v !== null && v !== undefined && v !== '' && typeof v !== 'object',
                );
        }
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return [valueUnitName ? `${value} ${valueUnitName}` : value];
        }
        return [];
    }

    /** AtroPIM attribute code carrying the vendor-supplied gross weight.
     *  This is `WKG` (attribute name "Weight", type float) — NOT `weight` (name "Weight (Dim)",
     *  an unpopulated int dimensional field). `WKG` is the same attribute that feeds the
     *  "Weight" facet, confirmed against the live PIM.
     *
     *  IMPORTANT: the `WKG` code is NOT a unit declaration. The actual UOM varies per record
     *  (Kilogram / Kilogramme / Gram, etc.) and MUST be read from valueUnitName every time —
     *  never assume kilograms from the attribute name. */
    private static readonly WEIGHT_ATTRIBUTE_CODE = 'WKG';

    /** Base unit name of the PIM "Weight" measure. PIM pre-converts every weight value into
     *  this unit and exposes it under valueAllUnits[WEIGHT_BASE_UNIT] — read it directly so the
     *  conversion uses PIM's own multipliers, never a client-side assumption. */
    private static readonly WEIGHT_BASE_UNIT = 'Gram';

    /** Defensive fallback only. Multipliers from a PIM weight UOM to grams, keyed by the
     *  *normalised* valueUnitName (see normaliseWeightUnit). Used only when valueAllUnits is
     *  absent. An unlisted unit is treated as unknown and skipped, never guessed. */
    private static readonly WEIGHT_UOM_TO_GRAMS: Record<string, number> = {
        mg: 0.001, milligram: 0.001, milligramme: 0.001,
        g: 1, gram: 1, gramme: 1, gm: 1,
        kg: 1000, kilogram: 1000, kilogramme: 1000,
        t: 1_000_000, tonne: 1_000_000, ton: 1_000_000,
    };

    /** Normalises a PIM unit name for allow-list lookup: lowercase, trim, collapse internal
     *  whitespace, and drop a single trailing plural "s" (Kilograms → kilogram, Grams → gram).
     *  Returns '' when no unit is present. */
    private static normaliseWeightUnit(valueUnitName: string | null | undefined): string {
        const u = (valueUnitName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
        return u.endsWith('s') ? u.slice(0, -1) : u;
    }

    /** Reads the PIM gross-weight attribute for a variant and returns integer grams for
     *  ProductVariant.customFields.dimensionWeightG, or null when no usable weight is present.
     *  The weight value already flows into facet resolution; here it is converted for the
     *  logistics field.
     *
     *  UOM is never inferred from the attribute name/code. The primary path reads PIM's own
     *  conversion to the base unit (valueAllUnits["Gram"]); the fallback converts from
     *  valueUnitName via the allow-list. A missing/unrecognised unit with no base-unit value is
     *  an ambiguous read: warn and skip (never guess a unit and write a wrong weight). */
    private resolveDimensionWeightG(sku: string, attrValues: PimAttributeValue[]): number | null {
        for (const av of attrValues) {
            const def = this.facetSyncService.getAttributeDef(av.attributeId);
            if (def?.code !== ProductUpsertService.WEIGHT_ATTRIBUTE_CODE) continue;

            // Primary: use PIM's pre-converted base-unit (Gram) value — PIM applies its own
            // measure multipliers, so no client-side UOM assumption is made.
            const gramValue = av.valueAllUnits?.[ProductUpsertService.WEIGHT_BASE_UNIT];
            if (typeof gramValue === 'number' && Number.isFinite(gramValue) && gramValue > 0) {
                const grams = Math.round(gramValue);
                Logger.verbose(
                    `  SKU ${sku}: dimensionWeightG=${grams} ` +
                    `(from WKG valueAllUnits.${ProductUpsertService.WEIGHT_BASE_UNIT})`,
                    loggerCtx,
                );
                return grams;
            }

            // Fallback: convert from the reported unit via the allow-list (valueAllUnits absent).
            const raw = typeof av.value === 'number'
                ? av.value
                : typeof av.value === 'string' ? parseFloat(av.value) : NaN;
            if (!Number.isFinite(raw) || raw <= 0) return null;

            const unit = ProductUpsertService.normaliseWeightUnit(av.valueUnitName);
            const factor = unit ? ProductUpsertService.WEIGHT_UOM_TO_GRAMS[unit] : undefined;
            if (factor === undefined) {
                Logger.warn(
                    `  SKU ${sku}: WKG weight has no base-unit value and missing/unrecognised UOM ` +
                    `"${av.valueUnitName ?? '(none)'}" (value=${raw}) — skipping dimensionWeightG ` +
                    `(no assumption made). Add the unit to WEIGHT_UOM_TO_GRAMS if it is valid.`,
                    loggerCtx,
                );
                return null;
            }
            const grams = Math.round(raw * factor);
            Logger.verbose(
                `  SKU ${sku}: dimensionWeightG=${grams} (fallback from WKG=${raw} "${av.valueUnitName}")`,
                loggerCtx,
            );
            return grams;
        }
        return null;
    }

    /**
     * Resolves the Vendure Product id for an MPN via the `Product.customFields.mpn` key —
     * the canonical, stable link between a PIM MPN group and its Vendure Product.
     * Returns null when no product carries the MPN. If more than one does (a pre-existing
     * duplicate), the lowest id is chosen deterministically and a warning is logged so a
     * dedup pass can follow. Channel-scoped via ctx; service-layer only (no raw SQL).
     */
    private async findProductIdByMpn(ctx: RequestContext, mpn: string): Promise<string | null> {
        const trimmed = mpn.trim();
        if (!trimmed) return null;
        const result = await this.productService.findAll(ctx, {
            // Custom-field filters are resolved by ListQueryBuilder using the plain field
            // name, but the generated FilterParameter type only covers primitive columns —
            // hence the scoped cast (not `as any`).
            filter: { mpn: { eq: trimmed } } as NonNullable<ListQueryOptions<Product>['filter']>,
            take: 2,
        });
        if (result.items.length === 0) return null;
        if (result.totalItems > 1) {
            Logger.warn(
                `  [MPN] More than one Vendure product carries mpn="${trimmed}" ` +
                `(ids: ${result.items.map(p => String(p.id)).join(', ')}). Using the lowest id — ` +
                `run consolidate-duplicate-products.ts to dedup.`,
                loggerCtx,
            );
        }
        const lowestId = result.items.map(p => Number(p.id)).sort((a, b) => a - b)[0];
        return String(lowestId);
    }

    private toSlug(text: string): string {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
    }

    private buildProductSlugSource(mpn: string, productName: string, pimProduct: PimProduct): string {
        return [
            mpn,
            productName,
            pimProduct.details ?? '',
        ].filter(part => part.trim()).join(' ');
    }

    private async uniqueSlug(ctx: RequestContext, text: string, currentProductId?: string | null): Promise<string> {
        const base = this.toSlug(text) || this.toSlug(currentProductId ? `product-${currentProductId}` : 'product');
        const existing = await this.productService.findOneBySlug(ctx, base);
        if (!existing || (currentProductId && String(existing.id) === currentProductId)) return base;
        for (let i = 2; i < 999; i++) {
            const candidate = `${base}-${i}`;
            const existingCandidate = await this.productService.findOneBySlug(ctx, candidate);
            if (!existingCandidate || (currentProductId && String(existingCandidate.id) === currentProductId)) {
                return candidate;
            }
        }
        return `${base}-${Date.now()}`;
    }
}
