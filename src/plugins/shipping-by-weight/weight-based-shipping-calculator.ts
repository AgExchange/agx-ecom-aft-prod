import { LanguageCode, ShippingCalculator } from '@vendure/core';
import { calculateTotalBillableWeightG } from './weight-based-shipping-eligibility-checker';

/**
 * Calculates shipping price from a tiered weight table.
 *
 * `weightTiersJson` is a JSON array of `{ maxWeightG: number; price: number }` objects,
 * sorted ascending by maxWeightG. The last entry acts as the catch-all for any
 * weight above the highest tier. Price values are in the channel's lowest currency
 * denomination (e.g. cents / kobo / pence).
 *
 * Example JSON:
 * [
 *   { "maxWeightG": 500,   "price": 5000  },
 *   { "maxWeightG": 2000,  "price": 8000  },
 *   { "maxWeightG": 5000,  "price": 15000 },
 *   { "maxWeightG": 10000, "price": 25000 }
 * ]
 */
export const weightBasedShippingCalculator = new ShippingCalculator({
    code: 'weight-based-shipping-calculator',
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Weight-based Shipping Calculator',
        },
    ],
    args: {
        weightTiersJson: {
            type: 'string',
            defaultValue: JSON.stringify([
                { maxWeightG: 500, price: 5000 },
                { maxWeightG: 2000, price: 8000 },
                { maxWeightG: 5000, price: 15000 },
                { maxWeightG: 10000, price: 25000 },
            ]),
            label: [{ languageCode: LanguageCode.en, value: 'Weight tiers (JSON)' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value:
                        'JSON array of { maxWeightG, price } tiers sorted ascending. ' +
                        'The last entry applies to any weight beyond the final threshold. ' +
                        'Price is in the smallest currency unit (e.g. cents).',
                },
            ],
            ui: { component: 'textarea-form-input' },
        },
        taxRate: {
            type: 'float',
            defaultValue: 0,
            label: [{ languageCode: LanguageCode.en, value: 'Tax rate (%)' }],
            ui: { component: 'number-form-input', suffix: '%' },
        },
        includesTax: {
            type: 'string',
            defaultValue: 'auto',
            label: [{ languageCode: LanguageCode.en, value: 'Price includes tax' }],
            ui: {
                component: 'select-form-input',
                options: [
                    { value: 'auto', label: [{ languageCode: LanguageCode.en, value: 'Auto (channel default)' }] },
                    { value: 'true', label: [{ languageCode: LanguageCode.en, value: 'Yes' }] },
                    { value: 'false', label: [{ languageCode: LanguageCode.en, value: 'No' }] },
                ],
            },
        },
    },
    calculate: (ctx, order, args) => {
        const totalWeightG = calculateTotalBillableWeightG(order);

        let tiers: Array<{ maxWeightG: number; price: number }> = [];
        try {
            tiers = JSON.parse(args.weightTiersJson as string);
        } catch {
            return { price: 0, taxRate: args.taxRate as number, priceIncludesTax: false };
        }

        if (!Array.isArray(tiers) || tiers.length === 0) {
            return { price: 0, taxRate: args.taxRate as number, priceIncludesTax: false };
        }

        const sorted = [...tiers].sort((a, b) => a.maxWeightG - b.maxWeightG);
        const tier = sorted.find(t => totalWeightG <= t.maxWeightG) ?? sorted[sorted.length - 1];

        const priceIncludesTax =
            args.includesTax === 'true'
                ? true
                : args.includesTax === 'false'
                ? false
                : ctx.channel.pricesIncludeTax;

        return {
            price: tier.price,
            taxRate: args.taxRate as number,
            priceIncludesTax,
        };
    },
});
