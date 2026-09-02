import * as fs from 'fs';
import * as path from 'path';

import { Injectable, Inject } from '@nestjs/common';
import { Channel, FacetValue, ID, Logger, Product, ProductVariant, ProductVariantTranslation, RequestContext, TransactionalConnection } from '@vendure/core';
import { PRODUCT_INFO_PLUGIN_OPTIONS } from '../constants';
import { PluginInitOptions } from '../types';

const LOW_STOCK_THRESHOLD = 100;
const logCtx = 'ProductInfoService';

@Injectable()
export class ProductInfoService {
    constructor(private connection: TransactionalConnection, @Inject(PRODUCT_INFO_PLUGIN_OPTIONS) private options: PluginInitOptions) {}

    async exampleMethod(ctx: RequestContext, id: ID) {
        // Add your method logic here
        const result = await this.connection.getRepository(ctx, Product).findOne({ where: { id } });
        return result;
    }

    async exportLowStockVariantsToCsv(ctx: RequestContext): Promise<string> {
        type RawRow = {
            variantId: string;
            sku: string;
            variantName: string;
            productId: string;
            stockOnHand: string;
            channels: string;
            dimensionWeightG: number | null;
        };

        const rows = await this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .innerJoin('variant.product', 'product')
            .leftJoin('variant.translations', 'translation', 'translation.languageCode = :lang', { lang: ctx.languageCode })
            .leftJoin('variant.stockLevels', 'stockLevel')
            .leftJoin('variant.channels', 'channel')
            .select([
                'variant.id AS "variantId"',
                'variant.sku AS "sku"',
                'translation.name AS "variantName"',
                'product.id AS "productId"',
                'COALESCE(SUM(stockLevel.stockOnHand), 0) AS "stockOnHand"',
                `STRING_AGG(DISTINCT channel.code, ', ') AS "channels"`,
                // PostgreSQL allows selecting non-grouped columns that are
                // functionally dependent on the grouped primary key (variant.id).
                'variant."customFieldsDimensionweightg" AS "dimensionWeightG"',
            ])
            .where('variant.deletedAt IS NULL')
            .andWhere('product.deletedAt IS NULL')
            .groupBy('variant.id')
            .addGroupBy('product.id')
            .addGroupBy('translation.name')
            .having('COALESCE(SUM(stockLevel.stockOnHand), 0) < :threshold', { threshold: LOW_STOCK_THRESHOLD })
            .orderBy('COALESCE(SUM(stockLevel.stockOnHand), 0)', 'ASC')
            .getRawMany<RawRow>();

        // Fetch first price row per variant (ordered by id so the result is stable)
        type PriceRow = { variantId: string; price: number; currencyCode: string };
        const variantIds = rows.map(r => r.variantId);
        const priceRows: PriceRow[] = variantIds.length > 0
            ? await this.connection.rawConnection.query(
                `SELECT DISTINCT ON ("variantId") "variantId", price, "currencyCode"
                 FROM product_variant_price
                 WHERE "variantId" = ANY($1::bigint[])
                 ORDER BY "variantId", id`,
                [variantIds],
              )
            : [];
        const priceMap = new Map<string, PriceRow>(
            priceRows.map(p => [String(p.variantId), p]),
        );

        const lines = ['variantId,productId,sku,variantName,stockOnHand,channels,currency,price,variant:dimensionWeightG'];
        for (const row of rows) {
            const p      = priceMap.get(String(row.variantId));
            const sku      = `"${(row.sku ?? '').replace(/"/g, '""')}"`;
            const name     = `"${(row.variantName ?? '').replace(/"/g, '""')}"`;
            const channels = `"${(row.channels ?? '').replace(/"/g, '""')}"`;
            const currency = p?.currencyCode ?? '';
            const price    = p?.price        ?? '';
            const weight   = row.dimensionWeightG ?? '';
            lines.push(`${row.variantId},${row.productId},${sku},${name},${row.stockOnHand},${channels},${currency},${price},${weight}`);
        }

        const outputDir = path.join(process.cwd(), 'exports');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(outputDir, `low-stock-variants-${timestamp}.csv`);
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        Logger.info(`Exported ${rows.length} low-stock variants (< ${LOW_STOCK_THRESHOLD}) to ${filePath}`, logCtx);
        return filePath;
    }

