import { Inject, Injectable } from '@nestjs/common';
import {
    ID,
    Logger,
    ProductVariantService,
    RequestContext,
    StockLevelService,
    StockLocationService,
} from '@vendure/core';
import * as fs from 'fs';
import * as path from 'path';

import { DEFAULT_STOCK_LOCATION_NAME, PIM_SYNC_OPTIONS, loggerCtx } from '../constants';
import { PimProduct, PimSyncOptions } from '../types';
import {
    AuditState,
    buildErrorLog,
    buildHumanLog,
    emptyPriceState,
    emptyStockState,
    formatPrice,
    PriceStockRunMeta,
    VariantAuditRecord,
} from './price-stock-audit';

export interface PriceStockRunOptions {
    enabled: boolean;
    /** Directory for the 3 audit files (same directory as the status file). */
    logDir: string;
    syncId: string;
    mode: 'full' | 'delta';
}

export interface ApplyVariantParams {
    variantId: ID;
    sku: string;
    mpn: string;
    variantName: string;
    pimProduct: PimProduct;
    action: 'created' | 'updated';
}

export interface PriceStockRunResult {
    included: boolean;
    pricesUpdated: number;
    stockUpdated: number;
    recordCount: number;
    errorCount: number;
}

/**
 * Writes variant price (PIM Recommended Retail Price) and stock (PIM `quantity` →
 * default location ZL10) during a PIM sync, capturing before/after values into a
 * 3-file audit log.
 *
 * Price source: the variant sell price is the PIM **RRP**, resolved in the channel
 * currency (see resolveRrp). PIM `price` is the supplier *purchase* price and must
 * never be used as the sell price.
 *
 * Mirrors the proven service-layer pattern in src/scripts/import-pricelist.ts:
 *   • price  — createOrUpdateProductVariantPrice() with Math.round(rrp * 100)
 *   • stock  — getStockLevel() (get-or-create) then updateStockOnHandForLocation()
 *              with a DELTA computed against the just-fetched level (= absolute overwrite)
 *
 * Null handling (per product requirements):
 *   • RRP null/0/unavailable in channel currency → skip (never wipe an existing price)
 *   • quantity null → skip (leave existing stock untouched)
 *
 * Per-run state lives on this singleton. The PIM sync guards against concurrent runs
 * (status.state === 'running'), so only one run is ever active at a time.
 */
@Injectable()
export class PriceStockSyncService {
    private enabled = false;
    private logDir = process.cwd();
    private syncId = '';
    private mode: 'full' | 'delta' = 'full';

    private channelId: ID = '';
    private currencyCode = '';
    private locationId: string | null = null;
    private locationName: string | null = null;

    private records: VariantAuditRecord[] = [];
    private pricesUpdated = 0;
    private stockUpdated = 0;

    constructor(
        private productVariantService: ProductVariantService,
        private stockLocationService: StockLocationService,
        private stockLevelService: StockLevelService,
        @Inject(PIM_SYNC_OPTIONS) private options: PimSyncOptions,
    ) {}

