import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import { Inject, Injectable } from '@nestjs/common';
import {
    ChannelService,
    CollectionService,
    Job,
    JobQueue,
    LanguageCode,
    Logger,
    RequestContext,
    RequestContextService,
    UserService,
} from '@vendure/core';
import { PIM_SYNC_OPTIONS, SUFFIX_TO_PART_STANDARD, loggerCtx, normalizeLocaleToLanguageCode } from '../constants';
import { MpnGroup, PimLastCompletedSync, PimProduct, PimSyncOptions, PimSyncStatus, PimSyncStatusFile, SyncJobData } from '../types';
import { FacetSyncService } from './facet-sync.service';
import { PimApiService } from './pim-api.service';
import { PriceStockSyncService } from './price-stock-sync.service';
import { ProductUpsertService } from './product-upsert.service';

@Injectable()
export class PimSyncService {
    private syncStatus: PimSyncStatus = {
        state: 'idle',
        productsTotal: 0, productsCreated: 0, productsUpdated: 0,
        variantsTotal: 0, variantsCreated: 0, variantsUpdated: 0,
        errors: 0,
    };
    /** Preserved across failures — never overwritten by a failed run. */
    private lastCompletedSync: PimLastCompletedSync | null = null;
    private jobQueue: JobQueue<SyncJobData> | null = null;
    private statusLoaded = false;

    constructor(
        @Inject(PIM_SYNC_OPTIONS) private options: PimSyncOptions,
        private channelService: ChannelService,
        private collectionService: CollectionService,
        private requestContextService: RequestContextService,
        private userService: UserService,
        private pimApiService: PimApiService,
        private facetSyncService: FacetSyncService,
        private productUpsertService: ProductUpsertService,
        private priceStockSyncService: PriceStockSyncService,
    ) {}

    private get statusFilePath(): string {
        return this.options.statusFilePath ?? path.join(process.cwd(), 'logs', 'pim-sync-status.json');
    }

    private loadPersistedStatus(): void {
        if (this.statusLoaded) return;
        this.statusLoaded = true;
        try {
            const raw = fs.readFileSync(this.statusFilePath, 'utf8');
            const parsed = JSON.parse(raw);
            const version = (parsed as { version?: number }).version;
            if (version === 3) {
                const file = parsed as PimSyncStatusFile;
                this.lastCompletedSync = file.lastCompletedSync ?? null;
                const lastRun = file.lastRun;
                if (lastRun && (lastRun.state === 'completed' || lastRun.state === 'failed')) {
                    this.syncStatus = lastRun;
                }
            } else if (version === 2) {
                // v2 → v3: had total/created/updated (product-level), no variant fields
                const file = parsed as { version: 2; lastCompletedSync: any; lastRun: any };
                if (file.lastCompletedSync) {
                    const lcs = file.lastCompletedSync;
                    this.lastCompletedSync = {
                        triggeredAt: lcs.triggeredAt, completedAt: lcs.completedAt, syncMode: lcs.syncMode,
                        productsTotal: lcs.total ?? 0, productsCreated: lcs.created ?? 0, productsUpdated: lcs.updated ?? 0,
                        variantsTotal: 0, variantsCreated: 0, variantsUpdated: 0,
                        errors: lcs.errors ?? 0,
                    };
                }
                const lastRun = file.lastRun;
                if (lastRun && (lastRun.state === 'completed' || lastRun.state === 'failed')) {
                    this.syncStatus = {
                        ...lastRun,
                        productsTotal: lastRun.total ?? 0, productsCreated: lastRun.created ?? 0, productsUpdated: lastRun.updated ?? 0,
                        variantsTotal: 0, variantsCreated: 0, variantsUpdated: 0,
                    };
                }
            } else {
                // v1: file was a plain PimSyncStatus with total/created/updated
                const v1 = parsed as any;
                if (v1.state === 'completed' || v1.state === 'failed') {
                    this.syncStatus = {
                        ...v1,
                        productsTotal: v1.total ?? 0, productsCreated: v1.created ?? 0, productsUpdated: v1.updated ?? 0,
                        variantsTotal: 0, variantsCreated: 0, variantsUpdated: 0,
                    };
                }
                if (v1.state === 'completed' && v1.triggeredAt && v1.completedAt) {
                    this.lastCompletedSync = {
                        triggeredAt: v1.triggeredAt, completedAt: v1.completedAt, syncMode: v1.syncMode ?? 'full',
                        productsTotal: v1.total ?? 0, productsCreated: v1.created ?? 0, productsUpdated: v1.updated ?? 0,
                        variantsTotal: 0, variantsCreated: 0, variantsUpdated: 0,
                        errors: v1.errors ?? 0,
                    };
                }
            }
        } catch {
            // No file yet — stay idle
        }
    }

