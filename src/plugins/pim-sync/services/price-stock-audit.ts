/**
 * =============================================================================
 * PIM SYNC — PRICE & STOCK AUDIT
 * =============================================================================
 *
 * Before/after audit record + log-file builders for the price & stock phase of
 * the PIM sync. Ported from src/scripts/import-pricelist.ts so the sync produces
 * the same 3-file audit output an operator already knows:
 *
 *   pim-pricestock-{ts}.audit.json   — full VariantAuditRecord[] (machine-readable)
 *   pim-pricestock-{ts}.log          — human-readable per-variant table
 *   pim-pricestock-{ts}.errors.log   — rows with errors or warnings only
 *
 * Unlike the pricelist script, price/stock come from the PIM (price, quantity),
 * not a file, and tax category is not managed here — so the audit captures only
 * price (in minor units) and stock at the default location.
 * =============================================================================
 */

export interface PriceState {
    priceInCents: number | null;
    priceFormatted: string | null;
}

export interface StockState {
    stockOnHand: number;
    stockAllocated: number;
    locationAssigned: boolean;
}

export interface AuditState {
    price: PriceState;
    stock: StockState;
}

export interface VariantAuditRecord {
    mpn: string;
    sku: string;
    variantId: string | null;
    variantName: string | null;
    /** Whether the parent variant row was created or updated in this sync. */
    action: 'created' | 'updated';
    stockLocationName: string | null;
    stockLocationId: string | null;
    before: AuditState;
    after: AuditState;
    changes: string[];
    status: 'UPDATED' | 'NO_CHANGE' | 'SKIPPED' | 'ERROR';
    errors: string[];
    warnings: string[];
}

export function formatPrice(cents: number | null, currencyCode: string): string | null {
    if (cents == null) return null;
    return `${currencyCode} ${(cents / 100).toFixed(2)}`;
}

export function emptyPriceState(): PriceState {
    return { priceInCents: null, priceFormatted: null };
}

export function emptyStockState(): StockState {
    return { stockOnHand: 0, stockAllocated: 0, locationAssigned: false };
}

export interface PriceStockRunMeta {
    syncId: string;
    mode: 'full' | 'delta';
    channelId: string;
    currencyCode: string;
    locationName: string | null;
    timestamp: string;
}

export function buildHumanLog(records: VariantAuditRecord[], meta: PriceStockRunMeta): string {
    const lines: string[] = [];

    lines.push('PIM SYNC — PRICE & STOCK AUDIT LOG');
    lines.push('='.repeat(80));
    lines.push(`Timestamp   : ${meta.timestamp}`);
    lines.push(`Sync        : ${meta.syncId} (${meta.mode})`);
    lines.push(`Channel id  : ${meta.channelId}`);
    lines.push(`Currency    : ${meta.currencyCode}`);
    lines.push(`Location    : ${meta.locationName ?? '(NOT FOUND — stock skipped)'}`);
    lines.push(`Total rows  : ${records.length}`);
    lines.push('');

    for (const r of records) {
        lines.push('-'.repeat(80));
        lines.push(`${r.mpn.padEnd(20)} | ${r.sku.padEnd(20)} | ${r.action.toUpperCase().padEnd(7)} | ${r.status}`);
        lines.push(`  Variant  : id=${r.variantId ?? 'N/A'}  name="${r.variantName ?? ''}"`);
        lines.push(`  Location : ${r.stockLocationName ?? '(none)'} (id=${r.stockLocationId ?? 'N/A'})`);
        lines.push('');
        lines.push(`  BEFORE   price=${r.before.price.priceFormatted ?? 'none'}  stock@${r.stockLocationName ?? '?'}=${r.before.stock.stockOnHand}  alloc=${r.before.stock.stockAllocated}  assigned=${r.before.stock.locationAssigned}`);
        lines.push(`  AFTER    price=${r.after.price.priceFormatted ?? 'none'}  stock@${r.stockLocationName ?? '?'}=${r.after.stock.stockOnHand}  alloc=${r.after.stock.stockAllocated}  assigned=${r.after.stock.locationAssigned}`);

        if (r.changes.length > 0) {
            lines.push(`  CHANGES  ${r.changes.join('  |  ')}`);
        } else {
            lines.push('  CHANGES  (none)');
        }

        for (const e of r.errors)   lines.push(`  ERROR    ${e}`);
        for (const w of r.warnings) lines.push(`  WARNING  ${w}`);
        lines.push('');
    }

    lines.push('='.repeat(80));
    const updated  = records.filter(r => r.status === 'UPDATED').length;
    const noChange = records.filter(r => r.status === 'NO_CHANGE').length;
    const skipped  = records.filter(r => r.status === 'SKIPPED').length;
    const errors   = records.filter(r => r.status === 'ERROR').length;
    lines.push(`TOTALS  updated=${updated}  no_change=${noChange}  skipped=${skipped}  errors=${errors}`);
    lines.push('');

    return lines.join('\n');
}

export function buildErrorLog(records: VariantAuditRecord[], meta: PriceStockRunMeta): string {
    const lines: string[] = [];

    lines.push('PIM SYNC — PRICE & STOCK ERRORS & WARNINGS');
    lines.push('='.repeat(80));
    lines.push(`Timestamp  : ${meta.timestamp}`);
    lines.push(`Sync       : ${meta.syncId} (${meta.mode})`);
    lines.push(`Channel id : ${meta.channelId}`);
    lines.push(`Issues     : ${records.length} row(s)`);
    lines.push('');

    if (records.length === 0) {
        lines.push('No errors or warnings.');
        return lines.join('\n');
    }

    for (const r of records) {
        lines.push('-'.repeat(80));
        lines.push(`${r.mpn} | SKU: ${r.sku}  |  Status: ${r.status}`);
        lines.push(`  Variant  : id=${r.variantId ?? 'N/A'}  name="${r.variantName ?? ''}"`);
        lines.push(`  Location : ${r.stockLocationName ?? '(none)'}  (id=${r.stockLocationId ?? 'N/A'})`);
        lines.push(`  BEFORE   price=${r.before.price.priceFormatted ?? 'none'}  stock=${r.before.stock.stockOnHand}  assigned=${r.before.stock.locationAssigned}`);

        for (const e of r.errors)   lines.push(`  ERROR    ${e}`);
        for (const w of r.warnings) lines.push(`  WARNING  ${w}`);
        lines.push('');
    }

    return lines.join('\n');
}
