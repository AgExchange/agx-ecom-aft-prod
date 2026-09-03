import { Inject, Injectable } from '@nestjs/common';
import {
    ChannelService,
    Facet,
    FacetService,
    FacetValue,
    FacetValueService,
    LanguageCode,
    Logger,
    ProductOptionGroupService,
    ProductOptionService,
    RequestContext,
} from '@vendure/core';
import { PIM_SYNC_OPTIONS, loggerCtx, SUFFIX_TO_PART_STANDARD } from '../constants';
import { PimAttributeDef, PimSyncOptions } from '../types';

@Injectable()
export class FacetSyncService {
    private classificationFvMap = new Map<string, number>();
    private collectionIdFvMap = new Map<string, number>();  // collection code → FacetValue ID
    private partTypeGroupId: number | null = null;
    private partTypeOptionMap = new Map<string, number>();

    // Attribute → Facet sync caches (reset each sync run)
    private attrDefMap        = new Map<string, PimAttributeDef>(); // attrId → PimAttributeDef (channel-filtered)
    private attributeFacetMap = new Map<string, number>();          // PIM attrCode → Vendure facetId
    private attributeFvMap    = new Map<string, string>();          // `${attrCode}:${displayName}` → fvId
    private loadedAttrFacets  = new Set<string>();                  // attrCodes where findByFacetId was called
    // facetCodes already confirmed channel-assigned this run (avoids redundant assignToChannels calls)
    private channelAssignedFacetCodes = new Set<string>();

    constructor(
        @Inject(PIM_SYNC_OPTIONS) private options: PimSyncOptions,
        private facetService: FacetService,
        private facetValueService: FacetValueService,
        private productOptionGroupService: ProductOptionGroupService,
        private productOptionService: ProductOptionService,
        private channelService: ChannelService,
    ) {}

    /**
     * `FacetService.findByCode` / `FacetValueService.findByFacetId` are BOTH channel-unaware
     * (plain `WHERE code = ...` / `WHERE facet.id = ...`, no channel join — confirmed by
     * reading @vendure/core's compiled source). So reusing a Facet/FacetValue that was
     * originally created under a DIFFERENT channel (e.g. an attr-* facet first created while
     * syncing LBP-Online, then found-and-reused while syncing a brand-new channel like AFT)
     * finds it fine, but never assigns it to the current channel.
     *
     * `ProductService.update`'s facetValueIds handling IS channel-scoped
     * (`facetValueService.findByIds` → `connection.findByIdsInChannel(ctx, ..., ctx.channelId)`),
     * so any facetValueId not assigned to the current channel is silently dropped — no error,
     * no log line, the product just ends up with 0 attribute/classification/collection-id
     * facets for that channel even though this service "resolved" them successfully.
     *
     * Fix: whenever a pre-existing Facet is found (not created — newly created ones already
     * self-assign to ctx.channelId via FacetService.create/FacetValueService.create), explicitly
     * assign the Facet and all of its already-loaded FacetValues to the current channel.
     * `channelService.assignToChannels` is idempotent (no-op if already assigned), and we also
     * cache per facetCode+run to avoid repeat calls when a facet is resolved many times per sync.
     */
    private async ensureChannelAssigned(ctx: RequestContext, facet: Facet): Promise<void> {
        if (this.channelAssignedFacetCodes.has(facet.code)) return;
        this.channelAssignedFacetCodes.add(facet.code);
        await this.channelService.assignToChannels(ctx, Facet, facet.id, [ctx.channelId]);
        for (const fv of facet.values ?? []) {
            await this.channelService.assignToChannels(ctx, FacetValue, fv.id, [ctx.channelId]);
        }
    }

    /** Call once at the start of each sync run. */
    async loadLookups(ctx: RequestContext, attributeDefMap: Map<string, PimAttributeDef>): Promise<void> {
        // Reset per-run: this service is a singleton, and a facetCode being "already
        // channel-assigned" from a PREVIOUS run (a different channel) must not suppress
        // the assignment check for the channel syncing THIS run.
        this.channelAssignedFacetCodes.clear();
        await this.loadFacetValueMaps(ctx);
        await this.loadCollectionIdFacet(ctx);
        await this.loadPartTypeGroup(ctx);
        this.loadAttributeLookups(attributeDefMap);
    }

