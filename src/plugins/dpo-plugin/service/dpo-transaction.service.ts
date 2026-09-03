import { Injectable } from '@nestjs/common';
import { ID, Logger, Order, Payment, RequestContext, TransactionalConnection } from '@vendure/core';
import { DpoVerifyTokenV7Response } from '../api/dpo-xml-types';
import { parseDpoDateOnly, parseDpoDateTimeAssumeUtc } from '../api/dpo-date';
import { loggerCtx } from '../config/constants';
import { DpoTransaction } from '../entities/dpo-transaction.entity';
import { DpoTransactionEvent, DpoTransactionEventType } from '../entities/dpo-transaction-event.entity';
import { classifyResultCode, DpoResultCodeInfo } from './dpo-result-code';
import { redactCompanyToken } from './redact';

/** Statuses where a transaction is still eligible for re-polling / customer follow-up. */
const OPEN_STATUSES = [
  'pending_redirect',
  'awaiting_payment',
  'authorized',
  'pending_bank',
  'queued_authorization',
  'pending_split_payment',
] as const;

export interface CreateForOrderInput {
  companyRef: string;
  serviceType: string;
  serviceDescription?: string;
  paymentAmount: number;
  paymentCurrency: string;
  redirectUrl: string;
  backUrl: string;
  ptlValue?: number;
  ptlType?: string;
  ptlExpiresAt?: Date;
}

export interface XmlEventPayload {
  requestXml?: string;
  responseXml?: string;
  resultCode?: string;
  resultExplanation?: string;
}

/**
 * Pure mirror of the Postgres guard trigger (guard_dpo_payment_confirmation in the
 * hand-written supplementary migration): payment_date / verify_token_confirmed_at are
 * first-write-wins and only ever settable when the incoming result is '000'. Kept as a
 * standalone, DB-free function specifically so this invariant is real and testable on
 * SQLite too, per the locked decision to stay on SQLite for local dev.
 */
export function applyPaymentConfirmationGuard(input: {
  existingPaymentDate: Date | null;
  existingVerifyTokenConfirmedAt: Date | null;
  resultCode: string;
  incomingPaymentDate: Date | undefined;
  incomingPaymentDateRaw: string | undefined;
  now: Date;
}): { paymentDate?: Date; paymentDateRaw?: string; verifyTokenConfirmedAt?: Date } {
  if (input.resultCode !== '000') {
    return {};
  }
  const out: { paymentDate?: Date; paymentDateRaw?: string; verifyTokenConfirmedAt?: Date } = {};
  if (input.existingPaymentDate == null) {
    if (input.incomingPaymentDate) out.paymentDate = input.incomingPaymentDate;
    if (input.incomingPaymentDateRaw) out.paymentDateRaw = input.incomingPaymentDateRaw;
  }
  if (input.existingVerifyTokenConfirmedAt == null) {
    out.verifyTokenConfirmedAt = input.now;
  }
  return out;
}

@Injectable()
export class DpoTransactionService {
  constructor(private connection: TransactionalConnection) {}

  async createForOrder(ctx: RequestContext, order: Order, input: CreateForOrderInput): Promise<DpoTransaction> {
    const repo = this.connection.getRepository(ctx, DpoTransaction);
    const transaction = repo.create({
      order,
      payment: null,
      companyRef: input.companyRef,
      transToken: null,
      transRef: null,
      serviceType: input.serviceType,
      serviceDescription: input.serviceDescription ?? null,
      paymentAmount: input.paymentAmount,
      paymentCurrency: input.paymentCurrency,
      redirectUrl: input.redirectUrl,
      backUrl: input.backUrl,
      ptlValue: input.ptlValue ?? null,
      ptlType: input.ptlType ?? null,
      ptlExpiresAt: input.ptlExpiresAt ?? null,
      status: 'pending_redirect',
    });
    return repo.save(transaction);
  }

  async recordCreateTokenResult(
    ctx: RequestContext,
    dpoTransaction: DpoTransaction,
    result: { transToken?: string; transRef?: string; resultCode: string; resultExplanation: string },
    xml: { requestXml: string; responseXml: string },
  ): Promise<DpoTransaction> {
    await this.logEvent(ctx, dpoTransaction, 'create_token_request', {
      requestXml: xml.requestXml,
    });
    await this.logEvent(ctx, dpoTransaction, 'create_token_response', {
      responseXml: xml.responseXml,
      resultCode: result.resultCode,
      resultExplanation: result.resultExplanation,
    });

    // lastResultCode/lastResultExplanation are deliberately NOT written here — per the
    // spec, that pair is scoped to verifyToken's <Result> specifically (doc's dpo_schema.sql:
    // "Populated ONLY from verifyToken's <Result> element"). createToken's own '000' means
    // "token created," not "payment confirmed" — writing it into the same field would be
    // misleading on an otherwise-still-`awaiting_payment` row. The createToken outcome is
    // still fully captured in the create_token_response event logged above.
    const repo = this.connection.getRepository(ctx, DpoTransaction);
    if (result.resultCode === '000' && result.transToken) {
      dpoTransaction.transToken = result.transToken;
      dpoTransaction.transRef = result.transRef ?? null;
      dpoTransaction.status = 'awaiting_payment';
    }
    return repo.save(dpoTransaction);
  }

