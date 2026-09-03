import { DeepPartial } from '@vendure/common/lib/shared-types';
import { Refund, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { decimalTransformer } from './decimal-transformer';
import { DpoTransaction } from './dpo-transaction.entity';

export type DpoRefundStatus = 'requested' | 'succeeded' | 'failed';

/**
 * One row per refundToken attempt; supports multiple partial refunds per dpo_transaction.
 * Does not yet model verifyRefund (v7) response fields — that operation's field spec is
 * unconfirmed per the doc; only the envelope result/code is captured.
 */
@Entity('dpo_refund')
export class DpoRefund extends VendureEntity {
  constructor(input?: DeepPartial<DpoRefund>) {
    super(input);
  }

  @Index()
  @ManyToOne(() => DpoTransaction, { onDelete: 'CASCADE' })
  dpoTransaction: DpoTransaction;

  @ManyToOne(() => Refund, { nullable: true, onDelete: 'SET NULL' })
  vendureRefund: Refund | null;

  @Column('decimal', { precision: 14, scale: 2, transformer: decimalTransformer })
  refundAmount: number;

  @Column('text', { nullable: true })
  refundDetails: string | null;

  @Index()
  @Column({ type: 'varchar', default: 'requested' })
  status: DpoRefundStatus;

  @Column({ type: 'varchar', nullable: true })
  resultCode: string | null;

  @Column('text', { nullable: true })
  resultExplanation: string | null;

  @Column()
  requestedAt: Date;

  @Column({ type: Date, nullable: true })
  completedAt: Date | null;
}