    /** True once beginRun() has activated price/stock writes for the current sync. */
    isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Initialises a run: resets the accumulator and, when enabled, resolves the
     * channel's stock location and the channel currency once. If no usable stock
     * location can be resolved, stock writes are skipped for the whole run (price
     * writes still happen).
     *
     * StockLocation is a channel-aware Vendure entity (assigned per-channel via
     * Admin), so `stockLocationService.findAll(ctx, ...)` is already scoped to
     * the current channel:
     *   - exactly one location assigned → use it directly, whatever it's named.
     *     No hardcoded/configured name is needed for the common single-warehouse-
     *     per-channel case.
     *   - more than one location assigned → ambiguous; fall back to matching
     *     `options.stockLocationName` (default DEFAULT_STOCK_LOCATION_NAME, i.e.
     *     'ZL10') to pick the intended one.
     *   - zero locations assigned → genuinely unconfigured for this channel;
     *     log and skip stock writes. Fix is to assign a StockLocation to the
     *     channel in Admin, not a code change.
     */
    async beginRun(ctx: RequestContext, opts: PriceStockRunOptions): Promise<void> {
        this.enabled = opts.enabled;
        this.logDir = opts.logDir;
        this.syncId = opts.syncId;
        this.mode = opts.mode;
        this.records = [];
        this.pricesUpdated = 0;
        this.stockUpdated = 0;
        this.channelId = ctx.channelId;
        this.currencyCode = ctx.channel.defaultCurrencyCode;
        this.locationId = null;
        this.locationName = null;

        if (!this.enabled) {
            Logger.info('Price/stock sync: DISABLED for this run (catalogue only)', loggerCtx);
            return;
        }

        const locations = await this.stockLocationService.findAll(ctx, { take: 100 });
        let loc = locations.items.length === 1 ? locations.items[0] : undefined;

        if (!loc && locations.items.length > 1) {
            const preferredName = this.options.stockLocationName ?? DEFAULT_STOCK_LOCATION_NAME;
            loc = locations.items.find(l => l.name === preferredName);
            if (!loc) {
                Logger.error(
                    `Price/stock sync: channel has ${locations.items.length} stock locations ` +
                    `and none is named "${preferredName}" — stock writes will be SKIPPED this run ` +
                    `(prices still applied). Available: ${locations.items.map(l => l.name).join(', ')}. ` +
                    `Set the stockLocationName plugin option (or PIM_STOCK_LOCATION_NAME) to disambiguate.`,
                    loggerCtx,
                );
            }
        } else if (!loc) {
            Logger.error(
                `Price/stock sync: no StockLocation is assigned to this channel — ` +
                `stock writes will be SKIPPED this run (prices still applied). ` +
                `Assign a StockLocation to the channel in Admin (Settings → Stock Locations).`,
                loggerCtx,
            );
        }

        if (loc) {
            this.locationId = String(loc.id);
            this.locationName = loc.name;
        }

        Logger.info(
            `Price/stock sync: ENABLED — currency=${this.currencyCode}, ` +
            `location=${this.locationName ?? 'MISSING'}`,
            loggerCtx,
        );
    }

    /**
     * Applies PIM price + stock to a single variant and records a before/after
     * audit entry. No-op when disabled. Never throws — failures are captured on
     * the audit record so the catalogue sync is never interrupted.
     */
    async applyToVariant(ctx: RequestContext, params: ApplyVariantParams): Promise<void> {
        if (!this.enabled) return;

        const record: VariantAuditRecord = {
            mpn: params.mpn,
            sku: params.sku,
            variantId: String(params.variantId),
            variantName: params.variantName,
            action: params.action,
            stockLocationName: this.locationName,
            stockLocationId: this.locationId,
            before: { price: emptyPriceState(), stock: emptyStockState() },
            after: { price: emptyPriceState(), stock: emptyStockState() },
            changes: [],
            status: 'SKIPPED',
            errors: [],
            warnings: [],
        };

        try {
            await this.process(ctx, record, params.pimProduct);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            record.errors.push(`Unhandled exception: ${msg}`);
            record.status = 'ERROR';
            Logger.error(`  [price/stock] SKU ${params.sku}: ${msg}`, loggerCtx);
        }

        this.records.push(record);
    }

