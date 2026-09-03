import { LanguageCode, PaymentMethodEligibilityChecker, PaymentMethodHandler } from '@vendure/core';

import { SETTLEMENT_HANDLER_CODE } from '../constants';

/**
 * Gates the settlement PaymentMethod out of `eligiblePaymentMethods` (and, since
 * PaymentService.createPayment runs this same checker before invoking the handler, out of
 * `addPaymentToOrder` too) for any non-admin caller. This is the actual mechanism that keeps
 * the method invisible/unusable on the storefront — a PaymentMethod entity must belong to some
 * Channel to exist at all (channel-aware), so "never assign it to a channel" alone cannot hide
 * it; this checker is what does. mv-settlement-payment-handler's own apiType guard is
 * defense-in-depth, not the primary boundary.
 */
export const mvSettlementPaymentEligibilityChecker = new PaymentMethodEligibilityChecker({
    code: 'mv-internal-settlement-eligibility-checker',
    description: [
        { languageCode: LanguageCode.en, value: 'Restricts the multivendor settlement method to admin-context use only' },
    ],
    args: {},
    check: ctx => ctx.apiType === 'admin',
});

/**
 * Internal, no-op "settlement" payment used exclusively on Seller Orders.
 *
 * The marketplace collects one real payment (via the existing PayFast/Paystack plugins,
 * unmodified) on the Aggregate Order. This handler never talks to a gateway and never moves
 * real money — it exists only so a Seller Order can satisfy Vendure's default OrderProcess
 * payment-coverage checks and progress through fulfillment. Platform-fee/payout bookkeeping is
 * handled separately by mv-order-seller-strategy.ts.
 *
 * SECURITY: `createPayment` only succeeds for `ctx.apiType === 'admin'`. This is load-bearing,
 * not decorative — Vendure's shop-api `addPaymentToOrder` resolves the *code* of any registered
 * PaymentMethodHandler globally (PaymentService.createPayment looks the handler up by code with
 * no channel-eligibility gate unless the PaymentMethod itself declares a checker), so without
 * this guard a customer could call `addPaymentToOrder(method: "mv-internal-settlement")` on
 * their own active order and get it marked Settled for free, bypassing the real gateway
 * entirely. The corresponding PaymentMethod row is also never assigned to any Channel's
 * available payment methods (see multivendor.plugin.ts's onApplicationBootstrap), which keeps
 * it out of `eligiblePaymentMethods`, but that alone would not stop a direct
 * `addPaymentToOrder` call — this apiType check is the actual protection.
 */
export const mvSettlementPaymentHandler = new PaymentMethodHandler({
    code: SETTLEMENT_HANDLER_CODE,
    description: [
        { languageCode: LanguageCode.en, value: 'Multivendor internal settlement (not customer-facing)' },
    ],
    args: {},

    createPayment(ctx, order, amount, _args, metadata) {
        if (ctx.apiType !== 'admin') {
            return {
                amount,
                state: 'Error' as const,
                errorMessage: 'This payment method is for internal use only.',
            };
        }
        return {
            amount,
            state: 'Settled' as const,
            transactionId: `internal-settlement-${order.code}`,
            metadata: {
                public: {},
                note: metadata?.note ?? 'Internal bookkeeping — funded by the aggregate order payment.',
            },
        };
    },

    settlePayment() {
        return { success: true };
    },

    cancelPayment() {
        return { success: true };
    },
});
