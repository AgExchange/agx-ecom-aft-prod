import {
  CancelPaymentErrorResult,
  CancelPaymentResult,
  CreatePaymentErrorResult,
  CreatePaymentResult,
  CreateRefundResult,
  Injector,
  LanguageCode,
  PaymentMethodHandler,
  SettlePaymentErrorResult,
  SettlePaymentResult,
} from '@vendure/core';
import { DpoClient } from './api/dpo-client';
import { DPO_PAY_METHOD_CODE } from './config/constants';
import { DPO_PAY_PLUGIN_OPTIONS, DpoPluginOptions } from './config/dpo-plugin-options';
import { DpoRefundService } from './service/dpo-refund.service';
import { DpoTransactionService } from './service/dpo-transaction.service';

// Module-scoped, populated once in init(injector) at bootstrap — see the
// ConfigurableOperationDef "Dependency Injection" pattern docs in @vendure/core.
let dpoTransactionService: DpoTransactionService;
let dpoRefundService: DpoRefundService;
let dpoClient: DpoClient;

/**
 * DPO's flow is hosted-checkout / redirect-based: the order is placed, createToken is
 * called (see api/dpo-pay.resolver.ts), and the customer is sent off-site to DPO's
 * hosted page. Vendure only finds out the real outcome later, out-of-band, via
 * service/dpo-verify-and-settle.service.ts (triggered by the webhook and/or the
 * redirect return). So:
 *
 *  - createPayment returns `Authorized` as soon as a DPO transToken exists — NOT
 *    `Settled` — because at this point nothing has actually been confirmed yet. The
 *    real pass/fail determination happens later, entirely inside verifyAndSettle.
 *  - settlePayment is invoked BY verifyAndSettle once Result 000 is confirmed; it
 *    defensively re-checks dpo_transaction.status itself rather than trusting that it's
 *    only ever called after a real verification, so a stray Admin UI "settle" click
 *    against an unverified payment fails loudly instead of silently succeeding.
 */
export const dpoPaymentHandler = new PaymentMethodHandler({
  code: DPO_PAY_METHOD_CODE,
  description: [{ languageCode: LanguageCode.en, value: 'DPO Pay by Network' }],
  args: {},

  init(injector: Injector) {
    dpoTransactionService = injector.get(DpoTransactionService);
    dpoRefundService = injector.get(DpoRefundService);
    dpoClient = new DpoClient(injector.get<DpoPluginOptions>(DPO_PAY_PLUGIN_OPTIONS));
  },

  createPayment: async (ctx, order, amount, args, metadata): Promise<CreatePaymentResult | CreatePaymentErrorResult> => {
    const transToken = metadata?.transToken as string | undefined;
    const dpoTransactionId = metadata?.dpoTransactionId;

    if (!transToken || dpoTransactionId == null) {
      return {
        amount,
        state: 'Error',
        errorMessage: 'DPO payment could not be initiated (missing transToken) — see api/dpo-pay.resolver.ts',
      };
    }

    return {
      amount,
      state: 'Authorized' as const,
      transactionId: transToken,
      metadata: { dpoTransactionId },
    };
  },

  settlePayment: async (ctx, order, payment): Promise<SettlePaymentResult | SettlePaymentErrorResult> => {
    const dpoTransactionId = payment.metadata?.dpoTransactionId;
    if (dpoTransactionId == null) {
      return { success: false, errorMessage: 'No linked DPO transaction found for this payment' };
    }
    const dpoTransaction = await dpoTransactionService.getById(ctx, dpoTransactionId);
    if (dpoTransaction.status !== 'paid') {
      return {
        success: false,
        errorMessage: `DPO transaction ${String(dpoTransaction.id)} has not been confirmed as paid (status: ${dpoTransaction.status}) — settlePayment should only run after verifyAndSettle confirms Result 000`,
      };
    }
    await dpoTransactionService.linkPayment(ctx, dpoTransaction.id, payment);
    return { success: true };
  },

  cancelPayment: async (ctx, order, payment): Promise<CancelPaymentResult | CancelPaymentErrorResult> => {
    const dpoTransactionId = payment.metadata?.dpoTransactionId;
    if (dpoTransactionId == null) {
      return { success: false, errorMessage: 'No linked DPO transaction found for this payment' };
    }
    const dpoTransaction = await dpoTransactionService.getById(ctx, dpoTransactionId);
    if (!dpoTransaction.transToken) {
      return { success: false, errorMessage: `dpo_transaction ${String(dpoTransaction.id)} has no transToken to cancel` };
    }
    const result = await dpoClient.cancelToken(dpoTransaction.transToken);
    await dpoTransactionService.logEvent(ctx, dpoTransaction, 'cancel_token_request', { requestXml: result.requestXml });
    await dpoTransactionService.logEvent(ctx, dpoTransaction, 'cancel_token_response', {
      responseXml: result.responseXml,
      resultCode: result.response.result,
      resultExplanation: result.response.resultExplanation,
    });
    // Tolerant of DPO reporting "already cancelled" — this can be invoked either by an
    // admin action or reactively (verifyAndSettle observing DPO's own Result 904).
    await dpoTransactionService.markCancelled(ctx, dpoTransaction);
    return { success: true };
  },

  createRefund: async (ctx, input, amount, order, payment): Promise<CreateRefundResult> => {
    const dpoTransactionId = payment.metadata?.dpoTransactionId;
    if (dpoTransactionId == null) {
      throw new Error('No linked DPO transaction found for this payment');
    }
    const dpoTransaction = await dpoTransactionService.getById(ctx, dpoTransactionId);
    // Vendure amounts are integers in minor units (e.g. $10 = 1000); DPO expects a
    // decimal major-unit amount — same conversion convention already used in
    // api/dpo-pay.resolver.ts's createToken call.
    const { dpoRefund, success } = await dpoRefundService.requestAndVerifyRefund(
      ctx,
      dpoTransaction,
      amount / 100,
      input.reason ?? 'Refund',
    );
    return {
      state: success ? 'Settled' : 'Failed',
      transactionId: dpoTransaction.transToken ?? undefined,
      metadata: { dpoRefundId: dpoRefund.id },
    };
  },
});