    private async process(
        ctx: RequestContext,
        record: VariantAuditRecord,
        pimProduct: PimProduct,
    ): Promise<void> {
        const variantId = Number(record.variantId);

        // ── BEFORE state ──────────────────────────────────────────────────────
        const beforePrices = await this.productVariantService.getProductVariantPrices(ctx, variantId);
        const beforePriceRow = beforePrices.find(
            p => String(p.channelId) === String(this.channelId) && p.currencyCode === this.currencyCode,
        );

        let beforeLevel: { stockOnHand: number; stockAllocated: number } | undefined;
        if (this.locationId != null) {
            const beforeLevels = await this.stockLevelService.getStockLevelsForVariant(ctx, variantId);
            beforeLevel = beforeLevels.find(
                l => String((l as { stockLocationId: ID }).stockLocationId) === this.locationId,
            );
        }

        record.before = {
            price: {
                priceInCents: beforePriceRow?.price ?? null,
                priceFormatted: formatPrice(beforePriceRow?.price ?? null, this.currencyCode),
            },
            stock: {
                stockOnHand: beforeLevel?.stockOnHand ?? 0,
                stockAllocated: beforeLevel?.stockAllocated ?? 0,
                locationAssigned: !!beforeLevel,
            },
        };

        // ── Targets ───────────────────────────────────────────────────────────
        // Price: the sell price is the PIM RRP (NOT the supplier purchase price `price`),
        // resolved in the channel currency. null/0/unavailable → skip (never wipe —
        // "once it has a price it must always have a price").
        const rrp = this.resolveRrp(pimProduct, record);
        const priceTarget = rrp != null ? Math.round(rrp * 100) : null;

        // Quantity:
        //   • quantity present            → use it
        //   • quantity null, RRP present  → 0 (line is depleted in the ERP, no longer
        //                                       available online — actively deplete stock)
        //   • quantity null, RRP null     → skip the whole variant (incomplete/failed read)
        let stockTarget: number | null;
        if (pimProduct.quantity != null) {
            stockTarget = Math.trunc(pimProduct.quantity);
        } else if (rrp != null) {
            stockTarget = 0;
        } else {
            stockTarget = null;
        }

        // Both null → nothing to write; leave the variant untouched.
        if (priceTarget == null && stockTarget == null) {
            record.warnings.push('PIM RRP and quantity both unusable — variant left untouched');
            record.status = 'SKIPPED';
            record.after = record.before;
            return;
        }

        if (priceTarget == null) {
            record.warnings.push(
                beforePriceRow != null
                    ? 'PIM RRP is null/0 — existing price left unchanged'
                    : 'PIM RRP is null/0 and variant has no price',
            );
        }
        if (pimProduct.quantity == null && stockTarget === 0) {
            record.warnings.push('PIM quantity is null with an RRP present — stock set to 0 (depleted in ERP)');
        }
        if (this.locationId == null) {
            record.warnings.push(
                `Stock location "${DEFAULT_STOCK_LOCATION_NAME}" not found — stock not updated`,
            );
        }

        // ── Detect changes ────────────────────────────────────────────────────
        const changes: string[] = [];
        const priceChanged = priceTarget != null && beforePriceRow?.price !== priceTarget;
        if (priceChanged) {
            changes.push(
                `price: ${beforePriceRow?.price ?? 'none'}→${priceTarget} ` +
                `(${formatPrice(beforePriceRow?.price ?? null, this.currencyCode)}→${formatPrice(priceTarget, this.currencyCode)})`,
            );
        }

        const canWriteStock = this.locationId != null && stockTarget != null;
        const beforeOH = record.before.stock.stockOnHand;
        const stockChanged = canWriteStock && (stockTarget !== beforeOH || !record.before.stock.locationAssigned);
        if (canWriteStock) {
            if (!record.before.stock.locationAssigned) {
                changes.push(`stockLocation: assigned ${this.locationName}`);
            }
            if (stockTarget !== beforeOH) {
                changes.push(`stockOnHand@${this.locationName}: ${beforeOH}→${stockTarget}`);
            }
        }
        record.changes = changes;

        // ── Apply price ───────────────────────────────────────────────────────
        let priceApplied: number | null = beforePriceRow?.price ?? null;
        if (priceChanged) {
            try {
                await this.productVariantService.createOrUpdateProductVariantPrice(
                    ctx,
                    variantId,
                    priceTarget!,
                    this.channelId,
                );
                priceApplied = priceTarget;
                this.pricesUpdated++;
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                record.errors.push(`price update failed: ${msg}`);
            }
        }

        // ── Apply stock (delta against the just-fetched level = absolute overwrite) ──
        // Only touch the stock level when something actually changes — skips a
        // get-or-create round-trip per unchanged variant across large catalogues.
        let stockApplied = beforeOH;
        let stockAssignedAfter = record.before.stock.locationAssigned;
        if (canWriteStock && stockChanged) {
            try {
                const levelNow = await this.stockLevelService.getStockLevel(
                    ctx,
                    variantId,
                    Number(this.locationId),
                );
                const delta = stockTarget! - levelNow.stockOnHand;
                if (delta !== 0) {
                    await this.stockLevelService.updateStockOnHandForLocation(
                        ctx,
                        variantId,
                        Number(this.locationId),
                        delta,
                    );
                }
                stockApplied = stockTarget!;
                stockAssignedAfter = true;
                this.stockUpdated++;
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                record.errors.push(`stock update failed: ${msg}`);
            }
        }

        // ── AFTER state (computed from applied values — deterministic) ─────────
        record.after = {
            price: {
                priceInCents: priceApplied,
                priceFormatted: formatPrice(priceApplied, this.currencyCode),
            },
            stock: {
                stockOnHand: stockApplied,
                stockAllocated: record.before.stock.stockAllocated,
                locationAssigned: stockAssignedAfter,
            },
        } as AuditState;

        record.status =
            record.errors.length > 0 ? 'ERROR' : changes.length > 0 ? 'UPDATED' : 'NO_CHANGE';
    }

