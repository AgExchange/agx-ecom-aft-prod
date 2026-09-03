import { CreateRefundResult, Injector, LanguageCode, Logger, PaymentMethodHandler } from '@vendure/core';

import { PAYFAST_HANDLER_CODE, loggerCtx } from './constants';
import { PayFastService } from './payfast.service';

let payFastService: PayFastService;

/**
 * PaymentMethodHandler for PayFast.
 *
 * Supports two flows:
 *
 * Flow A — Standard Vendure off-site pattern (addPaymentToOrder):
 *  1. Storefront calls addPaymentToOrder(input: { method: "payfast", metadata: { returnUrl, cancelUrl } })
 *  2. createPayment() builds the PayFast redirect URL, returns Authorized state.
 *  3. Storefront reads payment.metadata.public.redirectUrl and redirects the browser.
 *  4. PayFast sends ITN to /payments/payfast/notify.
 *  5. handleITN() finds the Authorized payment and transitions it to Settled.
 *
 * Flow B — Headless mutation pattern (createPayFastPaymentIntent):
 *  1. Storefront calls createPayFastPaymentIntent(input: { returnUrl, cancelUrl }).
 *  2. Service returns a redirectUrl directly — no payment record is created yet.
 *  3. PayFast sends ITN to /payments/payfast/notify.
 *  4. handleITN() calls addPaymentToOrder (admin context); createPayment() returns Settled immediately.
 */
