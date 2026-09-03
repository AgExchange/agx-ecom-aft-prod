import { Inject, Injectable } from '@nestjs/common';
import { RequestContext, TransactionalConnection } from '@vendure/core';
import { DpoClient } from '../api/dpo-client';
import { DPO_PAY_PLUGIN_OPTIONS, DpoPluginOptions } from '../config/dpo-plugin-options';
import { DpoRefund } from '../entities/dpo-refund.entity';
import { DpoTransaction } from '../entities/dpo-transaction.entity';
import { DpoTransactionService } from './dpo-transaction.service';

/**
 * Unlike payments, refunds have no hosted-redirect gap: refundToken and verifyRefund can
 * run synchronously back-to-back in one call — see doc §3.5/§4.1.1, "refunds get the
 * same create->verify treatment as payments," just without needing a webhook.
 */
@Injectable()
export class DpoRefundService {
  private readonly client: DpoClient;

  constructor(
    @Inject(DPO_PAY_PLUGIN_OPTIONS) options: DpoPluginOptions,
    private connection: TransactionalConnection,
    private dpoTransactionService: DpoTransactionService,
  ) {
    this.client = new DpoClient(options);
  }

  async requestAndVerifyRefund(
    ctx: RequestContext,
    dpoTransaction: DpoTransaction,
    amount: number,
    details: string,
  ): Promise<{ dpoRefund: DpoRefund; success: boolean }> {
    if (!dpoTransaction.transToken) {
      throw new Error(`DPO refund requested for dpo_transaction ${dpoTransaction.id} with no transToken`);
    }

    const refundRepo = this.connection.getRepository(ctx, DpoRefund);
    let dpoRefund = refundRepo.create({
      dpoTransaction,
      vendureRefund: null,
      refundAmount: amount,
      refundDetails: details,
      status: 'requested',
      requestedAt: new Date(),
    });
    dpoRefund = await refundRepo.save(dpoRefund);

    const refundResult = await this.client.refundToken({
      transToken: dpoTransaction.transToken,
      refundAmount: amount,
      refundDetails: details,
    });
    await this.dpoTransactionService.logEvent(ctx, dpoTransaction, 'refund_token_request', {
      requestXml: refundResult.requestXml,
    });
    await this.dpoTransactionService.logEvent(ctx, dpoTransaction, 'refund_token_response', {
      responseXml: refundResult.responseXml,
      resultCode: refundResult.response.result,
      resultExplanation: refundResult.response.resultExplanation,
    });

    const verify = await this.client.verifyRefund(dpoTransaction.transToken);
    await this.dpoTransactionService.logEvent(ctx, dpoTransaction, 'verify_refund_request', {
      requestXml: verify.requestXml,
    });
    await this.dpoTransactionService.logEvent(ctx, dpoTransaction, 'verify_refund_response', {
      responseXml: verify.responseXml,
      resultCode: verify.envelope.code,
      resultExplanation: verify.envelope.explanation,
    });

    const success = verify.envelope.code === '000';
    dpoRefund.status = success ? 'succeeded' : 'failed';
    dpoRefund.resultCode = verify.envelope.code;
    dpoRefund.resultExplanation = verify.envelope.explanation;
    dpoRefund.completedAt = new Date();
    dpoRefund = await refundRepo.save(dpoRefund);

    if (success) {
      const txnRepo = this.connection.getRepository(ctx, DpoTransaction);
      // Simplification: doesn't track cumulative refunds across multiple partial refunds
      // against the same transaction — only this single refund's amount vs. the original
      // payment amount. Good enough for the common single-refund case this pass covers.
      dpoTransaction.status = amount >= dpoTransaction.paymentAmount ? 'refunded' : 'partially_refunded';
      await txnRepo.save(dpoTransaction);
    }

    return { dpoRefund, success };
  }
}