    private loadAttributeLookups(attributeDefMap: Map<string, PimAttributeDef>): void {
        this.attrDefMap = attributeDefMap;
        this.attributeFacetMap.clear();
        this.attributeFvMap.clear();
        this.loadedAttrFacets.clear();
        if (attributeDefMap.size === 0) {
            Logger.warn(
                `  Attribute sync: 0 attribute definitions loaded from PIM — no attr-* facets will be created. ` +
                `Check that the PIM channel has active attributes assigned (channelId match or global attributes).`,
                loggerCtx,
            );
        } else {
            Logger.info(`  Attribute sync: ${attributeDefMap.size} attribute definition(s) loaded from PIM`, loggerCtx);
        }
    }

    /** Returns the PimAttributeDef for the given PIM attribute UUID, or undefined if not in scope. */
    getAttributeDef(attributeId: string): PimAttributeDef | undefined {
        return this.attrDefMap.get(attributeId);
    }

    /** Returns the number of attribute definitions currently loaded (for diagnostics). */
    getAttrDefCount(): number {
        return this.attrDefMap.size;
    }

    private async loadFacetValueMaps(ctx: RequestContext): Promise<void> {
        this.classificationFvMap.clear();

        const classificationFacet = await this.facetService.findByCode(ctx, 'classification', LanguageCode.en);
        if (!classificationFacet) {
            Logger.warn('  "classification" facet not found — classification facet value assignment disabled', loggerCtx);
            return;
        }
        await this.ensureChannelAssigned(ctx, classificationFacet);

        const values = await this.facetValueService.findByFacetId(ctx, classificationFacet.id);
        for (const fv of values) {
            this.classificationFvMap.set(fv.name, Number(fv.id));
        }

        Logger.verbose(`  Loaded ${this.classificationFvMap.size} classification facet values`, loggerCtx);
    }

    private async loadCollectionIdFacet(ctx: RequestContext): Promise<void> {
        this.collectionIdFvMap.clear();
        const facet = await this.facetService.findByCode(ctx, 'collection-id', LanguageCode.en);
        if (!facet) {
            Logger.warn('  "collection-id" facet not found — CollectionsID facet value assignment disabled', loggerCtx);
            return;
        }
        await this.ensureChannelAssigned(ctx, facet);
        const values = await this.facetValueService.findByFacetId(ctx, facet.id);
        for (const fv of values) {
            // Cache by name (same key ensureFacetValue uses) to prevent duplicates when
            // FacetValues were pre-created manually in the Admin UI.
            this.collectionIdFvMap.set(fv.name, Number(fv.id));
        }
        Logger.verbose(`  Loaded ${this.collectionIdFvMap.size} collection-id facet values`, loggerCtx);
    }

    private async loadPartTypeGroup(ctx: RequestContext): Promise<void> {
        this.partTypeGroupId = null;
        this.partTypeOptionMap.clear();

        const partTypeCode = this.options.partTypeGroupCode ?? 'part-standards';

        // Step 1 — filter by code using the service-layer list query
        const listResult = await this.productOptionGroupService.findAll(ctx, {
            filter: { code: { eq: partTypeCode } },
            take: 1,
        });
        const summary = listResult.items[0];
        if (!summary) {
            Logger.warn(
                `  Part Standards option group "${partTypeCode}" not found in Vendure — Part Type will not be assigned`,
                loggerCtx,
            );
            return;
        }

        // Step 2 — load full translated entity; pass explicit relations so
        // option translations are in the result and option.name is resolved.
        // The default ['options'] omits options.translations, leaving option.name
        // as an empty LocaleString and the map empty despite the group being found.
        const group = await this.productOptionGroupService.findOne(
            ctx, summary.id, ['options', 'options.translations'],
        );
        if (!group) return;

        this.partTypeGroupId = Number(group.id);
        // ProductOptionGroup.options: ProductOption[]; LocaleString ⊆ string.
        // Fall back to option.code if name is somehow still empty after translation.
        for (const option of group.options ?? []) {
            const optionName: string = option.name || option.code;
            this.partTypeOptionMap.set(optionName.toUpperCase(), Number(option.id));
        }

        // info-level so the operator can confirm options loaded without verbose logging
        Logger.info(
            `  Part Standards group "${partTypeCode}" id=${this.partTypeGroupId}: ${[...this.partTypeOptionMap.keys()].join(', ') || '(no options found!)'}`,
            loggerCtx,
        );
    }

