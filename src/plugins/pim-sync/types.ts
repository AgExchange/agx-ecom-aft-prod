export interface PimSyncOptions {
    pimUrl: string;
    pimUser: string;
    pimPassword: string;
    partTypeGroupCode?: string;    // default: 'part-standards'  (env: PIM_PART_TYPE_GROUP_CODE)
    pageSize?: number;             // default: 200               (env: PIM_PAGE_SIZE)
    fetchTimeoutMs?: number;       // default: 30000             (env: PIM_FETCH_TIMEOUT_MS)
    imageFetchTimeoutMs?: number;  // default: 60000             (env: PIM_IMAGE_TIMEOUT_MS)
    statusFilePath?: string;       // default: cwd/logs/pim-sync-status.json (env: PIM_SYNC_STATUS_FILE)
    deltaMaxAgeDays?: number;      // default: 7 — warn when delta watermark is older than this
    attrFetchConcurrency?: number;  // default: 10 — concurrent fetchAttributeValues calls during pre-fetch
    maxProductImages?: number;      // default: 5 — max images synced per product/variant from ProductFile (main first)
    collectionChunkSize?: number;  // default: 50 — collections per apply-collection-filters job (lower = more parallel jobs)
    /** StockLocation name used for PIM-sourced stock writes ONLY when a channel has
     *  multiple StockLocations assigned (disambiguation). Channels with exactly one
     *  StockLocation use it automatically regardless of name — no default needed there.
     *  default: 'ZL10' (env: PIM_STOCK_LOCATION_NAME) */
    stockLocationName?: string;
    /** Shop API URL for post-sync cache warm-up (e.g. "http://localhost:3000/shop-api").
     *  When set, the worker fires a minimal shop-api query after sync completes so the
     *  server's SelfRefreshingCache (TaxRates, etc.) is primed before the first customer request. */
    shopApiWarmupUrl?: string;
    /** Channel token sent as the vendure-token header in the warm-up request.
     *  Defaults to the channel token that triggered the sync. */
    shopApiWarmupChannelToken?: string;
    /** Delay in ms before firing the warm-up request (default: 30000).
     *  Set higher if collection filter jobs run long and hold connections after sync. */
    warmupDelayMs?: number;
}

export interface SyncJobData {
    /** Vendure channel token from the admin's current channel when the sync was triggered. */
    channelToken: string;
    triggeredAt: string;
    /** ID of the Vendure user who triggered the sync — used to recreate an authenticated context in the worker. */
    userId: string;
    syncMode: 'full' | 'delta';
    /** ISO timestamp watermark for delta sync: only products with modifiedAt >= sinceDate are fetched. */
    sinceDate?: string;
    /** When true, the sync also writes variant price (PIM price) and stock (PIM quantity → ZL10). */
    includePriceStock?: boolean;
}

export interface SyncErrorDetail {
    mpn: string;
    /** SKU of the specific variant that failed, when the error is variant-level. */
    sku?: string;
    error: string;
}

/**
 * Immutable record of the last successfully completed sync run.
 * This is the ONLY valid source for the delta sync watermark.
 * It is never overwritten by a failed or running run.
 */
export interface PimLastCompletedSync {
    triggeredAt: string;
    completedAt: string;
    syncMode: 'full' | 'delta';
    /** Number of Vendure products (MPN groups) processed. */
    productsTotal: number;
    productsCreated: number;
    productsUpdated: number;
    /** Number of Vendure ProductVariants actually written. */
    variantsTotal: number;
    variantsCreated: number;
    variantsUpdated: number;
    errors: number;
    /** Whether this completed run also wrote variant price & stock from the PIM. */
    priceStockIncluded?: boolean;
    /** Number of variant prices written (only when priceStockIncluded). */
    pricesUpdated?: number;
    /** Number of variant stock levels written at ZL10 (only when priceStockIncluded). */
    stockUpdated?: number;
}

export interface PimSyncStatus {
    state: 'idle' | 'running' | 'completed' | 'failed';
    triggeredAt?: string;
    completedAt?: string;
    /** Number of Vendure products (MPN groups) to process. */
    productsTotal: number;
    productsCreated: number;
    productsUpdated: number;
    /** Number of Vendure ProductVariants actually written. */
    variantsTotal: number;
    variantsCreated: number;
    variantsUpdated: number;
    errors: number;
    message?: string;
    errorDetails?: SyncErrorDetail[];
    syncMode?: 'full' | 'delta';
    /** ISO watermark used for delta sync — the triggeredAt of the preceding completed sync. */
    sinceDate?: string;
    /** Whether this run also wrote variant price & stock from the PIM. */
    priceStockIncluded?: boolean;
    /** Number of variant prices written (only when priceStockIncluded). */
    pricesUpdated?: number;
    /** Number of variant stock levels written at ZL10 (only when priceStockIncluded). */
    stockUpdated?: number;
    /** Last successfully completed sync. Never overwritten by a failed run. */
    lastCompletedSync?: PimLastCompletedSync;
}

