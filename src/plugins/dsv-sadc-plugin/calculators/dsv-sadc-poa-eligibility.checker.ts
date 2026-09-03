import { ShippingEligibilityChecker, LanguageCode } from '@vendure/core';
import { resolveDsvSadcAutoQuote } from '../utils/dsv-sadc-auto-quote';

/** Eligibility gate for the "DSV SADC — Quote on Request" companion ShippingMethod —
 *  eligible exactly when the main `dsv-sadc-rate` calculator is NOT auto-quotable
 *  (cross-border, over-weight, or missing delivery province). Shares
 *  resolveDsvSadcAutoQuote with that calculator so the two methods can never drift out of
 *  sync — one is always exactly the inverse of the other. `maxAutoQuoteKg` should be set
 *  to match the main method's own arg of the same name. */
export const dsvSadcPoaEligibilityChecker = new ShippingEligibilityChecker({
    code: 'dsv-sadc-poa-eligibility',
    description: [
        { languageCode: LanguageCode.en, value: 'DSV SADC — eligible only when the flat-rate calculator would be POA (cross-border, over-weight, or missing province)' },
    ],
    args: {
        maxAutoQuoteKg: {
            type: 'float',
            defaultValue: 25,
            label: [{ languageCode: LanguageCode.en, value: 'Max auto-quote weight (kg)' }],
            description: [{ languageCode: LanguageCode.en, value: 'Must match the main DSV SADC method\'s "Max auto-quote weight (kg)" value.' }],
            ui: { component: 'number-form-input', suffix: 'kg' },
        },
    },
    check: (ctx, order, args) => {
        return !resolveDsvSadcAutoQuote(order, args.maxAutoQuoteKg ?? 25).eligible;
    },
});
