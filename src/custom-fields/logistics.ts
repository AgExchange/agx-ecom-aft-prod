import { LanguageCode, VendureConfig } from '@vendure/core';

type ProductVariantCustomFields = NonNullable<NonNullable<VendureConfig['customFields']>['ProductVariant']>;

/**
 * Logistics dimensions for ProductVariant.
 *
 * Shared across several plugins, which is why they are declared here rather than
 * inside any single plugin:
 *   - shipping-by-weight  reads dimensionWeightG / dimensionVolumetricWeightG
 *   - pim-sync            writes dimensionWeightG from AtroPIM
 *   - product-info        reads variant."customFieldsDimensionweightg" in raw SQL
 *   - DSV courier plugins read the L/W/H dimensions
 *
 * Field order is significant: it determines the order of inputs in the dashboard
 * form and the order of ADD COLUMN statements in generated migrations.
 */
export const logisticsProductVariantFields: ProductVariantCustomFields = [
    // ── Logistics Dimensions ─────────────────────────────────────────
    // Dashboard tab: 'Logistics' groups these fields visually.
    {
        name: 'dimensionWeightG',
        type: 'int',
        label: [{ languageCode: LanguageCode.en, value: 'Weight (g)' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Gross packed weight of the variant in GRAMS. ' +
                   'Used by shipping calculators and courier APIs.',
        }],
        min: 0,
        nullable: true,
        public: true,           // Visible on Shop API
        ui: {
            tab: 'Logistics',
            component: 'number-form-input',
            suffix: 'g',
        },
    },
    {
        name: 'dimensionLengthMm',
        type: 'int',
        label: [{ languageCode: LanguageCode.en, value: 'Length (mm)' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Longest edge of the packed parcel in MILLIMETRES.',
        }],
        min: 0,
        nullable: true,
        public: true,
        ui: {
            tab: 'Logistics',
            component: 'number-form-input',
            suffix: 'mm',
        },
    },
    {
        name: 'dimensionWidthMm',
        type: 'int',
        label: [{ languageCode: LanguageCode.en, value: 'Width (mm)' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Second longest edge of the packed parcel in MILLIMETRES.',
        }],
        min: 0,
        nullable: true,
        public: true,
        ui: {
            tab: 'Logistics',
            component: 'number-form-input',
            suffix: 'mm',
        },
    },
    {
        name: 'dimensionHeightMm',
        type: 'int',
        label: [{ languageCode: LanguageCode.en, value: 'Height (mm)' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Shortest edge / depth of the packed parcel in MILLIMETRES.',
        }],
        min: 0,
        nullable: true,
        public: true,
        ui: {
            tab: 'Logistics',
            component: 'number-form-input',
            suffix: 'mm',
        },
    },
    {
        name: 'dimensionVolumetricWeightG',
        type: 'int',
        label: [{ languageCode: LanguageCode.en, value: 'Volumetric Weight (g)' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Pre-calculated volumetric weight in GRAMS. ' +
                   'Formula: (L × W × H) / 5,000,000 × 1,000. ' +
                   'Billable weight = max(actual, volumetric).',
        }],
        min: 0,
        nullable: true,
        public: true,
        readonly: false,        // Can be set manually or via AtroPIM import
        ui: {
            tab: 'Logistics',
            component: 'number-form-input',
            suffix: 'g',
        },
    },
];