/**
 * On-disk status file format.
 * v1 was a plain PimSyncStatus object.
 * v2 separated lastCompletedSync from lastRun; used total/created/updated (product-level).
 * v3 adds productsTotal/Created/Updated + variantsTotal/Created/Updated.
 */
export interface PimSyncStatusFile {
    version: 3;
    /** Preserved across failures — the authoritative delta watermark. */
    lastCompletedSync: PimLastCompletedSync | null;
    /** Last run outcome (any state including failed). */
    lastRun: Omit<PimSyncStatus, 'lastCompletedSync'> | null;
}

// ─── PIM API shapes ───────────────────────────────────────────────────────────

export interface PimRouteNode {
    id: string;
    name: string;
}

export interface PimProduct {
    id: string;
    name: string | null;
    number: string | null; // SKU — null for AtroPIM container/hierarchy nodes
    mpn: string | null;
    isActive: boolean;
    status: string;
    description: string | null;
    longDescription: string | null;
    details: string | null;
    price: number | null;
    priceUnitId: string | null;
    priceUnitName: string | null;
    // Recommended Retail Price — the value mapped to the Vendure variant price.
    // `price` above is the supplier purchase price and must NOT be used as the sell price.
    // rrp is denominated in rrpUnitName (e.g. "Rand"); rrpAllUnits holds the per-currency
    // breakdown keyed by PIM unit name (e.g. { Rand, GBP, EUR, USD, CHF }). 0 = unset.
    rrp: number | null;
    rrpUnitName: string | null;
    rrpAllUnits: Record<string, number> | null;
    quantity: number;
    mainImageId: string | null;
    mainImageName: string | null;
    // AtroPIM returns routesNames as either an array-of-arrays or a
    // Record<categoryId, PimRouteNode[]> object depending on the API version.
    routesNames: PimRouteNode[][] | Record<string, PimRouteNode[]>;
    modifiedAt: string;
    // Hierarchy: empty array = top-level product; non-empty = child in PIM tree
    parentsIds: string[];
    isRoot: boolean;       // computed by PIM: true when parentsIds is empty
    hasChildren: boolean;
    // Full category objects this product is assigned to.
    // Populated by explicitly including 'categories' in the API select.
    categories?: PimCategoryRef[];
    // Attribute IDs that vary per variant (others are product-level).
    variantSpecificAttributesIds?: string[];
}

export interface PimApiListResponse<T> {
    total: number;
    list: T[];
}

// ─── ProductFile (Product ↔ File junction) ───────────────────────────────────

/**
 * A single Product→File link from AtroPIM's ProductFile junction entity.
 * This — not the scalar mainImageId field — is the authoritative source of a
 * product's images: one row per linked file, with exactly one flagged isMainImage.
 * Reached via GET /ProductFile?where=productId. The Product.files relation itself
 * is noLoad:true, so it never appears in a plain Product fetch.
 */
export interface PimProductFile {
    id: string;
    fileId: string;
    fileName: string | null;
    isMainImage: boolean;
    sorting: number | null;
    productId: string;
}

// ─── PIM Category reference (embedded on product) ────────────────────────────

/** Lightweight category object returned inside Product.categories[]. */
export interface PimCategoryRef {
    id: string;
    code: string;
    name: string;
    isActive: boolean;
    routesNames: PimRouteNode[][];
    channelsIds: string[];
}

// ─── PIM Attribute definitions and values ────────────────────────────────────

/** AtroPIM Attribute definition record from GET /Attribute. */
export interface PimAttributeDef {
    id: string;
    code: string;
    name: string;
    type: string; // varchar | text | int | float | bool | enum | multiEnum | date | ...
    channelId?: string | null; // null/absent = global attribute (applies to all channels)
}

/** A single attribute value record from GET /Product/{id}/attributeValues.
 *  Response is a plain array — no {list,total} wrapper.
 *  Name/code come from the pre-loaded PimAttributeDef (look up by attributeId).
 */
export interface PimAttributeValue {
    attributeId: string;
    type: string;                                        // varchar | text | int | float | bool | enum | array | ...
    value: string | string[] | number | boolean | null; // array type returns string[]
    visible: boolean;
    valueUnitName: string | null;                        // unit label (e.g. "MM", "Kilogramme") for int/float attributes
    // For unit/measure attributes, PIM pre-converts the value into every configured unit,
    // keyed by unit name (e.g. { Kilogram: 24.101, Gram: 24101, Kilogramme: 24.101 }).
    // Reading the base-unit entry avoids any client-side UOM assumption.
    valueAllUnits?: Record<string, number> | null;
}

// ─── PIM Category ─────────────────────────────────────────────────────────────

export interface PimCategory {
    id: string;
    name: string;
    code: string;
    isActive: boolean;
    routesNames: PimRouteNode[][];
}

// ─── Sync internal types ──────────────────────────────────────────────────────

export interface MpnGroup {
    mpn: string;
    products: PimProduct[];
    oem: PimProduct | undefined;
    productName: string | null;
    /** L1 ancestor name from the AtroPIM category's routesNames — used for classification FacetValue. */
    classificationName?: string | null;
    /** AtroPIM category codes = Vendure Collection IDs this group belongs to. */
    collectionCodes?: string[];
}