    async exportAllVariantsToCsv(ctx: RequestContext): Promise<string> {
        type RawRow = {
            variantId: string;
            sku: string;
            variantName: string;
            productId: string;
            stockOnHand: string;
            channels: string;
            dimensionWeightG: number | null;
            productGroups: string | null;
            variantOptions: string | null;
        };

        const rows = await this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .innerJoin('variant.product', 'product')
            .leftJoin('variant.translations', 'translation', 'translation.languageCode = :lang', { lang: ctx.languageCode })
            .leftJoin('variant.stockLevels', 'stockLevel')
            .leftJoin('variant.channels', 'channel')
            .leftJoin('product.facetValues', 'facetValue')
            .leftJoin('facetValue.facet', 'facet')
            .leftJoin('facetValue.translations', 'fvTranslation', 'fvTranslation.languageCode = :lang')
            .leftJoin('variant.options', 'option')
            .leftJoin('option.group', 'optionGroup')
            .leftJoin('option.translations', 'optionTranslation', 'optionTranslation.languageCode = :lang')
            .select([
                'variant.id AS "variantId"',
                'variant.sku AS "sku"',
                'translation.name AS "variantName"',
                'product.id AS "productId"',
                'COALESCE(SUM(DISTINCT stockLevel.stockOnHand), 0) AS "stockOnHand"',
                `STRING_AGG(DISTINCT channel.code, ', ') AS "channels"`,
                'variant."customFieldsDimensionweightg" AS "dimensionWeightG"',
                `STRING_AGG(DISTINCT facet.code || ':' || fvTranslation.name, '|') AS "productGroups"`,
                `STRING_AGG(DISTINCT optionGroup.code || ':' || optionTranslation.name, '|') AS "variantOptions"`,
            ])
            .where('variant.deletedAt IS NULL')
            .andWhere('product.deletedAt IS NULL')
            .groupBy('variant.id')
            .addGroupBy('product.id')
            .addGroupBy('translation.name')
            .orderBy('product.id', 'ASC')
            .addOrderBy('variant.id', 'ASC')
            .getRawMany<RawRow>();

        // Fetch first price row per variant (ordered by id so the result is stable)
        type PriceRow = { variantId: string; price: number; currencyCode: string };
        const variantIds = rows.map(r => r.variantId);
        const priceRows: PriceRow[] = variantIds.length > 0
            ? await this.connection.rawConnection.query(
                `SELECT DISTINCT ON ("variantId") "variantId", price, "currencyCode"
                 FROM product_variant_price
                 WHERE "variantId" = ANY($1::bigint[])
                 ORDER BY "variantId", id`,
                [variantIds],
              )
            : [];
        const priceMap = new Map<string, PriceRow>(
            priceRows.map(p => [String(p.variantId), p]),
        );

        const lines = ['productId,variantId,sku,variantName,stockOnHand,channels,currency,price,variant:dimensionWeightG,productGroups,variantOptions'];
        for (const row of rows) {
            const p             = priceMap.get(String(row.variantId));
            const sku           = `"${(row.sku ?? '').replace(/"/g, '""')}"`;
            const name          = `"${(row.variantName ?? '').replace(/"/g, '""')}"`;
            const channels      = `"${(row.channels ?? '').replace(/"/g, '""')}"`;
            const groups        = `"${(row.productGroups ?? '').replace(/"/g, '""')}"`;
            const options       = `"${(row.variantOptions ?? '').replace(/"/g, '""')}"`;
            const currency      = p?.currencyCode ?? '';
            const price         = p?.price        ?? '';
            const weight        = row.dimensionWeightG ?? '';
            lines.push(`${row.productId},${row.variantId},${sku},${name},${row.stockOnHand},${channels},${currency},${price},${weight},${groups},${options}`);
        }

        const outputDir = path.join(process.cwd(), 'exports');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(outputDir, `all-variants-${timestamp}.csv`);
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        Logger.info(`Exported ${rows.length} variants to ${filePath}`, logCtx);
        return filePath;
    }
}