    /** Returns the Part Standards option group ID (or null if not found). */
    getPartTypeGroupId(): number | null {
        return this.partTypeGroupId;
    }

    /**
     * Derives the SKU suffix and returns the matching Part Standard option value ID.
     * Returns null if the suffix is not in SUFFIX_TO_PART_STANDARD or the option
     * value does not exist in Vendure.
     */
    resolvePartTypeOptionId(sku: string, mpn: string): number | null {
        const suffix = this.deriveSuffix(sku, mpn);
        const partStandardName = SUFFIX_TO_PART_STANDARD[suffix] ?? null;
        if (!partStandardName) {
            Logger.warn(`No Part Standard mapping for suffix="${suffix}" (SKU=${sku})`, loggerCtx);
            return null;
        }
        const id = this.partTypeOptionMap.get(partStandardName) ?? null;
        if (!id) {
            Logger.warn(`No Part Standard option value "${partStandardName}" in Vendure (SKU=${sku})`, loggerCtx);
        }
        return id;
    }

    private deriveSuffix(sku: string, mpn: string): string {
        if (sku.startsWith(mpn)) {
            return sku.slice(mpn.length).replace(/^-/, '').toUpperCase();
        }
        return '';
    }

    /**
     * Resolves (and creates if absent) the Vendure facet value ID for a classification name.
     * Classification name is derived from the AtroPIM category entity's own routesNames
     * (L1 ancestor: routesNames[0][1]?.name ?? category.name).
     * Returns null if the 'classification' facet does not exist in Vendure.
     */
    async resolveClassificationFacetValueId(ctx: RequestContext, classificationName: string): Promise<number | null> {
        return this.ensureFacetValue(ctx, 'classification', classificationName, this.classificationFvMap);
    }

    /**
     * Resolves (and creates if absent) Vendure FacetValue IDs for a list of collection codes
     * under the 'collection-id' facet. Each code (e.g. "529") becomes a FacetValue whose
     * code and name are both the collection ID string.
     * Returns [] if the 'collection-id' facet does not exist in Vendure.
     */
    async resolveCollectionIdFacetValueIds(ctx: RequestContext, collectionCodes: string[]): Promise<number[]> {
        const ids: number[] = [];
        for (const code of collectionCodes) {
            const id = await this.ensureFacetValue(ctx, 'collection-id', code, this.collectionIdFvMap);
            if (id !== null) ids.push(id);
        }
        return ids;
    }

    private async ensureFacetValue(
        ctx: RequestContext,
        facetCode: string,
        valueName: string,
        cache: Map<string, number>,
    ): Promise<number | null> {
        const cached = cache.get(valueName);
        if (cached !== undefined) return cached;

        const facet = await this.facetService.findByCode(ctx, facetCode, LanguageCode.en);
        if (!facet) {
            Logger.warn(`Facet "${facetCode}" not found in Vendure — cannot assign facet value`, loggerCtx);
            return null;
        }
        await this.ensureChannelAssigned(ctx, facet);

        Logger.info(`Creating new facet value: ${facetCode}="${valueName}"`, loggerCtx);
        const fv = await this.facetValueService.create(ctx, facet, {
            code: valueName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            translations: [{ languageCode: LanguageCode.en, name: valueName }],
        });
        cache.set(valueName, Number(fv.id));
        return Number(fv.id);
    }

    // ─── Attribute → Facet sync ───────────────────────────────────────────────

