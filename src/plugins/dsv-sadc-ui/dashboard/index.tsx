import { defineDashboardExtension } from '@vendure/dashboard';
import { DsvSadcTrackingEntry } from './components/DsvSadcTrackingEntry';
import { DsvSadcLabels } from './components/DsvSadcLabels';

/**
 * DsvSadcUiPlugin — Dashboard extension entry point.
 *
 * Registers the render component for the custom `DSV_SADC_TRACKING` order
 * history entries emitted by the DSV SADC webhook (see the
 * `@agxchange/vendure-plugin-dsv-sadc` backend package).
 *
 * This lives in a separate in-tree plugin rather than inside the DSV backend
 * package because that package compiles as backend-only CommonJS (no JSX/React/
 * DOM). Dashboard `.tsx` extensions are compiled by Vite / tsconfig.dashboard.
 *
 * The `type` must match the `DSV_SADC_TRACKING` constant declared in the
 * backend package's `types/history.types.ts`.
 */
defineDashboardExtension({
    historyEntries: [
        {
            type: 'DSV_SADC_TRACKING',
            component: DsvSadcTrackingEntry,
        },
    ],
    // "DSV Labels" block on the Order detail page, directly after the native
    // fulfillment-details block — a per-fulfillment on-demand label download.
    pageBlocks: [
        {
            id: 'dsv-sadc-labels',
            title: 'DSV Labels',
            location: {
                pageId: 'order-detail',
                column: 'side',
                position: {
                    blockId: 'fulfillment-details',
                    order: 'after',
                },
            },
            component: DsvSadcLabels,
        },
    ],
});
