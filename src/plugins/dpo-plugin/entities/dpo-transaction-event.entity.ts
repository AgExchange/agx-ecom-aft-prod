import { DeepPartial } from '@vendure/common/lib/shared-types';
import { VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { DpoTransaction } from './dpo-transaction.entity';

export type DpoTransactionEventType =
  | 'create_token_request'
  | 'create_token_response'
  | 'redirect_return'
  | 'push_callback'
  | 'verify_token_request'
  | 'verify_token_response'
  | 'refund_token_request'
  | 'refund_token_response'
  | 'cancel_token_request'
  | 'cancel_token_response'
  | 'update_token_request'
  | 'update_token_response'
  // Added for verifyRefund (v7), missing from the original spec SQL's CHECK list.
  | 'verify_refund_request'
  | 'verify_refund_response';

/**
 * Append-only audit trail of every DPO API request/response and inbound notification
 * for a transaction. "Append-only" is a convention here, not yet a DB constraint — see
 * the doc's open items. Logged unconditionally, regardless of outcome: a callback for a
 * declined transaction still gets a row.
 *
 * Note: extends VendureEntity per the locked "ships as TypeORM entities" convention, so
 * this also carries an unused createdAt/updatedAt pair alongside occurredAt below — a
 * harmless side effect of that convention, not a modelling error.
 */
@Entity('dpo_transaction_event')
export class DpoTransactionEvent extends VendureEntity {
  constructor(input?: DeepPartial<DpoTransactionEvent>) {
    super(input);
  }

  @Index()
  @ManyToOne(() => DpoTransaction, { onDelete: 'CASCADE' })
  dpoTransaction: DpoTransaction;

  @Index()
  @Column({ type: 'varchar' })
  eventType: DpoTransactionEventType;

  @Column({ type: 'varchar', nullable: true })
  resultCode: string | null;

  @Column('text', { nullable: true })
  resultExplanation: string | null;

  /** Must already have <CompanyToken> redacted by the caller — see service/redact.ts. */
  @Column('text', { nullable: true })
  rawRequestXml: string | null;

  @Column('text', { nullable: true })
  rawResponseXml: string | null;

  @Column({ type: Date, nullable: true })
  startedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  durationMs: number | null;

  @Column({ type: 'int', nullable: true })
  httpStatus: number | null;

  @Index()
  @Column()
  occurredAt: Date;
}
