import { Injectable } from '@nestjs/common';
import { ID, RequestContext, TransactionalConnection } from '@vendure/core';

import { QuoteSequence } from '../entities/quote-sequence.entity';
import { formatQuoteReference } from '../helpers/quote.helpers';

/**
 * Generates concurrency-safe, sequential, per-channel quote references such as
 * `Q-2026-00042`.
 *
 * Safety model:
 *  1. An insert-or-ignore guarantees the `(channelId, year)` counter row exists without
 *     ever clobbering an existing value (ON CONFLICT DO NOTHING).
 *  2. The row is then read with a `pessimistic_write` lock inside a transaction, so two
 *     concurrent requests serialise on the same row and cannot produce a duplicate.
 *
 * The lock is skipped under the `sqljs` driver (used by `@vendure/testing` e2e specs):
 * sql.js has no real transaction/row-locking support and TypeORM throws
 * "Locking not supported on given driver" for it. sql.js e2e runs are single-connection
 * and effectively single-threaded, so the lock is a no-op there anyway — production
 * (Postgres) is unaffected and always locks.
 */
@Injectable()
export class QuoteReferenceService {
    constructor(private connection: TransactionalConnection) {}

    async next(ctx: RequestContext, prefix: string): Promise<string> {
        const year = new Date().getFullYear();
        const locking = this.connection.rawConnection.options.type !== 'sqljs';
        return this.connection.withTransaction(ctx, async innerCtx => {
            const repo = this.connection.getRepository(innerCtx, QuoteSequence);

            // 1. Ensure the counter row exists, without resetting an existing counter.
            await repo
                .createQueryBuilder()
                .insert()
                .into(QuoteSequence)
                .values({ channelId: innerCtx.channelId, year, lastValue: 0 })
                .orIgnore()
                .execute();

            // 2. Lock the row (where supported) and increment under the lock.
            const row = await repo.findOneOrFail({
                where: { channelId: innerCtx.channelId as ID, year },
                ...(locking ? { lock: { mode: 'pessimistic_write' as const } } : {}),
            });
            row.lastValue += 1;
            await repo.save(row);

            return formatQuoteReference(prefix, year, row.lastValue);
        });
    }
}