    /**
     * Loads only lastCompletedSync from the status file without touching syncStatus.
     * Called at the start of runSync() so the worker process (which starts with
     * lastCompletedSync=null) does not clobber the watermark on its first persistStatus() call.
     */
    private loadLastCompletedSyncFromFile(): void {
        if (this.lastCompletedSync !== null) return; // already loaded
        try {
            const raw = fs.readFileSync(this.statusFilePath, 'utf8');
            const parsed = JSON.parse(raw);
            const version = (parsed as { version?: number }).version;
            if (version === 3) {
                this.lastCompletedSync = (parsed as PimSyncStatusFile).lastCompletedSync ?? null;
            } else if (version === 2) {
                const lcs = (parsed as { lastCompletedSync?: any }).lastCompletedSync;
                if (lcs) {
                    this.lastCompletedSync = {
                        triggeredAt: lcs.triggeredAt, completedAt: lcs.completedAt, syncMode: lcs.syncMode,
                        productsTotal: lcs.total ?? 0, productsCreated: lcs.created ?? 0, productsUpdated: lcs.updated ?? 0,
                        variantsTotal: 0, variantsCreated: 0, variantsUpdated: 0,
                        errors: lcs.errors ?? 0,
                    };
                }
            } else {
                const v1 = parsed as any;
                if (v1.state === 'completed' && v1.triggeredAt && v1.completedAt) {
                    this.lastCompletedSync = {
                        triggeredAt: v1.triggeredAt, completedAt: v1.completedAt, syncMode: v1.syncMode ?? 'full',
                        productsTotal: v1.total ?? 0, productsCreated: v1.created ?? 0, productsUpdated: v1.updated ?? 0,
                        variantsTotal: 0, variantsCreated: 0, variantsUpdated: 0,
                        errors: v1.errors ?? 0,
                    };
                }
            }
        } catch {
            // No file — lastCompletedSync stays null
        }
    }

    private async persistStatus(): Promise<void> {
        try {
            const { lastCompletedSync: _omit, ...lastRun } = this.syncStatus as PimSyncStatus & { lastCompletedSync?: unknown };
            const file: PimSyncStatusFile = {
                version: 3,
                lastCompletedSync: this.lastCompletedSync,
                lastRun,
            };
            await fs.promises.mkdir(path.dirname(this.statusFilePath), { recursive: true });
            await fs.promises.writeFile(
                this.statusFilePath,
                JSON.stringify(file),
                'utf8',
            );
        } catch (err: unknown) {
            Logger.warn(`Failed to persist sync status: ${err instanceof Error ? err.message : String(err)}`, loggerCtx);
        }
    }

    /** Called by the plugin's onModuleInit to register the queue reference. */
    setJobQueue(queue: JobQueue<SyncJobData>): void {
        this.jobQueue = queue;
    }

    getStatus(): PimSyncStatus {
        if (this.syncStatus.state === 'running') {
            // The job runs in the worker process (separate from the server process that owns
            // this singleton). Re-read the status file on every poll so the server sees
            // live progress and the terminal state the worker writes when the job finishes.
            try {
                const raw = fs.readFileSync(this.statusFilePath, 'utf8');
                const parsed = JSON.parse(raw);
                if ((parsed as PimSyncStatusFile).version === 3) {
                    const file = parsed as PimSyncStatusFile;
                    if (file.lastCompletedSync) this.lastCompletedSync = file.lastCompletedSync;
                    if (file.lastRun) this.syncStatus = file.lastRun;
                }
                // v1/v2 files written before a server restart are handled by loadPersistedStatus
                this.statusLoaded = true;
            } catch {
                // File not yet written by worker — remain in current state
            }
        } else {
            this.loadPersistedStatus();
        }
        return { ...this.syncStatus, lastCompletedSync: this.lastCompletedSync ?? undefined };
    }

    /** Enqueues a full sync job. Returns immediately. */
    async enqueueSync(ctx: RequestContext, includePriceStock = false): Promise<PimSyncStatus> {
        const current = this.getStatus();
        if (current.state === 'running') return current;

        if (!ctx.activeUserId) throw new Error('No authenticated user — cannot trigger sync');
        if (!this.jobQueue) throw new Error('PimSyncService: job queue not initialized');

        const triggeredAt = new Date().toISOString();
        this.syncStatus = {
            state: 'running', triggeredAt, syncMode: 'full',
            productsTotal: 0, productsCreated: 0, productsUpdated: 0,
            variantsTotal: 0, variantsCreated: 0, variantsUpdated: 0,
            errors: 0, errorDetails: [],
            priceStockIncluded: includePriceStock, pricesUpdated: 0, stockUpdated: 0,
        };

        // The channel token from the admin's current channel is used as the AtroPIM channel
        // CODE selector — AtroPIM channels are configured with a code that matches the
        // Vendure channel token, enabling multi-channel alignment managed by admins on both sides.
        await this.persistStatus();
        await this.jobQueue.add({
            channelToken: ctx.channel.token,
            triggeredAt,
            userId: String(ctx.activeUserId),
            syncMode: 'full',
            includePriceStock,
        });
        return this.getStatus();
    }

