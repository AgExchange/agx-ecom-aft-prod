import { Inject, Injectable } from '@nestjs/common';
import { Asset, AssetService, Logger, RequestContext } from '@vendure/core';
import { Readable } from 'stream';
import { DEFAULT_MAX_PRODUCT_IMAGES, PIM_SYNC_OPTIONS, loggerCtx } from '../constants';
import { PimProduct, PimProductFile, PimSyncOptions } from '../types';
import { PimApiService } from './pim-api.service';

@Injectable()
export class AssetSyncService {
    constructor(
        @Inject(PIM_SYNC_OPTIONS) private options: PimSyncOptions,
        private assetService: AssetService,
        private pimApiService: PimApiService,
    ) {}

    /**
     * Ensures every image linked to a PIM product (via its ProductFile rows) exists in
     * Vendure and returns their asset IDs, ordered main-image-first, capped at maxImages.
     * assetIds[0] is the main image — callers use it as the entity's featuredAsset.
     *
     * `files` are the product's distinct images (one per logical image, main-first) — the
     * API layer has already collapsed file versions and ordered them. When empty — e.g. a
     * product whose image predates ProductFile population — this falls back to the legacy
     * single mainImageId/mainImageName field on the product.
     *
     * Naming: assets are stored under their actual PIM filename (e.g. "MF_image1076.png",
     * "0050345.jpeg") — pim-sync does not rename or re-sequence files. Within one product,
     * files sharing a filename are versions of the same image and are already collapsed to
     * one upstream. A source image shared across products (same filename, same bytes) resolves
     * to the same Vendure asset — by name in Pass A, or by Pass B (fileSize + mimeType) the
     * first time. When `files` is empty — a product not yet linked through ProductFile — this
     * falls back to the legacy single mainImageId/mainImageName field on the product.
     */
    async syncProductImages(
        ctx: RequestContext,
        product: PimProduct,
        files: PimProductFile[],
        maxImages: number = this.options.maxProductImages ?? DEFAULT_MAX_PRODUCT_IMAGES,
    ): Promise<string[]> {
        const sku = product.number?.trim();
        if (!sku) return [];

        // ProductFile is the source of truth; fall back to the legacy single-image field
        // so products not yet linked through ProductFile still get their main image.
        // Files with a blank name are skipped — PIM junk rows with no usable filename.
        const sources: Array<{ fileId: string; fileName: string; isMain: boolean }> =
            files.length > 0
                ? files
                      .filter(f => f.fileId && (f.fileName ?? '').trim())
                      .map(f => ({ fileId: f.fileId, fileName: f.fileName!.trim(), isMain: f.isMainImage }))
                : (product.mainImageId && product.mainImageName
                    ? [{ fileId: product.mainImageId, fileName: product.mainImageName, isMain: true }]
                    : []);

        const assetIds: string[] = [];
        for (let i = 0; i < sources.length && assetIds.length < maxImages; i++) {
            const id = await this.syncImage(ctx, sku, sources[i].fileId, sources[i].fileName, sources[i].isMain);
            if (id) assetIds.push(id);
        }
        return assetIds;
    }

    /**
     * Ensures a single PIM image file exists in Vendure and returns its asset ID.
     * The asset is stored under its actual PIM filename. Uses the same two-pass matching
     * strategy as delete-duplicate-assets.ts:
     *
     *   Pass A — display name match: find all assets whose translated name equals the PIM
     *            filename. Among matches, prefer the canonical (source basename equals
     *            filename, no __NN suffix). Confirm with mimeType. Cheap; avoids downloads.
     *
     *   Pass B — fileSize + mimeType match: download the PIM image (needed for upload anyway
     *            if we reach this point), then search for assets with the same byte count and
     *            MIME type. Catches physically-identical images uploaded under a different name.
     *
     * If neither pass finds a match, the downloaded buffer is used to create a new asset
     * named after the PIM file. No deletions are performed here — that is the cleanup script's job.
     *
     * `isMain` only affects Pass A: for the main image we also check the legacy `${sku}.${ext}`
     * name that earlier syncs assigned, so the existing catalogue is reused by name instead of
     * re-downloaded every run. This fallback is read-only — new assets always use the PIM name.
     */
    private async syncImage(
        ctx: RequestContext,
        sku: string,
        fileId: string,
        fileName: string,
        isMain: boolean,
    ): Promise<string | null> {
        const filename = fileName.trim();
        if (!filename) return null;
        const ext      = filename.split('.').pop()?.toLowerCase() ?? 'jpeg';
        const mimetype = ext === 'png' ? 'image/png' : 'image/jpeg';

        // ── Pass A: display name match (PIM name, plus legacy ${sku}.${ext} for main) ──
        const nameCandidates = isMain ? [filename, `${sku}.${ext}`] : [filename];
        for (const candidate of nameCandidates) {
            const byName = await this.assetService.findAll(ctx, {
                filter: { name: { eq: candidate } },
                take: 10,
            });
            if (byName.items.length > 0) {
                const canonical = this.pickCanonical(byName.items, candidate);
                if ((canonical as any).mimeType === mimetype) {
                    Logger.verbose(`  Asset exists (name): ${candidate} id=${canonical.id}`, loggerCtx);
                    return String(canonical.id);
                }
            }
        }

        // ── Download from PIM ─────────────────────────────────────────────────
        // Required for Pass B comparison and for the upload if both passes miss.
        let buffer: Buffer;
        try {
            buffer = await this.pimApiService.downloadImage(fileId, fileName);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`  Failed to download image for SKU ${sku} (${filename}): ${message}`, loggerCtx);
            return null;
        }

        // ── Pass B: fileSize + mimeType match ─────────────────────────────────
        // Catches assets uploaded under a different name that are physically identical.
        const bySize = await this.assetService.findAll(ctx, {
            filter: {
                fileSize: { eq: buffer.byteLength },
                mimeType: { eq: mimetype },
            },
            take: 10,
        });
        if (bySize.items.length > 0) {
            const canonical = this.pickCanonical(bySize.items, filename);
            Logger.verbose(
                `  Asset exists (size+type): ${filename} id=${canonical.id} ` +
                `(${buffer.byteLength} bytes · ${mimetype})`,
                loggerCtx,
            );
            return String(canonical.id);
        }

        // ── Create new asset ──────────────────────────────────────────────────
        try {
            const asset = await this.assetService.createFromFileStream(
                Readable.from(buffer),
                filename,
                ctx,
            );
            if ('id' in asset) {
                Logger.info(`  Uploaded asset: ${filename} → id ${asset.id}`, loggerCtx);
                return String(asset.id);
            }
            Logger.warn(`  Asset create returned MimeTypeError for ${filename}`, loggerCtx);
            return null;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`  Failed to create asset for SKU ${sku} (${filename}): ${message}`, loggerCtx);
            return null;
        }
    }

    /**
     * Mirrors pickCanonical in delete-duplicate-assets.ts:
     * from a list sorted by ascending ID, prefer the asset whose source basename
     * exactly equals the display name (no __NN suffix); fallback to lowest ID.
     */
    private pickCanonical(assets: Asset[], filename?: string): Asset {
        const sorted = [...assets].sort((a, b) => Number(a.id) - Number(b.id));
        if (filename) {
            const exact = sorted.find(a => {
                const source = (a as any).source as string | undefined;
                return !!source && (source.split('/').pop() ?? '') === filename;
            });
            if (exact) return exact;
        }
        return sorted[0];
    }
}
