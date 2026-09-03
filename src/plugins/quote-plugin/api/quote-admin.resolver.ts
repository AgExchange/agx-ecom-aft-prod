import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, Permission, RequestContext, Transaction } from '@vendure/core';
import { OrderListOptions } from '@vendure/common/lib/generated-types';

import { QuoteService } from '../services/quote.service';

/**
 * Admin API resolver for the team-facing quote management operations. Each mutation is
 * wrapped in a transaction so its database changes are atomic.
 */
@Resolver()
export class QuoteAdminResolver {
    constructor(private quoteService: QuoteService) {}

    @Query()
    @Allow(Permission.ReadOrder)
    quotes(@Ctx() ctx: RequestContext, @Args() { options }: { options?: OrderListOptions }) {
        return this.quoteService.findQuotes(ctx, options);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.CreateOrder)
    createQuote(@Ctx() ctx: RequestContext, @Args() { orderId }: { orderId: ID }) {
        return this.quoteService.createQuote(ctx, orderId);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder)
    sendQuote(@Ctx() ctx: RequestContext, @Args() { id }: { id: ID }) {
        return this.quoteService.sendQuote(ctx, id);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder)
    setQuoteValidity(
        @Ctx() ctx: RequestContext,
        @Args() { id, validUntil }: { id: ID; validUntil: Date },
    ) {
        return this.quoteService.setQuoteValidity(ctx, id, validUntil);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder)
    updateQuoteNotes(@Ctx() ctx: RequestContext, @Args() { id, notes }: { id: ID; notes: string }) {
        return this.quoteService.updateQuoteNotes(ctx, id, notes);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder)
    acceptQuote(@Ctx() ctx: RequestContext, @Args() { id }: { id: ID }) {
        return this.quoteService.acceptQuoteAsStaff(ctx, id);
    }
}