    /** Vendure currency code → PIM unit name. PIM denominates ZAR as "Rand"; all other
     *  supported currencies share the ISO code. Extend if PIM adds differently-named units. */
    private static readonly CURRENCY_CODE_TO_PIM_UNIT: Record<string, string> = {
        ZAR: 'Rand',
    };

    /** Resolves the RRP in the channel currency, in major units (e.g. 9144.48 for R9144.48).
     *  Prefers the per-currency breakdown (rrpAllUnits) keyed by PIM unit name, falling back
     *  to the base rrp when it is denominated in the channel currency. Returns null when no
     *  positive RRP is available in the channel currency — 0 is AtroPIM's "unset" sentinel
     *  and must never overwrite an existing price. */
    private resolveRrp(pimProduct: PimProduct, record: VariantAuditRecord): number | null {
        const pimUnit =
            PriceStockSyncService.CURRENCY_CODE_TO_PIM_UNIT[this.currencyCode] ?? this.currencyCode;

        let value: number | null = pimProduct.rrpAllUnits?.[pimUnit] ?? null;
        if (value == null && pimProduct.rrpUnitName === pimUnit) {
            value = pimProduct.rrp;
        }

        if (value == null) {
            record.warnings.push(
                `PIM RRP not available in channel currency ${this.currencyCode} (PIM unit "${pimUnit}")`,
            );
            return null;
        }
        if (value <= 0) {
            // 0 = unset in AtroPIM — treat as no price (do not overwrite an existing price).
            return null;
        }
        return value;
    }

    /**
     * Writes the 3 audit files for this run and returns summary counts. No-op file
     * writes when the run was disabled. Never throws — audit failures must not
     * interrupt the sync.
     */
    flush(): PriceStockRunResult {
        const errorCount = this.records.filter(r => r.status === 'ERROR').length;
        if (!this.enabled) {
            return { included: false, pricesUpdated: 0, stockUpdated: 0, recordCount: 0, errorCount: 0 };
        }

        const meta: PriceStockRunMeta = {
            syncId: this.syncId,
            mode: this.mode,
            channelId: String(this.channelId),
            currencyCode: this.currencyCode,
            locationName: this.locationName,
            timestamp: new Date().toISOString(),
        };

        try {
            if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const base = path.join(this.logDir, `pim-pricestock-${ts}`);

            fs.writeFileSync(`${base}.audit.json`, JSON.stringify(this.records, null, 2), 'utf8');
            fs.writeFileSync(`${base}.log`, buildHumanLog(this.records, meta), 'utf8');

            const errorRecords = this.records.filter(r => r.errors.length > 0 || r.warnings.length > 0);
            fs.writeFileSync(`${base}.errors.log`, buildErrorLog(errorRecords, meta), 'utf8');

            Logger.info(
                `Price/stock audit written: ${base}.{audit.json,log,errors.log} ` +
                `(${this.records.length} variants, ${this.pricesUpdated} prices, ` +
                `${this.stockUpdated} stock, ${errorCount} errors)`,
                loggerCtx,
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            Logger.warn(`Price/stock audit write failed: ${msg}`, loggerCtx);
        }

        return {
            included: true,
            pricesUpdated: this.pricesUpdated,
            stockUpdated: this.stockUpdated,
            recordCount: this.records.length,
            errorCount,
        };
    }
}