export const payFastPaymentHandler = new PaymentMethodHandler({
    code: PAYFAST_HANDLER_CODE,
    description: [{ languageCode: LanguageCode.en, value: 'PayFast' }],
    args: {
        merchantId:  { type: 'string' as const, required: true, label: [{ languageCode: LanguageCode.en, value: 'Merchant ID' }] },
        merchantKey: { type: 'string' as const, required: true, label: [{ languageCode: LanguageCode.en, value: 'Merchant Key' }] },
        passphrase:  { type: 'string' as const, label: [{ languageCode: LanguageCode.en, value: 'Passphrase' }] },
        sandbox:     { type: 'boolean' as const, defaultValue: false, label: [{ languageCode: LanguageCode.en, value: 'Use sandbox.payfast.co.za (test mode)' }] },
        ef:  { type: 'boolean' as const, defaultValue: true,  label: [{ languageCode: LanguageCode.en, value: 'EFT – Electronic Funds Transfer' }] },
        cc:  { type: 'boolean' as const, defaultValue: true,  label: [{ languageCode: LanguageCode.en, value: 'Credit Card' }] },
        dc:  { type: 'boolean' as const, defaultValue: true,  label: [{ languageCode: LanguageCode.en, value: 'Debit Card' }] },
        mp:  { type: 'boolean' as const, defaultValue: false, label: [{ languageCode: LanguageCode.en, value: 'Masterpass Scan to Pay' }] },
        mc:  { type: 'boolean' as const, defaultValue: true,  label: [{ languageCode: LanguageCode.en, value: 'Mobicred' }] },
        sc:  { type: 'boolean' as const, defaultValue: false, label: [{ languageCode: LanguageCode.en, value: 'SCode' }] },
        ss:  { type: 'boolean' as const, defaultValue: true,  label: [{ languageCode: LanguageCode.en, value: 'SnapScan' }] },
        zp:  { type: 'boolean' as const, defaultValue: true,  label: [{ languageCode: LanguageCode.en, value: 'Zapper' }] },
        mt:  { type: 'boolean' as const, defaultValue: true,  label: [{ languageCode: LanguageCode.en, value: 'MoreTyme' }] },
        rc:  { type: 'boolean' as const, defaultValue: false, label: [{ languageCode: LanguageCode.en, value: 'Store Card' }] },
        mu:  { type: 'boolean' as const, defaultValue: false, label: [{ languageCode: LanguageCode.en, value: 'Mukuru' }] },
        ap:  { type: 'boolean' as const, defaultValue: true,  label: [{ languageCode: LanguageCode.en, value: 'Apple Pay' }] },
        sp:  { type: 'boolean' as const, defaultValue: false, label: [{ languageCode: LanguageCode.en, value: 'Samsung Pay' }] },
        cp:  { type: 'boolean' as const, defaultValue: true,  label: [{ languageCode: LanguageCode.en, value: 'Capitec Pay' }] },
        gp:  { type: 'boolean' as const, defaultValue: true,  label: [{ languageCode: LanguageCode.en, value: 'Google Pay' }] },
        pf:  { type: 'boolean' as const, defaultValue: false, label: [{ languageCode: LanguageCode.en, value: 'Payflex (Buy Now, Pay Later)' }] },
    },

    init(injector: Injector) {
        payFastService = injector.get(PayFastService);
        Logger.info(`PayFast payment handler initialised (code: "${PAYFAST_HANDLER_CODE}")`, loggerCtx);
    },

    createPayment(ctx, order, amount, args, metadata) {
        if (ctx.apiType === 'admin') {
            // Flow B — called by handleITN via addPaymentToOrder (admin context).
            // Payment is already verified; settle immediately.
            Logger.info(`[createPayment] Admin context — settling immediately for order ${order.code}`, loggerCtx);
            return {
                amount,
                state: 'Settled' as const,
                transactionId: String(metadata.pfPaymentId),
                metadata: {
                    pfPaymentId: metadata.pfPaymentId,
                    amountGross: metadata.amountGross,
                    amountFee: metadata.amountFee,
                    amountNet: metadata.amountNet,
                    paymentStatus: metadata.paymentStatus,
                    nameFirst: metadata.nameFirst,
                    nameLast: metadata.nameLast,
                    emailAddress: metadata.emailAddress,
                    public: metadata.public,
                },
            };
        }

        // Flow A — called from shop API via addPaymentToOrder.
        // Build the PayFast redirect URL and return Authorized.
        // The storefront must pass returnUrl and cancelUrl in the metadata field.
        const returnUrl = metadata?.returnUrl as string | undefined;
        const cancelUrl = metadata?.cancelUrl as string | undefined;
        const paymentMethod = metadata?.paymentMethod as string | undefined;

        Logger.info(
            `[createPayment] Shop context — order ${order.code}, returnUrl: ${returnUrl}, cancelUrl: ${cancelUrl}, ` +
            `paymentMethod: ${paymentMethod ?? '(none — all account-enabled methods will be offered)'}`,
            loggerCtx,
        );

        if (!returnUrl || !cancelUrl) {
            Logger.error(
                `[createPayment] Missing returnUrl or cancelUrl in metadata for order ${order.code}. ` +
                `Pass them in addPaymentToOrder metadata: { returnUrl: "...", cancelUrl: "..." }`,
                loggerCtx,
            );
            return {
                amount,
                state: 'Error' as const,
                errorMessage: 'PayFast requires returnUrl and cancelUrl in payment metadata.',
            };
        }

        try {
            Logger.info(
                `[createPayment] merchant_id: ${args.merchantId}, sandbox: ${args.sandbox}`,
                loggerCtx,
            );
            const formData = payFastService.buildFormData(
                order.code,
                order.totalWithTax,
                order.customer,
                ctx.channel.token,
                { returnUrl, cancelUrl },
                {
                    merchantId: args.merchantId,
                    merchantKey: args.merchantKey,
                    passphrase: args.passphrase,
                    sandbox: args.sandbox,
                },
                paymentMethod as any,
            );
            const payfastUrl = payFastService.getPayFastUrl(args.sandbox);
            const redirectUrl = payFastService.buildRedirectUrl(formData, payfastUrl);

            Logger.info(`[createPayment] POST-redirect URL built for order ${order.code}`, loggerCtx);

            return {
                amount,
                state: 'Authorized' as const,
                transactionId: order.code,
                metadata: {
                    public: { redirectUrl },
                },
            };
        } catch (e: any) {
            Logger.error(`[createPayment] Error building form data: ${e.message}`, loggerCtx);
            return {
                amount,
                state: 'Error' as const,
                errorMessage: e.message,
            };
        }
    },

    settlePayment() {
        return { success: true };
    },

    cancelPayment() {
        return { success: true };
    },

    /**
     * Processes a refund via the official PayFast Refunds API.
     * Ref: developers.payfast.co.za/api#refund-create
     *
     * Flow:
     *  1. Queries the payment (GET /refunds/query/:id) — checks REFUNDABLE status.
     *  2. PAYMENT_SOURCE (card/wallet) → auto-refund → returns Settled.
     *     BANK_PAYOUT → bank details not available in Vendure's refund dialog
     *                → returns Pending so admin can process via PayFast dashboard.
     *
     * The pf_payment_id is stored in payment.transactionId (set at ITN settlement).
     * Amount is in cents — PayFast API accepts integer cents directly.
     */
    async createRefund(ctx, input, amount, order, payment, args) {
        const pfPaymentId = payment.transactionId;

        Logger.info(
            `[createRefund] Order ${order.code} — refunding ${amount} cents, pf_payment_id: ${pfPaymentId}`,
            loggerCtx,
        );

        if (!pfPaymentId) {
            Logger.error(`[createRefund] No pf_payment_id on payment ${payment.id}`, loggerCtx);
            return {
                state: 'Failed' as const,
                metadata: { error: 'No PayFast payment ID found on this payment record' },
            };
        }

        const result = await payFastService.processRefund(
            pfPaymentId,
            amount,
            input.reason || 'Refund',
            {
                merchantId: args.merchantId,
                merchantKey: args.merchantKey,
                passphrase: args.passphrase,
                sandbox: args.sandbox,
            },
        );

        if (result.success) {
            Logger.info(`[createRefund] Refund successful for order ${order.code}`, loggerCtx);
            return {
                state: 'Settled' as const,
                transactionId: pfPaymentId,
                metadata: result.metadata ?? {},
            };
        }

        if (result.requiresBankDetails) {
            Logger.warn(
                `[createRefund] BANK_PAYOUT required for order ${order.code} — returning no result so ` +
                `Vendure leaves the refund in its initial Pending state. ` +
                `Process manually in the PayFast dashboard then use "Settle refund" here ` +
                `(pf_payment_id: ${pfPaymentId}, amount: ${amount} cents).`,
                loggerCtx,
            );
            // Returning falsy (false) matches Vendure's internal handler signature
            // `Promise<false | CreateRefundResult>`. The payment.service guards with
            // `if (createRefundResult)`, so a falsy result skips the state-machine
            // transition entirely. The refund stays in its natural initial Pending
            // state and the "Settle refund" button appears in the dashboard.
            return false as unknown as CreateRefundResult;
        }

        Logger.error(`[createRefund] Refund failed for order ${order.code}: ${result.error}`, loggerCtx);
        return {
            state: 'Failed' as const,
            metadata: { error: result.error },
        };
    },
});
