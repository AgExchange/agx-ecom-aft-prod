import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Unique } from 'typeorm';

/**
 * Stores a per-channel, per-year monotonically increasing counter used to generate
 * human-readable quote references (e.g. `Q-2026-00042`). Incrementing is serialised
 * with a pessimistic write lock in {@link QuoteReferenceService} so concurrent quote
 * requests can never produce a duplicate reference.
 */
@Entity()
@Unique(['channelId', 'year'])
export class QuoteSequence extends VendureEntity {
    constructor(input?: DeepPartial<QuoteSequence>) {
        super(input);
    }

    @EntityId()
    channelId: ID;

    @Column()
    year: number;

    @Column({ default: 0 })
    lastValue: number;
}