    /**
     * Enqueues a delta sync job using the triggeredAt of the last completed sync as the
     * watermark. Only PIM products with modifiedAt >= watermark are fetched and upserted.
     *
     * Fails if no completed sync has run — operators must run a full sync first.
     *
     * NOTE: products deactivated in PIM after the watermark are NOT captured by delta sync
     * because they are hidden by the isActive=true filter. Run a full sync periodically to
     * pick those up.
     */
    async enqueueDeltaSync(ctx: RequestContext, includePriceStock = false): Promise<PimSyncStatus> {
        const current = this.getStatus();
        if (current.state === 'running') return current;

        if (!ctx.activeUserId) throw new Error('No authenticated user — cannot trigger sync');
        if (!this.jobQueue) throw new Error('PimSyncService: job queue not initialized');

        if (!this.lastCompletedSync) {
            throw new Error(
                'No completed PIM sync found — run a full sync first before using delta sync',
            );
        }

        const watermark = this.lastCompletedSync.triggeredAt;
        const ageDays = (Date.now() - new Date(watermark).getTime()) / (1000 * 60 * 60 * 24);
        const maxAge = this.options.deltaMaxAgeDays ?? 7;
        if (ageDays > maxAge) {
            Logger.warn(
                `Delta watermark is ${ageDays.toFixed(1)} days old (threshold: ${maxAge} days). ` +
                `Consider running a full sync to avoid missing deactivated or re-categorised products.`,
                loggerCtx,
            );
        }

        const triggeredAt = new Date().toISOString();
        this.syncStatus = {
            state: 'running', triggeredAt, syncMode: 'delta', sinceDate: watermark,
            productsTotal: 0, productsCreated: 0, productsUpdated: 0,
            variantsTotal: 0, variantsCreated: 0, variantsUpdated: 0,
            errors: 0, errorDetails: [],
            priceStockIncluded: includePriceStock, pricesUpdated: 0, stockUpdated: 0,
        };

        await this.persistStatus();
        await this.jobQueue.add({
            channelToken: ctx.channel.token,
            triggeredAt,
            userId: String(ctx.activeUserId),
            syncMode: 'delta',
            sinceDate: watermark,
            includePriceStock,
        });
        return this.getStatus();
    }

