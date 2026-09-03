import { DeepPartial } from '@vendure/common/lib/shared-types';
import { Order, Payment, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { decimalTransformer } from './decimal-transformer';

/**
 * Lifecycle status of a `dpo_transaction`, derived from DPO's verifyToken result codes
 * (see documentation/dpo-pay-vendure-plugin-docs.md §4.1.3). Extends the spec SQL's
 * status list with states for result codes 900/003/005/007, which the spec itself
 * flagged as missing. The integration-error family (801/802/803/804/902/950) is
 * deliberately NOT represented here — those must never be written to this column.
 */
export type DpoTransactionStatus =
  | 'pending_redirect'
  | 'awaiting_payment'
  | 'authorized'
  | 'pending_bank'
  | 'queued_authorization'
  | 'pending_split_payment'
  | 'paid'
  | 'overpaid_underpaid'
  | 'declined'
  | 'expired'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded';

@Entity('dpo_transaction')
export class DpoTransaction extends VendureEntity {
  constructor(input?: DeepPartial<DpoTransaction>) {
    super(input);
  }

  @Index()
  @ManyToOne(() => Order, { onDelete: 'CASCADE' })
  order: Order;

  @Index()
  @ManyToOne(() => Payment, { nullable: true, onDelete: 'SET NULL' })
  payment: Payment | null;

  @Index()
  @Column()
  companyRef: string;

  // Nullable + unique: NULL values don't count toward uniqueness on either sqlite or
  // Postgres, so multiple pre-createToken rows (transToken not yet assigned) are fine.
  @Index({ unique: true })
  @Column({ type: 'varchar', nullable: true })
  transToken: string | null;

  @Column({ type: 'varchar', nullable: true })
  transRef: string | null;

  @Column()
  serviceType: string;

  @Column({ type: 'varchar', nullable: true })
  serviceDescription: string | null;

  @Column('decimal', { precision: 14, scale: 2, transformer: decimalTransformer })
  paymentAmount: number;

  @Column({ length: 3 })
  paymentCurrency: string;

  @Column('text')
  redirectUrl: string;

  @Column('text')
  backUrl: string;

  @Column({ type: 'int', nullable: true })
  ptlValue: number | null;

  @Column({ type: 'varchar', nullable: true })
  ptlType: string | null;

  @Column({ type: Date, nullable: true })
  ptlExpiresAt: Date | null;

  @Index()
  @Column({ type: 'varchar', default: 'pending_redirect' })
  status: DpoTransactionStatus;

  @Column({ type: 'varchar', nullable: true })
  lastResultCode: string | null;

  @Column('text', { nullable: true })
  lastResultExplanation: string | null;

  /**
   * Authoritative payment-completion time from v7 verifyToken's <TransactionPaymentDate>.
   * Immutable once set, and only ever settable when lastResultCode === '000' — enforced
   * both by dpo-transaction.service.ts's applyPaymentConfirmationGuard (app layer, always
   * active) and the Postgres guard trigger (production DB layer, see migrations/).
   * Currently parsed assuming UTC — see api/dpo-date.ts — pending confirmation from DPO.
   */
  @Index()
  @Column({ type: Date, nullable: true })
  paymentDate: Date | null;

  /** Unparsed <TransactionPaymentDate> string, retained so a wrong timezone assumption is correctable. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  paymentDateRaw: string | null;

  /** When *we* confirmed Result 000 — i.e. when we found out, not when the payer paid. */
  @Column({ type: Date, nullable: true })
  verifyTokenConfirmedAt: Date | null;

  @Column({ type: Date, nullable: true })
  transactionCreatedDate: Date | null;

  @Column({ type: Date, nullable: true })
  transactionExpiryDate: Date | null;

  @Column({ type: 'date', nullable: true })
  transactionSettlementDate: Date | null;

  @Column({ type: 'varchar', nullable: true })
  customerName: string | null;

  @Column({ type: 'varchar', nullable: true })
  approvalNumber: string | null;

  @Column({ type: 'varchar', nullable: true })
  cardType: string | null;

  @Column({ type: 'varchar', length: 4, nullable: true })
  cardLastFour: string | null;

  /** Card BIN only. Never a full PAN — hosted checkout means we should never receive one. */
  @Column({ type: 'varchar', length: 8, nullable: true })
  cardFirstSix: string | null;

  @Column('decimal', { precision: 14, scale: 4, nullable: true, transformer: decimalTransformer })
  transactionAmount: number | null;

  @Column({ type: 'varchar', length: 3, nullable: true })
  transactionCurrency: string | null;

  @Column('decimal', { precision: 14, scale: 4, nullable: true, transformer: decimalTransformer })
  transactionFinalAmount: number | null;

  @Column({ type: 'varchar', length: 3, nullable: true })
  transactionFinalCurrency: string | null;

  /** Relates to Result 007 (pending split payment). */
  @Column({ type: 'varchar', nullable: true })
  partPaymentRef: string | null;

  /** Separate axis from the result code — a transaction can be paid AND fraud-flagged. */
  @Column({ type: 'varchar', nullable: true })
  fraudAlertCode: string | null;

  @Column('text', { nullable: true })
  fraudExplanation: string | null;
}
