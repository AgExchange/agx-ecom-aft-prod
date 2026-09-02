import { defineDashboardExtension } from '@vendure/dashboard';
import { OrderLineMetadataBlock } from './components/OrderLineMetadataBlock';

/**
 * OrderMetadataUiPlugin — Dashboard extension entry point.
 *
 * No extendDetailDocument needed. The order-detail page calls:
 *   addCustomFields(orderDetailDocument, { includeNestedFragments: ['OrderLine'] })
 * in order-detail-shared.tsx:80, which automatically populates
 * context.entity.lines[].customFields for all registered OrderLine custom fields.
 *
 * Vendure source reference:
 *   packages/dashboard/src/app/routes/_authenticated/_orders/components/order-detail-shared.tsx:80
 *
 * Integration points:
 *   defineDashboardExtension     — @vendure/dashboard
 *   DashboardPageBlockDefinition — pageId: 'order-detail', blockId: 'order-table'
 *   context.entity               — Order with lines[].customFields pre-populated
 */
defineDashboardExtension({
    pageBlocks: [
        {
            id: 'order-line-metadata',
            title: 'Part Metadata',
            location: {
                pageId: 'order-detail',
                column: 'main',
                position: {
                    blockId: 'order-table',
                    order: 'after',
                },
            },
            component: OrderLineMetadataBlock,
        },
    ],
});