    /** Entry point called by the job queue worker — handles both full and delta syncs. */
    async runSync(data: SyncJobData, job?: Job<SyncJobData>): Promise<PimSyncStatus> {
        const syncId = `${data.syncMode}-${new Date(data.triggeredAt).getTime()}`;
        const syncStartMs = Date.now();
        const modeLabel = data.syncMode === 'delta'
            ? `delta sync (since ${data.sinceDate})`
            : 'full sync';

        // ── Phase timer helper ────────────────────────────────────────────────
        const phaseTimer = (label: string) => {
            const t = Date.now();
            return () => {
                const ms = Date.now() - t;
                Logger.info(`  [phase:${label}] ${(ms / 1000).toFixed(1)}s`, loggerCtx);
                return ms;
            };
        };

        Logger.info(
            `━━━ PIM ${modeLabel} STARTED ━━━ syncId=${syncId} channel=${data.channelToken}`,
            loggerCtx,
        );
        this.writeAuditEntry({
            syncId, type: 'sync_started',
            mode: data.syncMode, channel: data.channelToken,
            sinceDate: data.sinceDate ?? null,
            triggeredAt: data.triggeredAt,
        });

        // Worker process starts with lastCompletedSync=null — load from file so
        // the first persistStatus() call does not clobber the watermark.
        this.loadLastCompletedSyncFromFile();
        this.statusLoaded = true; // suppress further file loads — we own the file from here
        this.syncStatus = {
            state: 'running',
            triggeredAt: data.triggeredAt,
            syncMode: data.syncMode,
            sinceDate: data.sinceDate,
            productsTotal: 0, productsCreated: 0, productsUpdated: 0,
            variantsTotal: 0, variantsCreated: 0, variantsUpdated: 0,
            errors: 0, errorDetails: [],
        };

        try {
            // ── Build a superadmin RequestContext ─────────────────────────────
            let endPhase = phaseTimer('auth_setup');
            const channel = await this.channelService.getChannelFromToken(data.channelToken);
            if (!channel) throw new Error(`Channel "${data.channelToken}" not found`);

            // Minimal unauthenticated context — only used to load the triggering user.
            const tmpCtx = await this.requestContextService.create({
                apiType: 'admin',
                languageCode: LanguageCode.en,
                channelOrToken: channel,
            });

            // Reload the user who triggered the sync (stored in job data at enqueue time).
            // They must be SuperAdmin to have called triggerPimSync, so this context
            // carries the correct permissions without any additional role lookup.
            const user = await this.userService.getUserById(tmpCtx, data.userId);
            if (!user) throw new Error('Sync trigger user not found — re-trigger the sync from the dashboard');

            // Use the channel's configured language as the context language.
            // This must match the languageCode used in translation writes so that
            // service calls (productService.update etc.) return entities with their
            // name resolved against the same language — otherwise the returned entity
            // has name='' even though the write succeeded.
            const channelLanguageCode = channel.defaultLanguageCode;
            const ctx = await this.requestContextService.create({
                apiType: 'admin',
                languageCode: channelLanguageCode,
                channelOrToken: channel,
                user,
            });
            Logger.info(`  Vendure channel language: ${channelLanguageCode}`, loggerCtx);

            // ── Authenticate with PIM ─────────────────────────────────────────
            await this.pimApiService.authenticate();
            endPhase();

            // ── Resolve PIM channel ID and locale ─────────────────────────────
            const { channelId, pimLocale } = await this.pimApiService.resolvePimChannelId(data.channelToken);
            if (pimLocale) {
                const normalizedPimLang = normalizeLocaleToLanguageCode(pimLocale);
                if (normalizedPimLang !== channelLanguageCode) {
                    Logger.warn(
                        `  Language mismatch: PIM locale "${pimLocale}" normalises to "${normalizedPimLang}" ` +
                        `but Vendure channel default language is "${channelLanguageCode}". ` +
                        `Translations will be written using Vendure channel language "${channelLanguageCode}". ` +
                        `Update the Vendure channel's defaultLanguageCode or the PIM channel locale to match.`,
                        loggerCtx,
                    );
                } else {
                    Logger.info(`  Language: PIM locale "${pimLocale}" → Vendure "${channelLanguageCode}" ✓`, loggerCtx);
                }
            } else {
                Logger.verbose(
                    `  PIM channel locale not set — using Vendure channel language "${channelLanguageCode}" for all translations`,
                    loggerCtx,
                );
            }

            // ── Pre-load attribute definitions from PIM (once per sync) ─────
            endPhase = phaseTimer('attr_defs');
            Logger.info('Fetching PIM attribute definitions...', loggerCtx);
            const attributeDefMap = await this.pimApiService.fetchAllAttributeDefinitions(channelId);
            Logger.info(`  ${attributeDefMap.size} attribute definition(s) loaded for channel`, loggerCtx);
            endPhase();

            // ── Load Vendure lookup tables once ───────────────────────────────
            endPhase = phaseTimer('vendure_lookups');
            await this.facetSyncService.loadLookups(ctx, attributeDefMap);
            endPhase();

            // ── Fetch active channel products ─────────────────────────────────
            endPhase = phaseTimer('product_fetch');
            Logger.info(
                data.syncMode === 'delta'
                    ? `Fetching PIM products modified since ${data.sinceDate}...`
                    : 'Fetching active PIM products...',
                loggerCtx,
            );
            const allProducts = await this.pimApiService.fetchActiveProducts(channelId, pimLocale, data.sinceDate);
            Logger.info(`  ${allProducts.length} active product(s) fetched`, loggerCtx);
            endPhase();

            // ── Group by MPN ──────────────────────────────────────────────────
            const allGroups = this.groupByMpn(allProducts);
            Logger.info(`  ${allGroups.length} MPN group(s) to process`, loggerCtx);

            // ── Resolve collection codes and classificationName per group ─────
            // Each embedded category carries channelsIds — the PIM channel UUIDs it belongs to.
            // cat.channelsIds.includes(channelId) is the channel-tree discriminator:
            // it scopes categories to the current channel without extra API calls.
            for (const group of allGroups) {
                const codes = new Set<string>();
                for (const product of group.products) {
                    for (const cat of product.categories ?? []) {
                        if (!cat.isActive || !cat.code) continue;
                        if (!cat.channelsIds?.includes(channelId)) continue;
                        codes.add(cat.code);
                        if (!group.classificationName) {
                            group.classificationName = cat.routesNames[0]?.[1]?.name ?? cat.name;
                        }
                    }
                }
                group.collectionCodes = [...codes];
            }

            const assignedCount = allGroups.filter(g => g.collectionCodes?.length).length;
            Logger.info(`  ${assignedCount}/${allGroups.length} MPN group(s) have collection assignments`, loggerCtx);

            // ── Collect affected Vendure Collection IDs (for targeted post-sync job) ───
            // AtroPIM category code = Vendure Collection ID (numeric string).
            // Delta sync uses this to only reprocess collections that received changes.
            // Full sync still scans all collections (products may have left any collection).
            const affectedCollectionIds = new Set<number>();
            for (const group of allGroups) {
                for (const code of group.collectionCodes ?? []) {
                    const id = Number(code);
                    if (!isNaN(id) && id > 0) affectedCollectionIds.add(id);
                }
            }

            // ── Pre-fetch all attribute values in concurrent batches ──────────
            // fetchAttributeValues is called once per variant inside upsertMpnGroup.
            // At 1882 products sequential calls dominate sync time.
            // prefetchAttributeValues fills an in-memory cache so upsertMpnGroup
            // reads from cache (instant) instead of making individual HTTP calls.
            endPhase = phaseTimer('attr_value_prefetch');
            Logger.info(`Pre-fetching attribute values for ${allProducts.length} product(s)...`, loggerCtx);
            await this.pimApiService.prefetchAttributeValues(
                allProducts.map(p => p.id),
                this.options.attrFetchConcurrency ?? 10,
            );
            endPhase();

            // ── Pre-fetch all product image links (ProductFile) ───────────────
            // syncProductImages() is called once per variant inside upsertMpnGroup.
            // Pre-filling the cache turns those per-variant HTTP round-trips into
            // instant cache reads, same as the attribute-value prefetch above.
            endPhase = phaseTimer('product_file_prefetch');
            Logger.info(`Pre-fetching product images for ${allProducts.length} product(s)...`, loggerCtx);
            await this.pimApiService.prefetchProductFiles(
                allProducts.map(p => p.id),
                this.options.attrFetchConcurrency ?? 10,
            );
            endPhase();

            this.syncStatus.productsTotal = allGroups.length;
            this.syncStatus.variantsTotal = allProducts.length;
            await this.persistStatus();
            await job?.setProgress(0);

            // Initialise the price/stock phase (resolves ZL10 + currency once). When
            // disabled, applyToVariant() is a no-op and no audit files are written.
            this.syncStatus.priceStockIncluded = !!data.includePriceStock;
            await this.priceStockSyncService.beginRun(ctx, {
                enabled: !!data.includePriceStock,
                logDir: path.dirname(this.statusFilePath),
                syncId,
                mode: data.syncMode,
            });

            this.writeAuditEntry({
                syncId, type: 'sync_phase', phase: 'upsert_loop_start',
                productsTotal: allGroups.length, variantsTotal: allProducts.length,
                collectionsAffected: affectedCollectionIds.size,
                priceStockIncluded: !!data.includePriceStock,
            });

            // ── Upsert all MPN groups ─────────────────────────────────────────
            // Suppress Vendure's product-event → apply-collection-filters subscription for the
            // duration of the loop. Without this, every productService.create/update() fires a
            // ProductEvent that enqueues a full-catalogue collection scan job (all collections,
            // not just affected ones). With 21+ products each triggering several events we were
            // accumulating dozens of those jobs — one ran for 229 hours.
            // After the loop we fire exactly ONE batch job covering all collections.
            this.collectionService.setApplyAllFiltersOnProductUpdates(false);
            Logger.info('PIM sync: collection filter jobs suppressed during upsert loop', loggerCtx);

            const loopStartMs = Date.now();
            let lastProgressLog = 0;

            try {
                for (let g = 0; g < allGroups.length; g++) {
                    const group = allGroups[g];
                    Logger.info(
                        `  [${g + 1}/${allGroups.length}] MPN "${group.mpn}"` +
                        (group.collectionCodes?.length
                            ? ` → collection(s): ${group.collectionCodes.join(', ')}`
                            : ' (no collection)'),
                        loggerCtx,
                    );

                    try {
                        const result = await this.productUpsertService.upsertMpnGroup(ctx, group);
                        if (result.action === 'created') {
                            this.syncStatus.productsCreated++;
                            this.syncStatus.variantsCreated += result.variantsCreated;
                            Logger.info(
                                `  CREATED product for MPN "${group.mpn}" (id=${result.vendureProductId}, variantsCreated=${result.variantsCreated})`,
                                loggerCtx,
                            );
                        } else if (result.action === 'updated') {
                            this.syncStatus.productsUpdated++;
                            this.syncStatus.variantsCreated += result.variantsCreated;
                            this.syncStatus.variantsUpdated += result.variantsUpdated;
                            Logger.info(
                                `  Updated MPN "${group.mpn}" (id=${result.vendureProductId}, variantsUpdated=${result.variantsUpdated}, variantsCreated=${result.variantsCreated})`,
                                loggerCtx,
                            );
                        } else {
                            Logger.warn(`  SKIPPED MPN "${group.mpn}"`, loggerCtx);
                        }

                        if (result.variantErrors > 0) {
                            this.syncStatus.errors += result.variantErrors;
                            for (const { sku, error } of result.variantErrorDetails) {
                                (this.syncStatus.errorDetails ??= []).push({ mpn: group.mpn, sku, error });
                                Logger.warn(`  MPN "${group.mpn}" SKU "${sku ?? '?'}": ${error}`, loggerCtx);
                            }
                        }
                    } catch (err: unknown) {
                        this.syncStatus.errors++;
                        const message = err instanceof Error ? err.message : String(err);
                        const stack   = err instanceof Error ? (err.stack ?? '') : '';
                        (this.syncStatus.errorDetails ??= []).push({ mpn: group.mpn, error: message });
                        Logger.error(
                            `  ERROR syncing MPN "${group.mpn}": ${message}` +
                            (stack ? `\n${stack}` : ''),
                            loggerCtx,
                        );
                    }

                    // ── Progress rate logging every 100 products ──────────────
                    if ((g + 1) - lastProgressLog >= 100 || g + 1 === allGroups.length) {
                        lastProgressLog = g + 1;
                        const elapsedMin = (Date.now() - loopStartMs) / 60_000;
                        const rate = elapsedMin > 0 ? (g + 1) / elapsedMin : 0;
                        const remaining = allGroups.length - (g + 1);
                        const etaMin = rate > 0 ? remaining / rate : 0;
                        const pct = Math.round(((g + 1) / allGroups.length) * 100);
                        Logger.info(
                            `  ── PROGRESS ${g + 1}/${allGroups.length} (${pct}%) ` +
                            `| rate: ${rate.toFixed(1)}/min ` +
                            `| ETA: ${etaMin.toFixed(0)}min ` +
                            `| errors so far: ${this.syncStatus.errors}`,
                            loggerCtx,
                        );
                        this.writeAuditEntry({
                            syncId, type: 'sync_progress',
                            processed: g + 1, total: allGroups.length, pct,
                            ratePerMin: parseFloat(rate.toFixed(2)),
                            etaMin: parseFloat(etaMin.toFixed(1)),
                            errors: this.syncStatus.errors,
                            elapsedMin: parseFloat(elapsedMin.toFixed(1)),
                        });
                    }

                    if ((g + 1) % 10 === 0) await this.persistStatus();
                    await job?.setProgress(Math.round(((g + 1) / allGroups.length) * 100));
                }
            } finally {
                // Always restore — if this stays false, future admin product edits won't
                // update collection membership until the next server restart.
                this.collectionService.setApplyAllFiltersOnProductUpdates(true);
            }

            // ── Flush price/stock audit + record counts ───────────────────────
            // No-op (returns zeros, writes nothing) when price/stock was not included.
            const priceStock = this.priceStockSyncService.flush();
            this.syncStatus.pricesUpdated = priceStock.pricesUpdated;
            this.syncStatus.stockUpdated = priceStock.stockUpdated;
            if (priceStock.included) {
                Logger.info(
                    `PIM sync: price/stock applied — ${priceStock.pricesUpdated} price(s), ` +
                    `${priceStock.stockUpdated} stock level(s), ${priceStock.errorCount} error(s) ` +
                    `across ${priceStock.recordCount} variant(s)`,
                    loggerCtx,
                );
            }

            // ── Error rate check ──────────────────────────────────────────────
            const loopDurationMin = (Date.now() - loopStartMs) / 60_000;
            const errorRate = allGroups.length > 0
                ? (this.syncStatus.errors / allGroups.length) * 100
                : 0;
            Logger.info(
                `PIM sync: upsert loop complete in ${loopDurationMin.toFixed(1)}min | ` +
                `created=${this.syncStatus.productsCreated} updated=${this.syncStatus.productsUpdated} ` +
                `errors=${this.syncStatus.errors} (${errorRate.toFixed(1)}%)`,
                loggerCtx,
            );

            if (errorRate >= 20) {
                Logger.error(
                    `PIM SYNC CRITICAL ━ Error rate ${errorRate.toFixed(1)}% exceeds 20% threshold. ` +
                    `${this.syncStatus.errors}/${allGroups.length} groups failed. Immediate review required.`,
                    loggerCtx,
                );
                this.writeAuditEntry({
                    syncId, type: 'critical_alert', alert: 'HIGH_ERROR_RATE_CRITICAL',
                    errorRate: parseFloat(errorRate.toFixed(1)),
                    errors: this.syncStatus.errors, total: allGroups.length,
                });
            } else if (errorRate >= 5) {
                Logger.warn(
                    `PIM SYNC WARNING ━ Error rate ${errorRate.toFixed(1)}% ` +
                    `(${this.syncStatus.errors}/${allGroups.length} groups failed)`,
                    loggerCtx,
                );
                this.writeAuditEntry({
                    syncId, type: 'critical_alert', alert: 'HIGH_ERROR_RATE_WARN',
                    errorRate: parseFloat(errorRate.toFixed(1)),
                    errors: this.syncStatus.errors, total: allGroups.length,
                });
            }

            if (loopDurationMin > 180) {
                Logger.warn(
                    `PIM SYNC WARNING ━ Upsert loop took ${loopDurationMin.toFixed(0)}min (>3h). ` +
                    `Consider reducing PIM page size or running delta syncs more frequently.`,
                    loggerCtx,
                );
                this.writeAuditEntry({
                    syncId, type: 'critical_alert', alert: 'SLOW_SYNC',
                    durationMin: parseFloat(loopDurationMin.toFixed(1)),
                });
            }

            // ── Enqueue collection filter jobs ────────────────────────────────
            endPhase = phaseTimer('collection_filter_jobs');
            const chunkSize = this.options.collectionChunkSize ?? 50;
            if (data.syncMode === 'delta' && affectedCollectionIds.size > 0) {
                const jobCount = await this.enqueueChunkedCollectionFilterJobs(
                    ctx, [...affectedCollectionIds], chunkSize,
                );
                Logger.info(
                    `PIM sync: enqueued ${jobCount} targeted collection filter job(s) ` +
                    `for ${affectedCollectionIds.size} collection(s)`,
                    loggerCtx,
                );
            } else {
                const allIds = await this.getAllChannelCollectionIds(ctx);
                const jobCount = await this.enqueueChunkedCollectionFilterJobs(ctx, allIds, chunkSize);
                Logger.info(
                    `PIM sync: enqueued ${jobCount} collection filter job(s) ` +
                    `for ${allIds.length} collections (chunk size: ${chunkSize})`,
                    loggerCtx,
                );
            }
            endPhase();

            const completedAt = new Date().toISOString();
            const totalDurationMin = (Date.now() - syncStartMs) / 60_000;
            this.syncStatus = {
                ...this.syncStatus,
                state: 'completed',
                completedAt,
                message: `${data.syncMode === 'delta' ? 'Delta sync' : 'Sync'} complete: ` +
                    `${this.syncStatus.productsCreated} products created, ${this.syncStatus.productsUpdated} updated | ` +
                    `${this.syncStatus.variantsCreated} variants created, ${this.syncStatus.variantsUpdated} updated | ` +
                    `${this.syncStatus.errors} errors` +
                    (priceStock.included
                        ? ` | price/stock: ${priceStock.pricesUpdated} price(s), ${priceStock.stockUpdated} stock` +
                          (priceStock.errorCount > 0 ? `, ${priceStock.errorCount} error(s)` : '')
                        : ' | price/stock: not included'),
            };
            this.lastCompletedSync = {
                triggeredAt: data.triggeredAt,
                completedAt,
                syncMode: data.syncMode,
                productsTotal:   this.syncStatus.productsTotal,
                productsCreated: this.syncStatus.productsCreated,
                productsUpdated: this.syncStatus.productsUpdated,
                variantsTotal:   this.syncStatus.variantsTotal,
                variantsCreated: this.syncStatus.variantsCreated,
                variantsUpdated: this.syncStatus.variantsUpdated,
                errors: this.syncStatus.errors,
                priceStockIncluded: priceStock.included,
                pricesUpdated: priceStock.pricesUpdated,
                stockUpdated: priceStock.stockUpdated,
            };

            Logger.info(
                `━━━ PIM ${modeLabel} COMPLETED ━━━ syncId=${syncId} ` +
                `duration=${totalDurationMin.toFixed(1)}min | ` +
                `products: created=${this.syncStatus.productsCreated} updated=${this.syncStatus.productsUpdated} total=${this.syncStatus.productsTotal} | ` +
                `variants: created=${this.syncStatus.variantsCreated} updated=${this.syncStatus.variantsUpdated} total=${this.syncStatus.variantsTotal} | ` +
                `errors=${this.syncStatus.errors} (${errorRate.toFixed(1)}%)`,
                loggerCtx,
            );
            this.writeAuditEntry({
                syncId, type: 'sync_completed',
                mode: data.syncMode,
                durationMin: parseFloat(totalDurationMin.toFixed(1)),
                productsTotal: this.syncStatus.productsTotal,
                productsCreated: this.syncStatus.productsCreated,
                productsUpdated: this.syncStatus.productsUpdated,
                variantsTotal: this.syncStatus.variantsTotal,
                variantsCreated: this.syncStatus.variantsCreated,
                variantsUpdated: this.syncStatus.variantsUpdated,
                errors: this.syncStatus.errors,
                errorRatePct: parseFloat(errorRate.toFixed(1)),
                priceStockIncluded: priceStock.included,
                pricesUpdated: priceStock.pricesUpdated,
                stockUpdated: priceStock.stockUpdated,
                priceStockErrors: priceStock.errorCount,
                triggeredAt: data.triggeredAt,
                completedAt,
            });

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            const totalDurationMin = (Date.now() - syncStartMs) / 60_000;
            this.syncStatus = {
                ...this.syncStatus,
                state: 'failed',
                completedAt: new Date().toISOString(),
                message,
            };

            // Classify the error for targeted alerting
            const isDbConnError = /connection terminated|invalid authorization|SSL|TLS|ECONNRESET|ETIMEDOUT|authentication failed/i.test(message);
            const isPimApiError = /PIM.*HTTP [45]|fetch.*timeout|getaddrinfo|ENOTFOUND/i.test(message);

            if (isDbConnError) {
                Logger.error(
                    `PIM SYNC CRITICAL ━ Database/SSL connection failure after ${totalDurationMin.toFixed(1)}min: ${message}`,
                    loggerCtx,
                );
                this.writeAuditEntry({ syncId, type: 'critical_alert', alert: 'DB_CONNECTION_FAILURE', message, durationMin: parseFloat(totalDurationMin.toFixed(1)) });
            } else if (isPimApiError) {
                Logger.error(
                    `PIM SYNC CRITICAL ━ PIM API failure after ${totalDurationMin.toFixed(1)}min: ${message}`,
                    loggerCtx,
                );
                this.writeAuditEntry({ syncId, type: 'critical_alert', alert: 'PIM_API_FAILURE', message, durationMin: parseFloat(totalDurationMin.toFixed(1)) });
            } else {
                Logger.error(
                    `PIM SYNC CRITICAL ━ Sync failed after ${totalDurationMin.toFixed(1)}min: ${message}`,
                    loggerCtx,
                );
            }

            Logger.error(
                `━━━ PIM ${modeLabel} FAILED ━━━ syncId=${syncId} duration=${totalDurationMin.toFixed(1)}min`,
                loggerCtx,
            );
            this.writeAuditEntry({
                syncId, type: 'sync_failed',
                mode: data.syncMode,
                message,
                durationMin: parseFloat(totalDurationMin.toFixed(1)),
                productsProcessed: (this.syncStatus.productsCreated + this.syncStatus.productsUpdated),
                errors: this.syncStatus.errors,
            });
        }

        await this.persistStatus();

        if (this.syncStatus.state === 'completed' && this.options.shopApiWarmupUrl) {
            const delayMs = this.options.warmupDelayMs ?? 30_000;
            const warmupUrl = this.options.shopApiWarmupUrl;
            const channelToken = this.options.shopApiWarmupChannelToken ?? data.channelToken;
            setTimeout(() => this.warmupShopApi(warmupUrl, channelToken), delayMs);
            Logger.info(
                `PIM sync: shop-api warm-up scheduled in ${delayMs / 1000}s → ${warmupUrl}`,
                loggerCtx,
            );
        }

        return this.syncStatus;
    }