  /**
   * Logs an inbound webhook/redirect hit unconditionally, before any verification
   * happens — per doc §4.1.1, "a callback for a declined transaction still gets a row
   * here." Neither the webhook nor the redirect is ever trusted as proof of payment on
   * its own; this is purely an audit-trail write.
   */
  async recordInboundNotification(
    ctx: RequestContext,
    dpoTransaction: DpoTransaction,
    kind: Extract<DpoTransactionEventType, 'push_callback' | 'redirect_return'>,
    rawPayload: unknown,
  ): Promise<void> {
    await this.logEvent(ctx, dpoTransaction, kind, {
      requestXml: typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload),
    });
  }

  /**
   * The single method implementing doc §4.1.3's core rule: integration-error codes
   * (801/802/803/804/902/950) never touch dpo_transaction.status or any snapshot field —
   * enforced here once, rather than trusted to every caller.
   */
  async applyVerifyTokenResult(
    ctx: RequestContext,
    dpoTransaction: DpoTransaction,
    result: { code: string; explanation: string; response: DpoVerifyTokenV7Response },
    xml: { requestXml: string; responseXml: string },
  ): Promise<{ transaction: DpoTransaction; resultInfo: DpoResultCodeInfo }> {
    const resultInfo = classifyResultCode(result.code, result.explanation);

    await this.logEvent(ctx, dpoTransaction, 'verify_token_request', { requestXml: xml.requestXml });
    await this.logEvent(ctx, dpoTransaction, 'verify_token_response', {
      responseXml: xml.responseXml,
      resultCode: resultInfo.code,
      resultExplanation: resultInfo.explanation,
    });

    if (resultInfo.class === 'integration-error') {
      Logger.error(
        `DPO verifyToken returned integration-error ${resultInfo.code} (${resultInfo.explanation}) for dpo_transaction ${dpoTransaction.id} — leaving status untouched`,
        loggerCtx,
      );
      return { transaction: dpoTransaction, resultInfo };
    }

    if (resultInfo.class === 'needs-review') {
      Logger.warn(
        `DPO verifyToken returned ${resultInfo.code} (${resultInfo.explanation}) for dpo_transaction ${dpoTransaction.id} — needs manual review, never auto-settled`,
        loggerCtx,
      );
    }

    const r = result.response;
    const guard = applyPaymentConfirmationGuard({
      existingPaymentDate: dpoTransaction.paymentDate,
      existingVerifyTokenConfirmedAt: dpoTransaction.verifyTokenConfirmedAt,
      resultCode: resultInfo.code,
      incomingPaymentDate: parseDpoDateTimeAssumeUtc(r.transactionPaymentDate),
      incomingPaymentDateRaw: r.transactionPaymentDate,
      now: new Date(),
    });

    dpoTransaction.lastResultCode = resultInfo.code;
    dpoTransaction.lastResultExplanation = resultInfo.explanation;
    if (resultInfo.transactionStatus) {
      dpoTransaction.status = resultInfo.transactionStatus;
    }
    dpoTransaction.transactionCreatedDate = parseDpoDateTimeAssumeUtc(r.transactionCreatedDate) ?? dpoTransaction.transactionCreatedDate;
    dpoTransaction.transactionExpiryDate = parseDpoDateTimeAssumeUtc(r.transactionExpiryDate) ?? dpoTransaction.transactionExpiryDate;
    dpoTransaction.transactionSettlementDate =
      parseDpoDateOnly(r.transactionSettlementDate) ?? dpoTransaction.transactionSettlementDate;
    dpoTransaction.customerName = r.customerName ?? dpoTransaction.customerName;
    dpoTransaction.approvalNumber = r.approvalNumber ?? dpoTransaction.approvalNumber;
    dpoTransaction.cardType = r.cardType ?? dpoTransaction.cardType;
    dpoTransaction.cardLastFour = r.cardLastFour ?? dpoTransaction.cardLastFour;
    dpoTransaction.cardFirstSix = r.cardFirstSix ?? dpoTransaction.cardFirstSix;
    dpoTransaction.transactionAmount = r.transactionAmount ?? dpoTransaction.transactionAmount;
    dpoTransaction.transactionCurrency = r.transactionCurrency ?? dpoTransaction.transactionCurrency;
    dpoTransaction.transactionFinalAmount = r.transactionFinalAmount ?? dpoTransaction.transactionFinalAmount;
    dpoTransaction.transactionFinalCurrency = r.transactionFinalCurrency ?? dpoTransaction.transactionFinalCurrency;
    dpoTransaction.partPaymentRef = r.partPaymentRef ?? dpoTransaction.partPaymentRef;
    dpoTransaction.fraudAlertCode = r.transactionFraudAlert ?? dpoTransaction.fraudAlertCode;
    dpoTransaction.fraudExplanation = r.transactionFraudExplanation ?? dpoTransaction.fraudExplanation;
    if (guard.paymentDate) dpoTransaction.paymentDate = guard.paymentDate;
    if (guard.paymentDateRaw) dpoTransaction.paymentDateRaw = guard.paymentDateRaw;
    if (guard.verifyTokenConfirmedAt) dpoTransaction.verifyTokenConfirmedAt = guard.verifyTokenConfirmedAt;

    const repo = this.connection.getRepository(ctx, DpoTransaction);
    const saved = await repo.save(dpoTransaction);
    return { transaction: saved, resultInfo };
  }

  async findOpenTransactionForOrder(ctx: RequestContext, orderId: ID): Promise<DpoTransaction | undefined> {
    const repo = this.connection.getRepository(ctx, DpoTransaction);
    const found = await repo.find({
      where: { order: { id: orderId } },
      order: { createdAt: 'DESC' },
      take: 5,
    });
    const now = Date.now();
    return found.find(
      t =>
        (OPEN_STATUSES as readonly string[]).includes(t.status) &&
        (!t.ptlExpiresAt || t.ptlExpiresAt.getTime() > now),
    );
  }

  async findByTransToken(ctx: RequestContext | undefined, transToken: string): Promise<DpoTransaction | undefined> {
    const repo = this.connection.getRepository(ctx, DpoTransaction);
    return (
      (await repo.findOne({
        where: { transToken },
        relations: { order: { channels: true }, payment: true },
      })) ?? undefined
    );
  }

  async findByCompanyRef(ctx: RequestContext | undefined, companyRef: string): Promise<DpoTransaction | undefined> {
    const repo = this.connection.getRepository(ctx, DpoTransaction);
    return (
      (await repo.findOne({
        where: { companyRef },
        order: { createdAt: 'DESC' },
        relations: { order: { channels: true }, payment: true },
      })) ?? undefined
    );
  }

  /** Used to compute the retry-suffix companyRef scheme — see api/dpo-pay.resolver.ts. */
  async countTransactionsForOrder(ctx: RequestContext, orderId: ID): Promise<number> {
    const repo = this.connection.getRepository(ctx, DpoTransaction);
    return repo.count({ where: { order: { id: orderId } } });
  }

  async getById(ctx: RequestContext, id: ID): Promise<DpoTransaction> {
    return this.connection.getEntityOrThrow(ctx, DpoTransaction, id);
  }

  /** Best-effort backfill only — functional correctness never depends on this being set. */
  async linkPayment(ctx: RequestContext, dpoTransactionId: ID, payment: Payment): Promise<void> {
    const repo = this.connection.getRepository(ctx, DpoTransaction);
    await repo.createQueryBuilder().relation(DpoTransaction, 'payment').of(dpoTransactionId).set(payment);
  }

  /** Tolerant of DPO reporting "already cancelled" — may be invoked reactively (a 904 from verifyToken) or by an admin action. */
  async markCancelled(ctx: RequestContext, dpoTransaction: DpoTransaction): Promise<void> {
    const repo = this.connection.getRepository(ctx, DpoTransaction);
    dpoTransaction.status = 'cancelled';
    await repo.save(dpoTransaction);
  }

  /** Public so dpo-refund.service.ts can log refund/verify-refund events against the same audit trail. */
  async logEvent(
    ctx: RequestContext,
    dpoTransaction: DpoTransaction,
    eventType: DpoTransactionEventType,
    payload: XmlEventPayload,
  ): Promise<void> {
    const repo = this.connection.getRepository(ctx, DpoTransactionEvent);
    const event = repo.create({
      dpoTransaction,
      eventType,
      resultCode: payload.resultCode ?? null,
      resultExplanation: payload.resultExplanation ?? null,
      rawRequestXml: redactCompanyToken(payload.requestXml),
      rawResponseXml: payload.responseXml ?? null,
      occurredAt: new Date(),
    });
    await repo.save(event);
  }
}
