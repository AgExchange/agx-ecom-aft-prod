import { Inject, Injectable } from '@nestjs/common';
import { Logger } from '@vendure/core';
import { PIM_SYNC_OPTIONS, loggerCtx } from '../constants';
import { PimApiListResponse, PimAttributeDef, PimAttributeValue, PimCategory, PimProduct, PimProductFile, PimRouteNode, PimSyncOptions } from '../types';

@Injectable()
export class PimApiService {
    private token: string | null = null;
    private attrValueCache = new Map<string, PimAttributeValue[]>();
    private productFileCache = new Map<string, PimProductFile[]>();

    constructor(@Inject(PIM_SYNC_OPTIONS) private options: PimSyncOptions) {}

    private get baseUrl() {
        return this.options.pimUrl.replace(/\/$/, '');
    }

    private get apiBase() {
        return `${this.baseUrl}/api`;
    }

    private get authHeader(): Record<string, string> {
        if (!this.token) throw new Error('PIM not authenticated — call authenticate() first');
        return { Authorization: `Basic ${this.token}` };
    }

    /**
     * Reads the response body as text, then parses JSON.
     * If the body is not valid JSON the raw text (truncated) is included in the error
     * so the actual PIM error message reaches the operator instead of a cryptic parse failure.
     */
    private async parseJson<T>(res: Response): Promise<T> {
        const text = await res.text();
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new Error(
                `PIM returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`,
            );
        }
    }

    /** Wraps fetch() with an AbortController timeout to prevent hanging indefinitely. */
    private async fetchWithTimeout(
        url: string,
        init: RequestInit = {},
        timeoutMs?: number,
    ): Promise<Response> {
        const ms = timeoutMs ?? this.options.fetchTimeoutMs ?? 30_000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        try {
            return await fetch(url, { ...init, signal: controller.signal });
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') {
                throw new Error(`PIM request timed out after ${ms}ms: ${url}`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    async authenticate(): Promise<void> {
        const cred = Buffer.from(`${this.options.pimUser}:${this.options.pimPassword}`).toString('base64');
        const res = await this.fetchWithTimeout(`${this.apiBase}/userSession`, {
            headers: {
                Authorization: `Basic ${cred}`,
                'Authorization-Token-Only': 'true',
                'Authorization-Token-Lifetime': '0',
                'Authorization-Token-Idletime': '0',
            },
        });
        if (!res.ok) {
            const hint = res.status === 401
                ? ' — check PIM_USER and PIM_PASSWORD in the server .env file'
                : '';
            throw new Error(`PIM authentication failed (HTTP ${res.status})${hint}`);
        }
        const data = await this.parseJson<{ authorizationToken?: string }>(res);
        if (!data.authorizationToken) throw new Error('PIM auth: missing authorizationToken in response');
        this.token = data.authorizationToken;
        Logger.verbose('PIM authenticated', loggerCtx);
    }

    /**
     * Fetches all AtroPIM categories and returns a Map keyed by category code
     * (= Vendure Collection ID). The Category endpoint ignores WHERE filters, so
     * all categories are fetched and inactive ones are skipped client-side via the
     * isActive field included in the select.
     *
     * Channel scoping is intentionally omitted — active products are already
     * channel-scoped, so any categoriesIds they carry are from the right channel.
     * Extra categories in the map are unused lookup entries and are harmless.
     *
     * Map value: AtroPIM UUID, display name, and classification name derived from
     * the category's own routesNames:
     *   routesNames[0][1]?.name ?? category.name   (L1 ancestor, or own name for L1 nodes)
     */
    async fetchAllCategoryMappings(channelId: string): Promise<Map<string, { uuid: string; name: string; classificationName: string }>> {
        const map = new Map<string, { uuid: string; name: string; classificationName: string }>();
        const pageSize = 500;
        let offset = 0;

        // Confirmed working WHERE format: JSON array containing a JSON-encoded condition string.
        const condition = {
            type: 'and',
            value: [
                { type: 'equals', attribute: 'isActive', value: true },
                { type: 'linkedWith', attribute: 'channels', value: channelId },
            ],
        };

        while (true) {
            const url = new URL(`${this.apiBase}/Category`);
            url.searchParams.set('maxSize', String(pageSize));
            url.searchParams.set('offset', String(offset));
            url.searchParams.set('select', 'id,code,name,routesNames');
            url.searchParams.set('where', JSON.stringify([JSON.stringify(condition)]));

            const res = await this.fetchWithTimeout(url.toString(), { headers: this.authHeader });
            if (!res.ok) throw new Error(`PIM category list failed (HTTP ${res.status})`);

            const data = await this.parseJson<PimApiListResponse<PimCategory>>(res);
            for (const cat of data.list) {
                if (!cat.code) continue;
                const routes: PimRouteNode[][] = Array.isArray(cat.routesNames)
                    ? cat.routesNames
                    : Object.values(cat.routesNames as unknown as Record<string, PimRouteNode[]>);
                const classificationName = routes[0]?.[1]?.name ?? cat.name;
                map.set(cat.code, { uuid: cat.id, name: cat.name, classificationName });
            }

            Logger.verbose(
                `  PIM categories page offset=${offset}: ${data.list.length} fetched, ${map.size} active with code so far (total=${data.total})`,
                loggerCtx,
            );
            offset += pageSize;
            if (data.list.length < pageSize || offset >= (data.total ?? Infinity)) break;
        }

        Logger.info(`  Loaded ${map.size} active category mappings`, loggerCtx);
        return map;
    }

    /**
     * Fetches all active, ready products assigned to an AtroPIM category (by UUID).
     * Uses the Category products sub-resource with collectionOnly=true so only directly
     * assigned products are returned (not inherited from child categories).
     */
    async fetchProductsByCategory(categoryUuid: string, pimLocale: string | null): Promise<PimProduct[]> {
        const all: PimProduct[] = [];
        const pageSize = this.options.pageSize ?? 200;
        let offset = 0;

        const where = JSON.stringify([JSON.stringify({
            type: 'and',
            value: [
                { type: 'equals', attribute: 'isActive', value: true },
                { type: 'equals', attribute: 'status', value: 'ready' },
            ],
        })]);

        while (true) {
            const url = new URL(`${this.apiBase}/Category/${categoryUuid}/products`);
            url.searchParams.set('maxSize', String(pageSize));
            url.searchParams.set('offset', String(offset));
            url.searchParams.set('collectionOnly', 'true');
            url.searchParams.set('sortBy', 'product_category_mm.sorting');
            url.searchParams.set('asc', 'true');
            url.searchParams.set('where', where);
            if (pimLocale) {
                url.searchParams.set('language', pimLocale);
            }

            const res = await this.fetchWithTimeout(url.toString(), { headers: this.authHeader });
            if (!res.ok) {
                throw new Error(
                    `PIM category products fetch failed (HTTP ${res.status}) for category ${categoryUuid}`,
                );
            }

            const data = await this.parseJson<PimApiListResponse<PimProduct>>(res);
            const sellable = data.list.filter(p => p.number != null && p.number !== '');
            const skipped = data.list.length - sellable.length;
            all.push(...sellable);

            Logger.verbose(
                `  PIM category ${categoryUuid} offset=${offset}: ${data.list.length} returned, ` +
                `${sellable.length} sellable, ${skipped} skipped. Running total: ${all.length}/${data.total ?? '?'}`,
                loggerCtx,
            );
            offset += pageSize;
            if (data.list.length < pageSize || offset >= (data.total ?? Infinity)) break;
        }

        return all;
    }

    /**
     * Resolves the PIM channel ID and locale by code (= Vendure channel token).
     * AtroPIM channels may carry locale codes like "en_ZA" or "af_ZA".  The
     * locale is returned raw so callers can normalise it and compare against
     * the Vendure channel's defaultLanguageCode.
     */
    async resolvePimChannelId(channelToken: string): Promise<{ channelId: string; pimLocale: string | null }> {
        const url = new URL(`${this.apiBase}/Channel`);
        url.searchParams.set('maxSize', '1');
        url.searchParams.set('where[0][type]', 'equals');
        url.searchParams.set('where[0][attribute]', 'code');
        url.searchParams.set('where[0][value]', channelToken);

        const res = await this.fetchWithTimeout(url.toString(), { headers: this.authHeader });
        if (!res.ok) throw new Error(`PIM channel lookup failed: ${res.status}`);

        const data = await this.parseJson<PimApiListResponse<Record<string, unknown>>>(res);
        if (!data.list.length) {
            throw new Error(`PIM channel with code "${channelToken}" not found`);
        }
        const ch = data.list[0];
        const channelId = ch['id'] as string;
        // AtroPIM may expose the locale in different fields depending on version.
        // Try common field names; fall back to null if none are present.
        const pimLocale =
            (Array.isArray(ch['locales']) ? (ch['locales'] as string[])[0] : null)
            ?? (typeof ch['locale'] === 'string' ? ch['locale'] as string : null)
            ?? (typeof ch['language'] === 'string' ? ch['language'] as string : null)
            ?? null;
        Logger.verbose(
            `  PIM channel: ${ch['name']} (id=${channelId}, locale=${pimLocale ?? 'not set'})`,
            loggerCtx,
        );
        return { channelId, pimLocale };
    }

    /**
     * Fetches all active, ready PIM products for the given channel, paginated.
     *
     * Channel scoping is enforced server-side via two disjoint queries, unioned
     * client-side by product id:
     *   1. Products with an *explicit* product→channel link ('linkedWith channels').
     *      Some channels (e.g. a brand-new channel with no category tree assigned
     *      yet) place every product here — confirmed live: a channel with 0 linked
     *      categories had all 21 of its products reachable only through this link.
     *   2. Products belonging to a category that is itself linked to this channel
     *      ('linkedWith categories', value = array of category ids). AtroPIM/EspoCRM's
     *      linkedWith accepts an array for OR-match, confirmed live. Category ids are
     *      resolved once via fetchAllCategoryMappings (already channel-scoped
     *      server-side) and chunked to stay under the URL length AtroPIM accepts —
     *      confirmed live: a query with all 311 ids for one channel returned
     *      HTTP 414, chunks of 100 succeeded.
     *
     * Neither query alone is sufficient — some channels rely only on (1), others
     * (e.g. the largest, LBP Online, with 311 linked categories) rely heavily on (2).
     * Prior to this, the whole active+ready catalogue (thousands of products, unrelated
     * to this channel) was fetched and filtered client-side, which was both wasteful
     * and silently returned zero results for channels that only use (1).
     *
     * channelId and pimLocale are resolved once by the caller (resolvePimChannelId).
     */
    /**
     * AtroPIM uses 'YYYY-MM-DD HH:mm:ss' for datetime values in WHERE clauses,
     * not ISO 8601. Convert before sending.
     */
    private toAtroDateTime(iso: string): string {
        return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    }

    private chunk<T>(arr: T[], size: number): T[][] {
        const out: T[][] = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    }

    /**
     * Runs one paginated Product query for the given extra WHERE clause (already
     * scoped to a channel via linkedWith), applying the shared isActive/ready/delta
     * filters, and merges sellable results into `into` (deduped by id).
     */
    private async fetchProductsWhere(
        extraCondition: Record<string, unknown>,
        baseFilters: Record<string, unknown>[],
        pimLocale: string | null,
        into: Map<string, PimProduct>,
        sourceLabel: string,
    ): Promise<void> {
        const pageSize = this.options.pageSize ?? 200;
        let offset = 0;
        const whereCondition = { type: 'and', value: [...baseFilters, extraCondition] };

        while (true) {
            const url = new URL(`${this.apiBase}/Product`);
            url.searchParams.set('maxSize', String(pageSize));
            url.searchParams.set('offset', String(offset));
            url.searchParams.set('select', 'id,name,number,mpn,isActive,description,longDescription,details,price,rrp,rrpUnitName,rrpAllUnits,quantity,mainImageId,mainImageName,modifiedAt,categories,variantSpecificAttributesIds');
            url.searchParams.set('where', JSON.stringify([JSON.stringify(whereCondition)]));
            if (pimLocale) url.searchParams.set('language', pimLocale);

            const res = await this.fetchWithTimeout(url.toString(), { headers: this.authHeader });
            if (!res.ok) throw new Error(`PIM product fetch failed (${sourceLabel}): ${res.status}`);

            const data = await this.parseJson<PimApiListResponse<PimProduct>>(res);
            const sellable = data.list.filter(p => p.number != null && p.number !== '');
            const noSku = data.list.filter(p => p.number == null || p.number === '');
            Logger.info(
                `  PIM GET (${sourceLabel}, offset=${offset}): ${data.list.length} records (total=${data.total ?? '?'}), ` +
                `sellable=${sellable.length}, no-SKU=${noSku.length}. Union so far: ${into.size}`,
                loggerCtx,
            );
            for (const p of sellable) into.set(p.id, p);
            for (const p of noSku) {
                Logger.warn(`  PIM product skipped (no SKU): id=${p.id} name="${p.name ?? '(null)'}"`, loggerCtx);
            }

            offset += pageSize;
            if (data.list.length < pageSize || offset >= (data.total ?? Infinity)) break;
        }
    }

    async fetchActiveProducts(channelId: string, pimLocale: string | null, sinceDate?: string): Promise<PimProduct[]> {
        // Delta sync: add modifiedAt >= sinceDate to narrow the fetch.
        // greaterThanOrEquals is the confirmed AtroPIM/EspoCRM operator for datetime comparisons.
        const baseFilters: Record<string, unknown>[] = [
            { type: 'equals', attribute: 'isActive', value: true },
            { type: 'equals', attribute: 'status', value: 'ready' },
            ...(sinceDate
                ? [{ type: 'greaterThanOrEquals', attribute: 'modifiedAt', value: this.toAtroDateTime(sinceDate) }]
                : []),
        ];

        if (sinceDate) {
            Logger.info(`  PIM delta filter: modifiedAt >= ${this.toAtroDateTime(sinceDate)}`, loggerCtx);
        }

        const productsById = new Map<string, PimProduct>();

        // Path 1: products explicitly linked to this channel.
        await this.fetchProductsWhere(
            { type: 'linkedWith', attribute: 'channels', value: channelId },
            baseFilters,
            pimLocale,
            productsById,
            'direct channel link',
        );

        // Path 2: products in a category that is itself linked to this channel.
        const categoryMap = await this.fetchAllCategoryMappings(channelId);
        const categoryIds = [...categoryMap.values()].map(v => v.uuid);
        const CATEGORY_CHUNK_SIZE = 100; // confirmed live: 100 ids OK, 311 ids → HTTP 414
        for (const idsChunk of this.chunk(categoryIds, CATEGORY_CHUNK_SIZE)) {
            await this.fetchProductsWhere(
                { type: 'linkedWith', attribute: 'categories', value: idsChunk },
                baseFilters,
                pimLocale,
                productsById,
                `category link (${idsChunk.length} categories)`,
            );
        }

        const channelProducts = [...productsById.values()];
        Logger.info(
            `  Channel scope (channelId=${channelId}): ${channelProducts.length} product(s) ` +
            `via direct link + ${categoryIds.length} linked categor(y/ies)`,
            loggerCtx,
        );

        return channelProducts;
    }

    /**
     * Fetches all active AtroPIM Attribute definitions for the given channel.
     * Returns a Map keyed by attribute UUID.
     * Attributes with no channelsIds (global) are included for all channels.
     */
    async fetchAllAttributeDefinitions(channelId: string): Promise<Map<string, PimAttributeDef>> {
        const map = new Map<string, PimAttributeDef>();
        const pageSize = 500;
        let offset = 0;

        while (true) {
            const url = new URL(`${this.apiBase}/Attribute`);
            url.searchParams.set('maxSize', String(pageSize));
            url.searchParams.set('offset', String(offset));
            url.searchParams.set('select', 'id,code,name,type,channelId');
            // No isActive filter — Attribute entity has no isActive field per schema.
            // All returned attributes are considered active by the PIM.

            const res = await this.fetchWithTimeout(url.toString(), { headers: this.authHeader });
            if (!res.ok) throw new Error(`PIM attribute list failed (HTTP ${res.status})`);

            const data = await this.parseJson<PimApiListResponse<PimAttributeDef>>(res);
            let pageIncluded = 0;
            for (const attr of data.list) {
                if (!attr.code) {
                    Logger.verbose(`  PIM attribute id=${attr.id} has no code — skipping`, loggerCtx);
                    continue;
                }
                // channelId null/absent = global attribute; channelId set = channel-specific
                const isGlobal = !attr.channelId;
                if (isGlobal || attr.channelId === channelId) {
                    map.set(attr.id, attr);
                    pageIncluded++;
                } else {
                    Logger.verbose(
                        `  PIM attribute "${attr.code}" (id=${attr.id}) skipped: channelId="${attr.channelId}" ≠ "${channelId}"`,
                        loggerCtx,
                    );
                }
            }

            Logger.verbose(
                `  PIM attributes page offset=${offset}: ${data.list.length} fetched, ${pageIncluded} included for channel, ${map.size} total so far (total=${data.total ?? '?'})`,
                loggerCtx,
            );
            offset += pageSize;
            if (data.list.length < pageSize || offset >= (data.total ?? Infinity)) break;
        }

        if (map.size === 0) {
            Logger.warn(
                `  fetchAllAttributeDefinitions: 0 attribute definitions relevant to channelId "${channelId}". ` +
                `Either no active attributes exist in PIM, or all attributes have a channelId that does not match. ` +
                `Check that attributes either have no channelId (global) or channelId="${channelId}".`,
                loggerCtx,
            );
        } else {
            Logger.info(`  Loaded ${map.size} active attribute definition(s) for channel "${channelId}"`, loggerCtx);
        }
        return map;
    }

    /** Fetches a single Attribute record by ID. Returns null if not found. */
    async fetchAttributeById(attributeId: string): Promise<PimAttributeDef | null> {
        const url = `${this.apiBase}/Attribute/${attributeId}`;
        const res = await this.fetchWithTimeout(url, { headers: this.authHeader });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`PIM attribute fetch failed (HTTP ${res.status}): ${attributeId}`);
        return this.parseJson<PimAttributeDef>(res);
    }

    /**
     * Pre-fetches attribute values for all given product IDs in concurrent batches
     * and stores them in an in-memory cache. Must be called once per sync run before
     * the upsert loop so that subsequent fetchAttributeValues() calls are instant.
     * Replaces ~N sequential HTTP round-trips with ceil(N/concurrency) concurrent batches.
     */
    async prefetchAttributeValues(productIds: string[], concurrency = 10): Promise<void> {
        this.attrValueCache.clear();
        Logger.info(
            `  Pre-fetching attribute values for ${productIds.length} product(s) ` +
            `(concurrency: ${concurrency})...`,
            loggerCtx,
        );
        let done = 0;
        for (let i = 0; i < productIds.length; i += concurrency) {
            const batch = productIds.slice(i, i + concurrency);
            const results = await Promise.all(batch.map(id => this.fetchAttributeValuesHttp(id)));
            for (let j = 0; j < batch.length; j++) {
                this.attrValueCache.set(batch[j], results[j]);
            }
            done += batch.length;
            if (done % 200 === 0 || done === productIds.length) {
                Logger.info(`  Attribute pre-fetch: ${done}/${productIds.length}`, loggerCtx);
            }
        }
    }

    /**
     * Fetches attribute values for a single product record.
     * Returns from the pre-fetch cache when available (populated by prefetchAttributeValues).
     * The endpoint returns a plain array (no {list,total} wrapper).
     * Channel scoping is handled upstream: only attribute definitions relevant to this
     * channel are in the pre-loaded attributeDefMap; unrecognised attributeIds are
     * silently ignored during processing in product-upsert.service.ts.
     * On API error: logs a warning and returns [] (does not abort the group).
     */
    async fetchAttributeValues(productId: string): Promise<PimAttributeValue[]> {
        if (this.attrValueCache.has(productId)) {
            return this.attrValueCache.get(productId)!;
        }
        return this.fetchAttributeValuesHttp(productId);
    }

    private async fetchAttributeValuesHttp(productId: string): Promise<PimAttributeValue[]> {
        const url = `${this.apiBase}/Product/${productId}/attributeValues`;
        let res: Response;
        try {
            res = await this.fetchWithTimeout(url, { headers: this.authHeader });
        } catch (err: unknown) {
            Logger.warn(
                `  fetchAttributeValues for product ${productId}: request failed — ${err instanceof Error ? err.message : String(err)}`,
                loggerCtx,
            );
            return [];
        }

        if (!res.ok) {
            Logger.warn(
                `  fetchAttributeValues for product ${productId}: HTTP ${res.status} — skipping attributes`,
                loggerCtx,
            );
            return [];
        }

        const raw = await this.parseJson<PimAttributeValue[] | Record<string, unknown>>(res);
        if (!Array.isArray(raw)) {
            Logger.warn(
                `  fetchAttributeValues for product ${productId}: unexpected response shape — ` +
                `expected plain array, got object with keys: ${Object.keys(raw).slice(0, 8).join(', ')}. ` +
                `Full response (truncated): ${JSON.stringify(raw).slice(0, 300)}`,
                loggerCtx,
            );
            return [];
        }
        const values = raw as PimAttributeValue[];
        if (values.length === 0) {
            Logger.verbose(`  fetchAttributeValues for product ${productId}: 0 attribute values returned`, loggerCtx);
        } else {
            Logger.verbose(
                `  fetchAttributeValues for product ${productId}: ${values.length} value(s) — ` +
                `attrIds: ${values.slice(0, 6).map(v => v.attributeId).join(', ')}${values.length > 6 ? '...' : ''}`,
                loggerCtx,
            );
        }
        return values;
    }

    /**
     * Pre-fetches ProductFile (image link) rows for all given product IDs in concurrent
     * batches and caches them, mirroring prefetchAttributeValues. Called once per sync run
     * so the per-variant fetchProductFiles() calls in the upsert loop are instant.
     */
    async prefetchProductFiles(productIds: string[], concurrency = 10): Promise<void> {
        this.productFileCache.clear();
        Logger.info(
            `  Pre-fetching product images (ProductFile) for ${productIds.length} product(s) ` +
            `(concurrency: ${concurrency})...`,
            loggerCtx,
        );
        let done = 0;
        for (let i = 0; i < productIds.length; i += concurrency) {
            const batch = productIds.slice(i, i + concurrency);
            const results = await Promise.all(batch.map(id => this.fetchProductFilesHttp(id)));
            for (let j = 0; j < batch.length; j++) {
                this.productFileCache.set(batch[j], results[j]);
            }
            done += batch.length;
            if (done % 200 === 0 || done === productIds.length) {
                Logger.info(`  Product image pre-fetch: ${done}/${productIds.length}`, loggerCtx);
            }
        }
    }

    /**
     * Returns a product's linked image files (ProductFile rows), ordered main-image-first
     * then by ascending `sorting`. Serves from the pre-fetch cache when populated.
     */
    async fetchProductFiles(productId: string): Promise<PimProductFile[]> {
        if (this.productFileCache.has(productId)) {
            return this.productFileCache.get(productId)!;
        }
        return this.fetchProductFilesHttp(productId);
    }

    private async fetchProductFilesHttp(productId: string): Promise<PimProductFile[]> {
        const url = new URL(`${this.apiBase}/ProductFile`);
        url.searchParams.set('maxSize', '50');
        url.searchParams.set('select', 'fileId,fileName,isMainImage,sorting,productId');
        url.searchParams.set(
            'where',
            JSON.stringify([JSON.stringify({ type: 'equals', attribute: 'productId', value: productId })]),
        );

        let res: Response;
        try {
            res = await this.fetchWithTimeout(url.toString(), { headers: this.authHeader });
        } catch (err: unknown) {
            Logger.warn(
                `  fetchProductFiles for product ${productId}: request failed — ${err instanceof Error ? err.message : String(err)}`,
                loggerCtx,
            );
            return [];
        }
        if (!res.ok) {
            Logger.warn(
                `  fetchProductFiles for product ${productId}: HTTP ${res.status} — no images synced`,
                loggerCtx,
            );
            return [];
        }

        const data = await this.parseJson<PimApiListResponse<PimProductFile>>(res);
        const list = Array.isArray(data.list) ? data.list : [];

        // Collapse file versions. The PIM versions every upload: the core filename never
        // changes, but multiple versions of one image exist as separate File rows (distinct
        // fileId, same fileName) and can both be linked here. Those are the SAME logical
        // image, not separate gallery entries — keep one row per distinct filename. A product
        // with genuinely multiple images always has distinct, source-dictated names
        // (e.g. "MF_image1076.png"), so real extras are never collapsed. Within a version
        // group prefer the isMainImage row; otherwise the newest link (highest sorting).
        const byName = new Map<string, PimProductFile>();
        for (const row of list) {
            if (!row.fileId || !(row.fileName ?? '').trim()) continue;
            const key = row.fileName!.trim().toLowerCase();
            const existing = byName.get(key);
            if (!existing
                || (row.isMainImage && !existing.isMainImage)
                || (row.isMainImage === existing.isMainImage && (row.sorting ?? 0) > (existing.sorting ?? 0))) {
                byName.set(key, row);
            }
        }

        // Main image first, then remaining files by their configured sort order. This is
        // the order the assets are stored in Vendure (assetIds[0] becomes the featuredAsset).
        return [...byName.values()].sort((a, b) => {
            if (a.isMainImage !== b.isMainImage) return a.isMainImage ? -1 : 1;
            return (a.sorting ?? 0) - (b.sorting ?? 0);
        });
    }

    /** Downloads an image from PIM and returns the raw bytes. */
    async downloadImage(imageId: string, imageName: string): Promise<Buffer> {
        const ext = imageName.split('.').pop() ?? 'jpeg';
        const url = `${this.baseUrl}/images/${imageId}.${ext}`;
        // Images can be large — use a longer timeout than the default
        const imageTimeoutMs = this.options.imageFetchTimeoutMs ?? 60_000;
        const res = await this.fetchWithTimeout(url, { headers: this.authHeader }, imageTimeoutMs);
        if (!res.ok) throw new Error(`Image download failed (${res.status}): ${url}`);
        return Buffer.from(await res.arrayBuffer());
    }
}