    // ── Audit log ─────────────────────────────────────────────────────────────

    private get auditLogPath(): string {
        const dir = path.dirname(this.statusFilePath);
        return path.join(dir, 'pim-sync-audit.jsonl');
    }

    /**
     * Appends a structured JSON entry to pim-sync-audit.jsonl (one object per line).
     * Never throws — audit failures must not interrupt the sync.
     */
    private writeAuditEntry(entry: Record<string, unknown>): void {
        const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
        try {
            fs.mkdirSync(path.dirname(this.auditLogPath), { recursive: true });
            fs.appendFileSync(this.auditLogPath, line, 'utf8');
        } catch (err) {
            Logger.warn(
                `PIM audit log write failed: ${err instanceof Error ? err.message : String(err)}`,
                loggerCtx,
            );
        }
    }

    /** Fires a minimal shop-api GraphQL query to prime the server's SelfRefreshingCaches. */
    private warmupShopApi(url: string, channelToken: string): void {
        const body = JSON.stringify({ query: '{ products(options:{take:1}){ totalItems } }' });
        const parsed = new URL(url);
        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'vendure-token': channelToken,
            },
            timeout: 60_000,
        };
        const transport = parsed.protocol === 'https:' ? https : http;
        const req = transport.request(options, (res) => {
            res.resume(); // drain response
            Logger.info(`PIM sync: shop-api warm-up responded with HTTP ${res.statusCode}`, loggerCtx);
        });
        req.on('error', (err) => {
            Logger.warn(`PIM sync: shop-api warm-up failed: ${err.message}`, loggerCtx);
        });
        req.on('timeout', () => {
            req.destroy();
            Logger.warn('PIM sync: shop-api warm-up timed out', loggerCtx);
        });
        req.write(body);
        req.end();
    }

    // ── Collection filter helpers ─────────────────────────────────────────────

    /** Paginates through all collections in the current channel and returns their IDs. */
    private async getAllChannelCollectionIds(ctx: RequestContext): Promise<number[]> {
        const ids: number[] = [];
        const take = 1000;
        let skip = 0;
        while (true) {
            const page = await this.collectionService.findAll(ctx, { take, skip });
            ids.push(...page.items.map(c => Number(c.id)));
            if (ids.length >= page.totalItems) break;
            skip += take;
        }
        return ids;
    }

    /**
     * Splits collectionIds into chunks and enqueues one apply-collection-filters job per chunk.
     * With DefaultJobQueuePlugin concurrency > 1, these jobs run in parallel.
     * Returns the number of jobs enqueued.
     */
    private async enqueueChunkedCollectionFilterJobs(
        ctx: RequestContext,
        collectionIds: number[],
        chunkSize: number,
    ): Promise<number> {
        let jobCount = 0;
        for (let i = 0; i < collectionIds.length; i += chunkSize) {
            const chunk = collectionIds.slice(i, i + chunkSize);
            await this.collectionService.triggerApplyFiltersJob(ctx, { collectionIds: chunk });
            jobCount++;
        }
        return jobCount;
    }

    // ── MPN grouping ──────────────────────────────────────────────────────────

    private groupByMpn(products: PimProduct[]): MpnGroup[] {
        const map = new Map<string, PimProduct[]>();

        for (const p of products) {
            const sku = (p.number ?? '').trim();
            const mpn = (p.mpn ?? sku).trim();

            // Derive the suffix to check against the known mapping table.
            // Products whose suffix is not in the table (e.g. complex MPN formats like
            // "partNumber-suffix" or MPNs that already contain dashes) are placed into
            // their own singleton group keyed by SKU. When the upsert service then calls
            // deriveSuffix(sku, sku) the result is '' → OEM / ORIGINAL EQUIPMENT, so the
            // product is created as a standalone with the default grade option values.
            let groupKey: string;
            if (sku && mpn && sku.startsWith(mpn)) {
                const suffix = sku.slice(mpn.length).replace(/^-/, '').toUpperCase();
                if (suffix !== '' && !(suffix in SUFFIX_TO_PART_STANDARD)) {
                    groupKey = sku; // singleton — suffix derivation against itself yields ''
                    Logger.info(
                        `  Unknown suffix "${suffix}" on SKU "${sku}" (MPN "${mpn}") — ` +
                        `will be created as a separate product with OEM / ORIGINAL EQUIPMENT options`,
                        loggerCtx,
                    );
                } else {
                    groupKey = mpn;
                }
            } else {
                groupKey = mpn || sku;
            }

            const existing = map.get(groupKey) ?? [];
            if (existing.length > 0) {
                Logger.info(
                    `  SKU "${sku}" merged as variant into MPN group "${groupKey}"`,
                    loggerCtx,
                );
            }
            map.set(groupKey, [...existing, p]);
        }

        return Array.from(map.entries()).map(([key, prods]) => {
            // For singleton groups (key = SKU), the product is its own OEM.
            // For normal groups (key = MPN), find the variant whose number equals the MPN.
            const oem = prods.find(p => (p.number ?? '') === key)
                ?? prods.find(p => (p.number ?? '') === (prods[0].mpn ?? ''));
            const productName = oem?.name ?? prods[0].name;
            return { mpn: key, products: prods, oem, productName };
        });
    }
}
