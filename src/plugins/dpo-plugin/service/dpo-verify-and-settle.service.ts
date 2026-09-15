import { Inject, Injectable } from '@nestjs/common';
import { ID, OrderService, TransactionalConnection } from '@vendure/core';
import { DpoClient } from '../api/dpo-client';
import { dpoLog } from '../config/dpo-log';
import { DPO_PAY_PLUGIN_OPTIONS, DpoPluginOptions } from '../config/dpo-plugin-options';
import { DpoTransaction } from '../entities/dpo-transaction.entity';
import { DpoRequestContextHelper } from './dpo-request-context.helper';
import { DpoResultCodeInfo } from './dpo-result-code';
import { DpoTransactionService } from './dpo-transaction.service';

/** Which endpoint triggered a verification — used for log lines only. */
export type DpoNotificationSource = 'callback' | 'return' | 'back';

export interface VerifyAndSettleInput {
  transToken?: string;
  companyRef?: string;
  /** Defaults from notification.kind when omitted. */
  source?: DpoNotificationSource;
  notification: { kind: 'push_callback' | 'redirect_return'; rawPayload: unknown };
}

export interface VerifyAndSettleResult {
  dpoTransaction: DpoTransaction;
  resultInfo: DpoResultCodeInfo;
}

/**
 * Logs the outcome of a Vendure Payment state transition. A typed ErrorResult is benign in the
 * common double-verification case (return and back both firing, or a replayed notification) —
 * Vendure's state machine rejects a repeat transition rather than throwing, so this is a
 * warning, not an escalation.
 */
function logTransition(result: unknown, fields: { order: string; payment: ID; to: string }): void {
  if (result && typeof result === 'object' && 'errorCode' in result) {
    const errorResult = result as { errorCode: string; message?: string };
    dpoLog.warn('verify', 'transition_rejected', {
      ...fields,
      error: errorResult.errorCode,
      message: errorResult.message,
    });
    return;
  }
  dpoLog.info('verify', 'payment_moved', fields);
}

/**
 * The single entrypoint the webhook controller and both redirect targets funnel into — per
 * doc §4.1.1, "always verify, every time." No caller is ever trusted as proof of payment on
 * its own; this function's call to DPO's verifyToken is the only thing permitted to change
 * dpo_transaction/Payment state.
 *
 * Safe to call twice for the same transaction — the persistence guard is first-write-wins and
 * Vendure's own state-machine calls return a typed ErrorResult (not a thrown error) on a repeat
 * transition, which is logged and swallowed rather than surfaced as a failure.
 */
@Injectable()
export class DpoVerifyAndSettleService {
  private readonly client: DpoClient;

  constructor(
    @Inject(DPO_PAY_PLUGIN_OPTIONS) options: DpoPluginOptions,
    private dpoTransactionService: DpoTransactionService,
    private requestContextHelper: DpoRequestContextHelper,
    private orderService: OrderService,
    private connection: TransactionalConnection,
  ) {
    this.client = new DpoClient(options);
  }

  async verifyAndSettle(input: VerifyAndSettleInput): Promise<VerifyAndSettleResult | undefined> {
    const source: DpoNotificationSource =
      input.source ?? (input.notification.kind === 'push_callback' ? 'callback' : 'return');

    let dpoTransaction = input.transToken
      ? await this.dpoTransactionService.findByTransToken(undefined, input.transToken)
      : undefined;
    if (!dpoTransaction && input.companyRef) {
      dpoTransaction = await this.dpoTransactionService.findByCompanyRef(undefined, input.companyRef);
    }
    if (!dpoTransaction) {
      dpoLog.warn('verify', 'no_match', { source, token: input.transToken, companyRef: input.companyRef });
      return undefined;
    }
    if (!dpoTransaction.transToken) {
      dpoLog.warn('verify', 'no_token_yet', { source, order: dpoTransaction.order?.code, txn: dpoTransaction.id });
      return undefined;
    }

    // Narrowed const so the closure below doesn't need non-null assertions — `let` +
    // reassignment above defeats TS's narrowing across the async boundary otherwise.
    const resolvedTransaction = dpoTransaction;
    // Non-null: already checked above (`if (!dpoTransaction.transToken) return`).
    const resolvedTransToken = resolvedTransaction.transToken as string;
    const orderCode = resolvedTransaction.order?.code ?? resolvedTransaction.companyRef;

    const systemCtx = await this.requestContextHelper.getSystemRequestContextForOrder(resolvedTransaction.order);

    // Webhook/redirect controllers aren't Vendure GraphQL resolvers, so there's no
    // @Transaction()-decorated request-scoped transaction already wrapping this call —
    // start one explicitly, matching TransactionalConnection.withTransaction's own
    // documented use case for code running outside the request-response cycle.
    return this.connection.withTransaction(systemCtx, async ctx => {
      await this.dpoTransactionService.recordInboundNotification(
        ctx,
        resolvedTransaction,
        input.notification.kind,
        input.notification.rawPayload,
      );

      const { envelope, response, requestXml, responseXml } = await this.client.verifyToken({
        transToken: resolvedTransToken,
        companyRef: resolvedTransaction.companyRef,
      });

      const { transaction: updated, resultInfo } = await this.dpoTransactionService.applyVerifyTokenResult(
        ctx,
        resolvedTransaction,
        { code: envelope.code, explanation: envelope.explanation, response },
        { requestXml, responseXml },
      );

      dpoLog.info('verify', 'result', {
        source,
        order: orderCode,
        txn: updated.id,
        token: resolvedTransToken,
        code: resultInfo.code || 'none',
        class: resultInfo.class,
        status: updated.status,
      });

      const payment = updated.payment;
      if (!payment) {
        // With code=000 this means the customer has paid but the order can never settle.
        dpoLog.warn('verify', 'no_linked_payment', {
          source,
          order: orderCode,
          txn: updated.id,
          code: resultInfo.code || 'none',
        });
        return { dpoTransaction: updated, resultInfo };
      }

      switch (resultInfo.transactionStatus) {
        case 'paid': {
          const result = await this.orderService.settlePayment(ctx, payment.id);
          logTransition(result, { order: orderCode, payment: payment.id, to: 'Settled' });
          break;
        }
        case 'declined':
        case 'expired': {
          const result = await this.orderService.transitionPaymentToState(ctx, payment.id, 'Declined');
          logTransition(result, { order: orderCode, payment: payment.id, to: 'Declined' });
          break;
        }
        case 'cancelled': {
          const result = await this.orderService.cancelPayment(ctx, payment.id);
          logTransition(result, { order: orderCode, payment: payment.id, to: 'Cancelled' });
          break;
        }
        default:
          // Non-terminal (authorized/pending_bank/queued_authorization/pending_split_payment/
          // awaiting_payment), needs-review (overpaid_underpaid), or integration-error — no
          // Vendure-side Payment transition; stays Authorized, eligible for re-poll. The
          // [verify] result line above already records which.
          break;
      }

      return { dpoTransaction: updated, resultInfo };
    });
  }
}
