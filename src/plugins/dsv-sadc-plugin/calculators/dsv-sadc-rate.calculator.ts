import { ShippingCalculator, LanguageCode, Logger } from '@vendure/core';
import { loggerCtx } from '../constants';
import { resolveDsvSadcAutoQuote } from '../utils/dsv-sadc-auto-quote';

export const dsvSadcRateCalculator = new ShippingCalculator({
    code: 'dsv-sadc-rate',
    description: [
        { languageCode: LanguageCode.en, value: 'DSV SADC — rules-based rate (no live quote API)' },
    ],
    args: {
        minimumPerShipmentCents: {
            type: 'int',
            defaultValue: 3711,
            label: [{ languageCode: LanguageCode.en, value: 'Minimum per shipment (cents)' }],
            description: [{ languageCode: LanguageCode.en, value: 'Additive, not a floor — always added to the province rate.' }],
            ui: { component: 'currency-form-input' },
        },
        intraProvinceRateCents: {
            type: 'int',
            defaultValue: 4927,
            label: [{ languageCode: LanguageCode.en, value: 'Intra-province rate (cents)' }],
            ui: { component: 'currency-form-input' },
        },
        interProvinceRateCents: {
            type: 'int',
            defaultValue: 13709,
            label: [{ languageCode: LanguageCode.en, value: 'Inter-province rate (cents)' }],
            ui: { component: 'currency-form-input' },
        },
        originProvince: {
            type: 'string',
            defaultValue: 'Gauteng',
            label: [{ languageCode: LanguageCode.en, value: 'Origin province' }],
            description: [{ languageCode: LanguageCode.en, value: 'Warehouse province, used for the intra/inter-province test.' }],
        },
        liabilityBasisPoints: {
            type: 'int',
            defaultValue: 25,
            label: [{ languageCode: LanguageCode.en, value: 'Liability (basis points)' }],
            description: [{ languageCode: LanguageCode.en, value: '% of declared goods value, in basis points — 25 = 0.25%.' }],
            ui: { component: 'number-form-input', suffix: 'bps' },
        },
        liabilityMinimumCents: {
            type: 'int',
            defaultValue: 0,
            label: [{ languageCode: LanguageCode.en, value: 'Liability minimum (cents)' }],
            ui: { component: 'currency-form-input' },
        },
        fuelPercent: {
            type: 'float',
            defaultValue: 12.86,
            label: [{ languageCode: LanguageCode.en, value: 'Fuel surcharge (%)' }],
            description: [{ languageCode: LanguageCode.en, value: 'Changes monthly — keep this updated.' }],
            ui: { component: 'number-form-input', suffix: '%' },
        },
        fuelMinimumCents: {
            type: 'int',
            defaultValue: 1250,
            label: [{ languageCode: LanguageCode.en, value: 'Fuel minimum (cents)' }],
            ui: { component: 'currency-form-input' },
        },
        maxAutoQuoteKg: {
            type: 'float',
            defaultValue: 25,
            label: [{ languageCode: LanguageCode.en, value: 'Max auto-quote weight (kg)' }],
            description: [{ languageCode: LanguageCode.en, value: 'At or above this chargeable weight, price is POA — this method becomes ineligible. Auto-quote covers strictly less than this value (e.g. up to 24.999kg for a 25kg threshold).' }],
            ui: { component: 'number-form-input', suffix: 'kg' },
        },
        taxRate: {
            type: 'float',
            defaultValue: 15,
            label: [{ languageCode: LanguageCode.en, value: 'Tax rate (%)' }],
        },
    },

    calculate: async (ctx, order, args) => {
        const autoQuote = resolveDsvSadcAutoQuote(order, args.maxAutoQuoteKg ?? 25);
        if (!autoQuote.eligible) {
            Logger.info(
                `[rate] POA order=${order.code} reason=${autoQuote.reason} chargeableKg=${autoQuote.chargeableKg}`,
                loggerCtx,
            );
            return undefined;
        }
        const { chargeableKg } = autoQuote;

        // resolveDsvSadcAutoQuote already confirmed province is present when eligible.
        const deliveryProvince = order.shippingAddress!.province!;
        const originProvince = args.originProvince ?? 'Gauteng';
        const isInterProvince = deliveryProvince.trim().toLowerCase() !== originProvince.trim().toLowerCase();
        const rate = isInterProvince ? (args.interProvinceRateCents ?? 13709) : (args.intraProvinceRateCents ?? 4927);

        const base = Math.round((args.minimumPerShipmentCents ?? 3711) + rate);
        const liability = Math.max(
            args.liabilityMinimumCents ?? 0,
            Math.round((order.subTotal * (args.liabilityBasisPoints ?? 25)) / 10000),
        );
        const subtotal = base + liability;
        const fuel = Math.max(
            args.fuelMinimumCents ?? 1250,
            Math.round((subtotal * (args.fuelPercent ?? 12.86)) / 100),
        );
        const price = subtotal + fuel;

        Logger.info(
            `[rate] order=${order.code} isInterProvince=${isInterProvince} chargeableKg=${chargeableKg} ` +
            `base=${base} liability=${liability} fuel=${fuel} price=${price}`,
            loggerCtx,
        );

        return { price, priceIncludesTax: false, taxRate: args.taxRate ?? 15 };
    },
});
