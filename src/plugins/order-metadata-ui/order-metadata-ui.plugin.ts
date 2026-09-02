import { VendurePlugin } from '@vendure/core';

/**
 * OrderMetadataUiPlugin
 *
 * Adds a "Part Metadata" page block to the order detail page in the
 * Vendure Dashboard. The block displays the category-specific machine
 * metadata (Axle, Engine, Filter) that was collected from the customer
 * during checkout and persisted as custom fields on each OrderLine.
 *
 * This plugin has no database entities and no API extensions.
 * It is purely a Dashboard UI extension.
 *
 * Vendure integration point:
 *   @vendure/core VendurePlugin — dashboard property
 *   https://docs.vendure.io/current/core/extending-the-dashboard/extending-overview
 */
@VendurePlugin({
    compatibility: '^3.0.0',
    dashboard: './dashboard/index.tsx',
})
export class OrderMetadataUiPlugin {}
