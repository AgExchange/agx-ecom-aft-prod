import { Inject, Injectable } from '@nestjs/common';
import { Logger, OrderService, TransactionalConnection } from '@vendure/core';
import { DpoClient } from '../api/dpo-client';
import { loggerCtx } from '../config/constants';
import { DPO_PAY_PLUGIN_OPTIONS, DpoPluginOptions } from '../config/dpo-plugin-options';
import { DpoTransaction } from '../entities/dpo-transaction.entity';
import { DpoRequestContextHelper } from './dpo-request-context.helper';
import { DpoResultCodeInfo } from './dpo-result-code';
import { DpoTransactionService } from './dpo-transaction.service';

export interface VerifyAndSettleInput {
  transToken?: string;
  companyRef?: string;
  notification: { kind: 'push_callback' | 'redirect_return'; rawPayload: unknown };
}

export interface VerifyAndSettleResult {
  dpoTransaction: DpoTransaction;
  resultInfo: DpoResultCodeInfo;
}

function logIfError(result: unknown, context: string): void {
  if (result && typeof result === 'object' && 'errorCode' in result) {
    // Benign in the common double-verification case (webhook + redirect both firing,
    // or DPO calling verifyToken twice) — Vendure's state machine rejects a repeat
    // transition rather than throwing, so this is a log, not an escalation.
    Logger.warn(`${context}: ${(result as any).errorCode} — ${(result as any).message}`, loggerCtx);
  }
}

/**
 * The single entrypoint both the webhook (BackURL) controller and the redirect
 * (RedirectURL) controller funnel into — per doc §4.1.1, "always verify, every time."
 * Neither caller is ever trusted as proof of payment on its own; this function's call to
 * DPO's verifyToken is the only thing permitted to change dpo_transaction/Payment state.
 *
 * Safe to call twice for the same transaction (webhook and redirect both fire, or DPO
 * itself re-verifies) — the persistence guard is first-write-wins and Vendure's own
 * state-machine calls return a typed ErrorResult (not a thrown error) on a repeat
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
    let dpoTransaction = input.transToken
      ? await this.dpoTransactionService.findByTransToken(undefined, input.transToken)
      : undefined;
    if (!dpoTransaction && input.companyRef) {
      dpoTransaction = await this.dpoTransactionService.findByCompanyRef(undefined, input.companyRef);
    }
    if (!dpoTransaction) {
      Logger.warn(
        `verifyAndSettle: no dpo_transaction found for transToken=${input.transToken ?? '(none)'} companyRef=${input.companyRef ?? '(none)'}`,
        loggerCtx,
      );
      return undefined;
    }
    if (!dpoTransaction.transToken) {
      Logger.warn(`verifyAndSettle: dpo_transaction ${dpoTransaction.id} has no transToken yet — skipping`, loggerCtx);
      return undefined;
    }

    // Narrowed const so the closure below doesn't need non-null assertions — `let` +
    // reassignment above defeats TS's narrowing across the async boundary otherwise.
    const resolvedTransaction = dpoTransaction;
    // Non-null: already checked above (`if (!dpoTransaction.transToken) return`).
    const resolvedTransToken = resolvedTransaction.transToken as string;

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

      const payment = updated.payment;
      if (!payment) {
        Logger.info(
          `verifyAndSettle: dpo_transaction ${updated.id} has no linked Payment yet (result ${resultInfo.code}) — dpo_transaction row updated, Vendure-side transition deferred`,
          loggerCtx,
        );
        return { dpoTransaction: updated, resultInfo };
      }

      switch (resultInfo.transactionStatus) {
        case 'paid': {
          const result = await this.orderService.settlePayment(ctx, payment.id);
          logIfError(result, `verifyAndSettle: settlePayment for payment ${payment.id}`);
          break;
        }
        case 'declined':
        case 'expired': {
          const result = await this.orderService.transitionPaymentToState(ctx, payment.id, 'Declined');
          logIfError(result, `verifyAndSettle: transitionPaymentToState(Declined) for payment ${payment.id}`);
          break;
        }
        case 'cancelled': {
          const result = await this.orderService.cancelPayment(ctx, payment.id);
          logIfError(result, `verifyAndSettle: cancelPayment for payment ${payment.id}`);
          break;
        }
        default:
          // Non-terminal (authorized/pending_bank/queued_authorization/pending_split_payment/
          // awaiting_payment), needs-review (overpaid_underpaid), or integration-error — no
          // Vendure-side Payment transition; stays Authorized, eligible for re-poll.
          break;
      }

      return { dpoTransaction: updated, resultInfo };
    });
  }
}
