import {
    Channel,
    ChannelService,
    EventBus,
    isGraphQlErrorResult,
    Logger,
    Order,
    OrderService,
    RequestContext,
    RequestContextService,
    ScheduledTask,
    TransactionalConnection,
} from '@vendure/core';
import { In, LessThan } from 'typeorm';

import { loggerCtx } from '../constants';
import { QuoteExpiredEvent } from '../events';
import { QuoteStatus } from '../types';

const OPEN_QUOTE_STATUSES: QuoteStatus[] = ['requested', 'sent'];

/**
 * Marks quotes past their `quoteValidUntil` as `expired` and cancels the order
 * (`Draft -> Cancelled`, via `OrderService.cancelOrder` — see the comment on
 * `QuoteService.rejectQuote` for why a direct `transitionToState` won't work here). Runs
 * per-channel: every `OrderService` read (`findOne`, `updateCustomFields`, …) filters by
 * `ctx.channelId` internally, so a single default-channel context — which is all
 * `ScheduledTask.execute` builds for us — would silently miss every quote outside the
 * default channel in this multi-channel deployment (LBP, etc.). We therefore fetch
 * candidate order ids per channel with a channel-scoped `TransactionalConnection` query,
 * then write each update through a `RequestContext` created for that same channel.
 */
export const quoteExpirySweepTask = new ScheduledTask({
    id: 'quote-expiry-sweep',
    description: 'Marks open quotes past their validity date as expired',
    schedule: cron => cron.every(1).hours(),
    execute: async ({ injector }) => {
        const connection = injector.get(TransactionalConnection);
        const channelService = injector.get(ChannelService);
        const eventBus = injector.get(EventBus);
        const orderService = injector.get(OrderService);
        const requestContextService = injector.get(RequestContextService);

        const { items: channels } = await channelService.findAll(RequestContext.empty());

        let expiredCount = 0;
        for (const channel of channels) {
            expiredCount += await sweepChannel(
                channel,
                connection,
                eventBus,
                orderService,
                requestContextService,
            );
        }

        Logger.info(`Quote expiry sweep: expired ${expiredCount} quote(s)`, loggerCtx);
        return { expiredCount };
    },
});

async function sweepChannel(
    channel: Channel,
    connection: TransactionalConnection,
    eventBus: EventBus,
    orderService: OrderService,
    requestContextService: RequestContextService,
): Promise<number> {
    const ctx = await requestContextService.create({ apiType: 'admin', channelOrToken: channel });

    const candidates = await connection.getRepository(ctx, Order).find({
        select: { id: true },
        where: {
            state: 'Draft',
            channels: { id: ctx.channelId },
            customFields: {
                quoteStatus: In(OPEN_QUOTE_STATUSES),
                quoteValidUntil: LessThan(new Date()),
            },
        },
    });

    // Sequential, not Promise.all: this is a low-frequency housekeeping sweep, and each
    // write goes through the same connection pool as request traffic.
    let expiredCount = 0;
    for (const { id } of candidates) {
        // `getOrderOrThrow` (used internally by `updateCustomFields`) always loads the
        // `customer` relation, so the returned order is ready for `QuoteExpiredEvent`'s
        // recipient-resolution without a further fetch.
        await orderService.updateCustomFields(ctx, id, {
            quoteStatus: 'expired' satisfies QuoteStatus,
        });
        const cancelResult = await orderService.cancelOrder(ctx, {
            orderId: id,
            reason: 'Quote expired',
        });
        if (isGraphQlErrorResult(cancelResult)) {
            Logger.error(
                `Quote expiry sweep: failed to cancel order ${id}: ${cancelResult.message}`,
                loggerCtx,
            );
            continue;
        }
        await eventBus.publish(new QuoteExpiredEvent(ctx, cancelResult));
        expiredCount++;
    }
    return expiredCount;
}
