import { LanguageCode, ShippingEligibilityChecker } from '@vendure/core';

/**
 * Checks whether the order's total billable weight falls within the configured
 * min/max range. Set maxOrderWeightG to 0 to disable the upper limit.
 *
 * Billable weight per line = max(dimensionWeightG, dimensionVolumetricWeightG) × quantity.
 * Lines with no weight data count as 0 g.
 */
export const weightBasedShippingEligibilityChecker = new ShippingEligibilityChecker({
    code: 'weight-based-shipping-eligibility-checker',
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Weight-based Eligibility Checker',
        },
    ],
    args: {
        minOrderWeightG: {
            type: 'int',
            defaultValue: 0,
            label: [{ languageCode: LanguageCode.en, value: 'Minimum order weight (g)' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Order must weigh at least this many grams to be eligible. Use 0 for no minimum.',
                },
            ],
            ui: { component: 'number-form-input', suffix: 'g' },
        },
        maxOrderWeightG: {
            type: 'int',
            defaultValue: 0,
            label: [{ languageCode: LanguageCode.en, value: 'Maximum order weight (g)' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Order must not exceed this many grams. Use 0 for no maximum.',
                },
            ],
            ui: { component: 'number-form-input', suffix: 'g' },
        },
    },
    check: (ctx, order, args) => {
        const totalWeightG = calculateTotalBillableWeightG(order);
        if (totalWeightG < args.minOrderWeightG) return false;
        if (args.maxOrderWeightG > 0 && totalWeightG > args.maxOrderWeightG) return false;
        return true;
    },
});

export function calculateTotalBillableWeightG(order: { lines: Array<any> }): number {
    return order.lines.reduce((sum: number, line: any) => {
        const cf = line.productVariant?.customFields;
        const actualWeight: number = cf?.dimensionWeightG ?? 0;
        const volWeight: number = cf?.dimensionVolumetricWeightG ?? 0;
        const billableWeight = Math.max(actualWeight, volWeight);
        return sum + billableWeight * line.quantity;
    }, 0);
}
