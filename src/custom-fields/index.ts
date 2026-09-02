import { VendureConfig } from '@vendure/core';

import { logisticsProductVariantFields } from './logistics';

/**
 * Custom field definitions, composed from one module per domain.
 *
 * Add a new domain by creating a sibling module that exports an array of field
 * definitions, then spreading it into the relevant entity below. Field names
 * must remain unique per entity, so keep them domain-prefixed.
 */
export const customFields: VendureConfig['customFields'] = {
    ProductVariant: [
        ...logisticsProductVariantFields,
    ],
};
