import { Inject } from '@nestjs/common';
import { Mutation, Resolver } from '@nestjs/graphql';
import { ActiveOrderService, Ctx, OrderService, RequestContext, Transaction } from '@vendure/core';
import gql from 'graphql-tag';
import { DpoClient } from './dpo-client';
import { computePtlExpiresAt } from './dpo-date';
import { DPO_PAY_METHOD_CODE } from '../config/constants';
import { dpoLog } from '../config/dpo-log';
import { DPO_PAY_PLUGIN_OPTIONS, DpoPluginOptions } from '../config/dpo-plugin-options';
import { DpoTransactionService } from '../service/dpo-transaction.service';

export const dpoPaySchemaExtension = gql`
  extend type Mutation {
    "Kicks off a DPO payment: creates the order-side token and returns the hosted-page URL"
    initiateDpoPayment: DpoPaymentInitiation!
  }

  type DpoPaymentInitiation {
    success: Boolean!
    message: String
    transToken: String
    redirectUrl: String
  }
`;

/**
 * Confirmation (the old confirmDpoPayment mutation) is removed entirely — replaced by
 * api/dpo-redirect.controller.ts and api/dpo-webhook.controller.ts, both funneling into
 * DpoVerifyAndSettleService, which doesn't depend on the customer's session surviving
 * the trip to DPO's hosted page and back. This mutation only ever creates the token and
 * starts the payment as Authorized; it never itself decides pass/fail.
 */
@Resolver()
export class DpoPayResolver {
  private readonly client: DpoClient;

  constructor(
    private activeOrderService: ActiveOrderService,
    private orderService: OrderService,
    private dpoTransactionService: DpoTransactionService,
    @Inject(DPO_PAY_PLUGIN_OPTIONS) private options: DpoPluginOptions,
  ) {
    this.client = new DpoClient(options);
  }

  @Transaction()
  @Mutation()
  async initiateDpoPayment(@Ctx() ctx: RequestContext) {
    const order = await this.activeOrderService.getActiveOrder(ctx, undefined);
    if (!order) {
      dpoLog.warn('initiate', 'no_active_order', { channel: ctx.channel?.code });
      return { success: false, message: 'No active order' };
    }

    // Idempotency against double-click: reuse a still-open, unexpired transaction rather
    // than always calling createToken again.
    const existing = await this.dpoTransactionService.findOpenTransactionForOrder(ctx, order.id);
    if (existing?.transToken) {
      if (existing.payment) {
        dpoLog.info('initiate', 'token_reused', {
          order: order.code,
          txn: existing.id,
          token: existing.transToken,
          payment: existing.payment.id,
        });
      } else {
        // Known bug: this token's Payment was never attached (an earlier attempt failed at
        // addPaymentToOrder). If the customer pays with it, the order can never settle.
        dpoLog.warn('initiate', 'reused_without_payment', {
          order: order.code,
          txn: existing.id,
          token: existing.transToken,
        });
      }
      return {
        success: true,
        transToken: existing.transToken,
        redirectUrl: this.client.getHostedPaymentUrl(existing.transToken),
      };
    }

    const attemptCount = await this.dpoTransactionService.countTransactionsForOrder(ctx, order.id);
    const companyRef = attemptCount === 0 ? order.code : `${order.code}-R${attemptCount}`;
    const ptlValue = this.options.ptl ?? 5;
    const ptlType = this.options.ptlType ?? 'hours';

    const dpoTransaction = await this.dpoTransactionService.createForOrder(ctx, order, {
      companyRef,
      serviceType: this.options.serviceType,
      serviceDescription: this.options.serviceDescription,
      paymentAmount: order.totalWithTax / 100,
      paymentCurrency: order.currencyCode,
      redirectUrl: this.options.redirectUrl,
      backUrl: this.options.backUrl,
      ptlValue,
      ptlType,
      ptlExpiresAt: computePtlExpiresAt(new Date(), ptlValue, ptlType),
    });

    const result = await this.client.createToken({
      amount: order.totalWithTax / 100,
      currency: order.currencyCode,
      companyRef,
      // Sent as DPO's own independent duplicate-guard on top of our application-level
      // reuse check above — see doc §3.1 field notes.
      companyRefUnique: true,
      customerEmail: order.customer?.emailAddress,
      customerFirstName: order.customer?.firstName,
      customerLastName: order.customer?.lastName,
      serviceDescription: `Order ${order.code}`,
    });

    const updated = await this.dpoTransactionService.recordCreateTokenResult(
      ctx,
      dpoTransaction,
      {
        transToken: result.response.transToken,
        transRef: result.response.transRef,
        resultCode: result.response.result,
        resultExplanation: result.response.resultExplanation,
      },
      { requestXml: result.requestXml, responseXml: result.responseXml },
    );

    if (result.response.result !== '000' || !updated.transToken) {
      dpoLog.error('initiate', 'create_token_failed', {
        order: order.code,
        txn: updated.id,
        code: result.response.result || 'none',
        explanation: result.response.resultExplanation,
      });
      return { success: false, message: `DPO createToken failed: ${result.response.resultExplanation}` };
    }

    dpoLog.info('initiate', 'token_created', {
      order: order.code,
      txn: updated.id,
      token: updated.transToken,
      amount: order.totalWithTax / 100,
      currency: order.currencyCode,
      attempt: attemptCount + 1,
    });

    // This is what drives dpoPaymentHandler.createPayment into Authorized — see
    // ../dpo-payment-handler.ts.
    const addResult = await this.orderService.addPaymentToOrder(ctx, order.id, {
      method: DPO_PAY_METHOD_CODE,
      metadata: { dpoTransactionId: updated.id, transToken: updated.transToken },
    });
    if ('errorCode' in addResult) {
      // The DPO token above is now orphaned: it's saved, but no Payment is attached to it.
      dpoLog.error('initiate', 'add_payment_failed', {
        order: order.code,
        txn: updated.id,
        token: updated.transToken,
        error: addResult.errorCode,
        message: addResult.message,
      });
      return { success: false, message: addResult.message };
    }

    // Link the just-created Payment back onto dpo_transaction NOW, not deferred to
    // settlePayment — verifyAndSettle only attempts a Payment state transition when
    // dpo_transaction.payment is already populated, so without this, verifyAndSettle
    // would never find a Payment to settle/decline/cancel no matter what DPO reports.
    const payments = await this.orderService.getOrderPayments(ctx, order.id);
    const payment = payments.find(p => p.transactionId === updated.transToken);
    if (payment) {
      await this.dpoTransactionService.linkPayment(ctx, updated.id, payment);
    } else {
      dpoLog.warn('initiate', 'payment_not_found', { order: order.code, txn: updated.id, token: updated.transToken });
    }

    dpoLog.info('initiate', 'ok', { order: order.code, txn: updated.id, payment: payment?.id });

    return {
      success: true,
      transToken: updated.transToken,
      redirectUrl: this.client.getHostedPaymentUrl(updated.transToken),
    };
  }
}
