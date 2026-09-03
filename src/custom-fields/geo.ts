import { LanguageCode, VendureConfig } from '@vendure/core';

type AddressCustomFields = NonNullable<NonNullable<VendureConfig['customFields']>['Address']>;

/**
 * Geo coordinates on Address.
 *
 * Consumed by:
 *   - dsv-sadc-plugin   reads them off `order.shippingAddress.customFields` in
 *                       `utils/address-converter.ts` and puts them in the
 *                       <coordinates> block of DSV's SubmitShipment call
 *
 * Storage is required rather than derivable: the storefront is the only party that
 * can capture precise device GPS, and the backend has nowhere to put what it sends
 * unless these columns exist. When they are absent the DSV plugin falls back to a
 * live DSV ValidateAddress lookup, which is only suburb-accurate.
 *
 * Declaring these on Address also extends OrderAddress — Vendure copies Address
 * custom fields onto the order's address snapshot — so expect columns on both
 * tables in the generated migration.
 */
export const geoAddressFields: AddressCustomFields = [
    {
        name: 'latitude',
        type: 'float',
        label: [{ languageCode: LanguageCode.en, value: 'Latitude' }],
        nullable: true,
        public: true,
    },
    {
        name: 'longitude',
        type: 'float',
        label: [{ languageCode: LanguageCode.en, value: 'Longitude' }],
        nullable: true,
        public: true,
    },
];
