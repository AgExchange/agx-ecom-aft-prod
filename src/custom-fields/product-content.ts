import { LanguageCode, VendureConfig } from '@vendure/core';

type ProductCustomFields = NonNullable<NonNullable<VendureConfig['customFields']>['Product']>;

/**
 * Product content and catalogue-identity fields.
 *
 * Consumed by:
 *   - pim-sync    writes `detail` (product-upsert.service.ts:578,640), `specification`
 *                 and `mpn`; uses `mpn` as the key to locate the Vendure Product
 *   - storefront  reads `seoTitle` / `seoDescription` via the Shop API
 *
 * `seoTitle` and `seoDescription` have no consumer inside this repo — nothing in
 * the backend reads them. They are ported anyway because they are part of the
 * product content model the storefront depends on, and omitting them would make
 * this backend non-equivalent to the one currently in production.
 *
 * `detail` and `specification` are `localeText`, so they live in
 * `product_translation`, not `product`. `mpn` is a plain `string` on `product`.
 */
export const productContentFields: ProductCustomFields = [
    {
        name: 'detail',
        type: 'localeText',
        label: [{ languageCode: LanguageCode.en, value: 'Detail' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'Technical details or additional product information.',
        }],
        nullable: true,
        public: true,
        ui: { component: 'rich-text-form-input' },
    },
    {
        name: 'specification',
        type: 'localeText',
        label: [{ languageCode: LanguageCode.en, value: 'Specification' }],
        public: true,
        ui: { component: 'rich-text-form-input' },
    },
    {
        name: 'seoTitle',
        type: 'localeString',
        label: [{ languageCode: LanguageCode.en, value: 'SEO Title' }],
    },
    {
        name: 'seoDescription',
        type: 'localeString',
        label: [{ languageCode: LanguageCode.en, value: 'SEO Description' }],
    },
    {
        // Canonical key linking all variants of a product across alternate-part
        // sources. In the PIM the OEM has SKU = MPN and variants have SKU = MPN+suffix;
        // the sync writes this and uses it as the primary key to find the Vendure
        // Product (independent of SKU/slug).
        //
        // NOTE: this column is indexed, but the index is NOT declared here — Vendure's
        // custom field config supports `unique` but has no `index` option, so the index
        // is created by a hand-written statement in the stage-2 migration. TypeORM's
        // metadata therefore does not know it exists, and every future
        // `vendure migrate -g` will try to DROP it. See docs/plugins/pim-sync.md
        // ("The mpn index and migration drift") before running the generator.
        name: 'mpn',
        type: 'string',
        label: [{ languageCode: LanguageCode.en, value: 'Manufacturer Part Number (MPN)' }],
        description: [{
            languageCode: LanguageCode.en,
            value: 'PIM Manufacturer Part Number — canonical key linking all variants of this ' +
                   'product. Set automatically by PIM sync; do not edit manually.',
        }],
        nullable: true,
        public: false,   // admin-only — not exposed in the Shop API
        readonly: true,  // dashboard form only; programmatic ProductService writes still work
        ui: { tab: 'PIM' },
    },
];