    /**
     * Resolves (and creates if absent) a Vendure FacetValue for the given PIM attribute
     * and its value. Each PIM Attribute maps to a Vendure Facet (code: `attr-{attrCode}`).
     * Each unique attribute value maps to a FacetValue under that facet.
     * Returns the FacetValue ID as a string, or null if the value is empty/unsupported.
     */
    async resolveAttributeFacetValueId(
        ctx: RequestContext,
        attrCode: string,
        attrName: string,
        rawValue: string | number | boolean,
    ): Promise<string | null> {
        const displayName = this.normalizeAttrValue(rawValue);
        if (!displayName) {
            Logger.verbose(
                `  Attribute "${attrCode}": value ${JSON.stringify(rawValue)} normalised to null/empty — skipping`,
                loggerCtx,
            );
            return null;
        }

        const cacheKey = `${attrCode}:${displayName}`;
        const cached = this.attributeFvMap.get(cacheKey);
        if (cached !== undefined) {
            Logger.verbose(`  Attribute "${attrCode}" value "${displayName}": cache hit fvId=${cached}`, loggerCtx);
            return cached;
        }

        // Ensure the Vendure facet for this attribute exists
        const facetId = await this.ensureAttributeFacet(ctx, attrCode, attrName);
        if (facetId === null) return null;

        // Load all existing values for this facet once per attribute per sync run
        if (!this.loadedAttrFacets.has(attrCode)) {
            this.loadedAttrFacets.add(attrCode);
            const existingValues = await this.facetValueService.findByFacetId(ctx, facetId);
            Logger.verbose(
                `  Attribute "${attrCode}": loaded ${existingValues.length} existing FacetValue(s) from Vendure`,
                loggerCtx,
            );
            for (const fv of existingValues) {
                this.attributeFvMap.set(`${attrCode}:${fv.name}`, String(fv.id));
            }
            const recached = this.attributeFvMap.get(cacheKey);
            if (recached !== undefined) {
                Logger.verbose(`  Attribute "${attrCode}" value "${displayName}": found in existing values, fvId=${recached}`, loggerCtx);
                return recached;
            }
        }

        // Genuinely new value — create it
        const attrFacetCode = `attr-${this.slugify(attrCode)}`;
        const facet = await this.facetService.findByCode(ctx, attrFacetCode, ctx.languageCode);
        if (!facet) {
            Logger.error(
                `  Attribute "${attrCode}": facet "${attrFacetCode}" not found after ensureAttributeFacet — this is a bug`,
                loggerCtx,
            );
            return null;
        }

        const fvCode = `attr-${this.slugify(attrCode)}-${this.slugify(displayName)}`;
        const fv = await this.facetValueService.create(ctx, facet, {
            code: fvCode,
            translations: [{ languageCode: ctx.languageCode, name: displayName }],
        });
        this.attributeFvMap.set(cacheKey, String(fv.id));
        Logger.info(`Created attribute facet value: ${fvCode} ("${displayName}") fvId=${fv.id}`, loggerCtx);
        return String(fv.id);
    }

    private async ensureAttributeFacet(
        ctx: RequestContext,
        attrCode: string,
        attrName: string,
    ): Promise<number | null> {
        const cached = this.attributeFacetMap.get(attrCode);
        if (cached !== undefined) {
            Logger.verbose(`  ensureAttributeFacet "${attrCode}": cache hit facetId=${cached}`, loggerCtx);
            return cached;
        }

        const attrFacetCode = `attr-${this.slugify(attrCode)}`;
        let facet = await this.facetService.findByCode(ctx, attrFacetCode, ctx.languageCode);
        if (!facet) {
            Logger.info(`Creating attribute facet: ${attrFacetCode} ("${attrName}")`, loggerCtx);
            facet = await this.facetService.create(ctx, {
                code: attrFacetCode,
                isPrivate: false,
                translations: [{ languageCode: ctx.languageCode, name: attrName }],
            });
            Logger.info(`Created attribute facet: ${attrFacetCode} ("${attrName}") facetId=${facet.id}`, loggerCtx);
        } else {
            Logger.verbose(`  ensureAttributeFacet "${attrCode}": found existing facet id=${facet.id}`, loggerCtx);
            // Facet may have been created while syncing a DIFFERENT channel — findByCode is
            // channel-unaware, so being "found" here doesn't mean it's assigned to ctx.channelId.
            await this.ensureChannelAssigned(ctx, facet);
        }
        const facetId = Number(facet.id);
        this.attributeFacetMap.set(attrCode, facetId);
        return facetId;
    }

    private slugify(text: string): string {
        return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    private normalizeAttrValue(raw: string | number | boolean): string | null {
        if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
        const str = String(raw).trim();
        if (!str) return null;
        // Truncate values longer than 200 chars to avoid DB column overflow
        if (str.length > 200) {
            Logger.warn(`Attribute value truncated from ${str.length} to 200 chars: "${str.slice(0, 40)}..."`, loggerCtx);
            return str.slice(0, 200);
        }
        return str;
    }
}
