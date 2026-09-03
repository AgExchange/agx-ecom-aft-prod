import { VendureConfig } from '@vendure/core';

import { channelContactFields } from './channel-contacts';
import { geoAddressFields } from './geo';
import { logisticsProductVariantFields } from './logistics';
import { orderMetadataOrderLineFields } from './order-metadata';
import { productContentFields } from './product-content';

/**
 * Custom field definitions, composed from one module per domain.
 *
 * Add a new domain by creating a sibling module that exports an array of field
 * definitions, then spreading it into the relevant entity below. Field names
 * must remain unique per entity, so keep them domain-prefixed.
 *
 * A field used by exactly one plugin belongs in that plugin. A field shared
 * across plugins belongs here.
 */
export const customFields: VendureConfig['customFields'] = {
    Address: [
        ...geoAddressFields,
    ],
    Channel: [
        ...channelContactFields,
    ],
    OrderLine: [
        ...orderMetadataOrderLineFields,
    ],
    Product: [
        ...productContentFields,
    ],
    ProductVariant: [
        ...logisticsProductVariantFields,
    ],
};
