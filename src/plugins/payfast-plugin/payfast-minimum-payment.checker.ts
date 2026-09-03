import { LanguageCode, PaymentMethodEligibilityChecker } from '@vendure/core';

/**
 * PayFast enforces its own minimum transaction amount per payment method — around R5 for
 * EFT/Card/most methods, but only R1 for Mobicred. Below that threshold, PayFast's checkout
 * platform silently reroutes the transaction to whichever method can process it (Mobicred),
 * ignoring the `payment_method` restriction entirely — indistinguishable from a broken
 * payment-method selector unless you already know about this. Gate it here rather than relying
 * on PayFast's own undocumented fallback behaviour.
 */
export const payFastMinimumPaymentEligibilityChecker = new PaymentMethodEligibilityChecker({
    code: 'payfast-minimum-payment-eligibility-checker',
    description: [{ languageCode: LanguageCode.en, value: 'PayFast — Minimum Order Amount' }],
    args: {
        minimumAmount: {
            type: 'int',
            defaultValue: 500,
            ui: { component: 'currency-form-input' },
            label: [{ languageCode: LanguageCode.en, value: 'Minimum order total' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value:
                        "Orders below this total are not eligible for PayFast. PayFast enforces its own " +
                        'minimum per payment method (around R5 for EFT/Card, R1 for Mobicred) — below that, ' +
                        "PayFast silently reroutes to whichever method qualifies instead of honouring the " +
                        'customer\'s selection. Default is R5.',
                },
            ],
        },
    },
    check: (ctx, order, args, method) => {
        if (order.totalWithTax >= args.minimumAmount) return true;
        const minimumMajorUnits = (args.minimumAmount / 100).toFixed(2);
        return `Order total must be at least ${order.currencyCode} ${minimumMajorUnits} to pay via ${method.name}`;
    },
});
