import { LanguageCode, VendureConfig } from '@vendure/core';

type OrderLineCustomFields = NonNullable<NonNullable<VendureConfig['customFields']>['OrderLine']>;

/**
 * Machine metadata captured from the customer during checkout and denormalised
 * onto each OrderLine, so fulfilment staff can identify a part without having to
 * look up the product.
 *
 * Consumed by:
 *   - order-metadata-ui   renders these as the "Part Metadata" block on the
 *                         order detail page
 *
 * Every field carries `ui: { dashboard: false }`. They are deliberately hidden
 * from the standard custom-field form — the dashboard extension presents them
 * itself, grouped by category. Removing that flag would render all fourteen as a
 * flat card *as well as* in the block.
 *
 * Field order determines the order of ADD COLUMN statements in generated
 * migrations.
 */
export const orderMetadataOrderLineFields: OrderLineCustomFields = [
    // ── Category Identifier ──────────────────────────────────────────────
    // Denormalises the product's classification facet onto the order line so
    // fulfilment staff can identify the metadata type without a product lookup.
    {
        name: 'metadataCategory',
        type: 'string',
        label: [{ languageCode: LanguageCode.en, value: 'Metadata Category' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Product category type driving metadata collection: axle | engine | filter. ' +
                   'Derived from the "classification" facet on the ordered variant.',
        }],
        nullable: true,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },

    // ── Shared Machine Fields (Axle, Engine, Filter) ─────────────────────
    {
        name: 'machineBrand',
        type: 'string',
        label: [{ languageCode: LanguageCode.en, value: 'Machine Brand' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Make / brand of the machine for which this part is ordered. ' +
                   'Applies to: Axle, Engine, Filter categories.',
        }],
        nullable: true,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },
    {
        name: 'machineModel',
        type: 'string',
        label: [{ languageCode: LanguageCode.en, value: 'Machine Model' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Model designation of the machine for which this part is ordered. ' +
                   'Applies to: Axle, Engine, Filter categories.',
        }],
        nullable: true,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },

    // ── Axle-Specific Fields ─────────────────────────────────────────────
    {
        name: 'serialNumber',
        type: 'string',
        label: [{ languageCode: LanguageCode.en, value: 'Machine Serial Number' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Chassis / machine serial number. Required for Axle category orders ' +
                   'to confirm the correct axle specification.',
        }],
        nullable: true,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },
    {
        name: 'serialNumberPhotoAssetId',
        type: 'string',
        label: [{ languageCode: LanguageCode.en, value: 'Serial Number Photo (Asset ID)' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Vendure Asset ID of the uploaded serial-number-plate photo. ' +
                   'Upload the image first via the createAssets mutation to obtain the ' +
                   'Asset ID, then store that ID here. Applies to Axle category only.',
        }],
        nullable: true,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },

    // ── Engine-Specific Fields ───────────────────────────────────────────
    {
        name: 'engineApplication',
        type: 'string',
        label: [{ languageCode: LanguageCode.en, value: 'Engine Application' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Intended application of the engine, e.g. Generator, Tractor, Pump, ' +
                   'Combine Harvester. Applies to Engine category only.',
        }],
        nullable: true,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },
    {
        name: 'engineNumber',
        type: 'string',
        label: [{ languageCode: LanguageCode.en, value: 'Engine Number' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Engine serial / identification number stamped on the block. ' +
                   'Applies to Engine category only.',
        }],
        nullable: true,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },

    // ── Filter-Specific Fields (boolean flags) ───────────────────────────
    // Each line item represents exactly ONE filter type — only one flag is true
    // per addItemToOrder call. Multiple filter types for the same machine require
    // separate addItemToOrder calls, one line per type.
    //
    // `defaultValue: false` is applied by Vendure's CustomFieldProcessingInterceptor
    // on addItemToOrder, so the storefront does not need to send omitted flags
    // explicitly as false.
    {
        name: 'filterAirInner',
        type: 'boolean',
        label: [{ languageCode: LanguageCode.en, value: 'Filter: Air Inner' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'True when this line item is an Air Inner filter element. ' +
                   'Applies to Filter category only. Only one filter flag is true per line.',
        }],
        defaultValue: false,
        nullable: false,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },
    {
        name: 'filterAirOuter',
        type: 'boolean',
        label: [{ languageCode: LanguageCode.en, value: 'Filter: Air Outer' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'True when this line item is an Air Outer filter element. ' +
                   'Applies to Filter category only. Only one filter flag is true per line.',
        }],
        defaultValue: false,
        nullable: false,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },
    {
        name: 'filterFuel',
        type: 'boolean',
        label: [{ languageCode: LanguageCode.en, value: 'Filter: Fuel' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'True when this line item is a Fuel filter element. ' +
                   'Applies to Filter category only. Only one filter flag is true per line.',
        }],
        defaultValue: false,
        nullable: false,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },
    {
        name: 'filterHydraulic',
        type: 'boolean',
        label: [{ languageCode: LanguageCode.en, value: 'Filter: Hydraulic' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'True when this line item is a Hydraulic filter element. ' +
                   'Applies to Filter category only. Only one filter flag is true per line.',
        }],
        defaultValue: false,
        nullable: false,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },
    {
        name: 'filterOil',
        type: 'boolean',
        label: [{ languageCode: LanguageCode.en, value: 'Filter: Oil' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'True when this line item is an Oil filter element. ' +
                   'Applies to Filter category only. Only one filter flag is true per line.',
        }],
        defaultValue: false,
        nullable: false,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },
    {
        name: 'filterSteering',
        type: 'boolean',
        label: [{ languageCode: LanguageCode.en, value: 'Filter: Steering' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'True when this line item is a Steering / power-steering filter element. ' +
                   'Applies to Filter category only. Only one filter flag is true per line.',
        }],
        defaultValue: false,
        nullable: false,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },
    {
        name: 'filterTransmission',
        type: 'boolean',
        label: [{ languageCode: LanguageCode.en, value: 'Filter: Transmission' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'True when this line item is a Transmission filter element. ' +
                   'Applies to Filter category only. Only one filter flag is true per line.',
        }],
        defaultValue: false,
        nullable: false,
        public: true,
        readonly: false,
        ui: { dashboard: false },
    },
];
