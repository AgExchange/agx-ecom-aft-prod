import { VendurePlugin } from '@vendure/core';

/**
 * DsvSadcUiPlugin
 *
 * Dashboard-only plugin that registers a custom timeline component for the
 * `DSV_SADC_TRACKING` order history entries created by the DSV SADC shipping
 * webhook. The component localises the DSV event timestamp (stored as canonical
 * UTC) to the viewer's timezone.
 *
 * The backend counterpart — the custom history entry type, its GraphQL enum
 * member, and the webhook that emits it — lives in the
 * `@agxchange/vendure-plugin-dsv-sadc` package. This plugin carries no backend
 * logic and no database entities; it is purely a Dashboard UI extension (same
 * pattern as OrderMetadataUiPlugin).
 */
@VendurePlugin({
    dashboard: './dashboard/index.tsx',
})
export class DsvSadcUiPlugin {}
