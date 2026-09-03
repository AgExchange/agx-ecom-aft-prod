import { Args, Query, Mutation, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext, Transaction } from '@vendure/core';

import { QuoteService } from '../services/quote.service';

/**
 * Shop API resolver for customer-facing quote operations. Guarded with
 * `Permission.Owner`, which (unlike `Authenticated`) lets anonymous sessions reach the
 * resolver — `requestQuote` then returns a typed `QuoteRequiresLoginError` instead of a
 * 403, so the storefront can prompt for login and retry. Each mutation is wrapped in a
 * transaction so its order-state changes are atomic.
 */
@Resolver()
export class QuoteShopResolver {
    constructor(private quoteService: QuoteService) {}

    @Query()
    @Allow(Permission.Owner)
    quoteByReference(@Ctx() ctx: RequestContext, @Args() { reference }: { reference: string }) {
        return this.quoteService.quoteByReference(ctx, reference);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.Owner)
    requestQuote(@Ctx() ctx: RequestContext) {
        return this.quoteService.requestQuote(ctx);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.Owner)
    withdrawQuoteRequest(@Ctx() ctx: RequestContext, @Args() { orderCode }: { orderCode: string }) {
        return this.quoteService.withdrawQuoteRequest(ctx, orderCode);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.Owner)
    acceptQuote(@Ctx() ctx: RequestContext, @Args() { orderCode }: { orderCode: string }) {
        return this.quoteService.acceptQuote(ctx, orderCode);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.Owner)
    rejectQuote(@Ctx() ctx: RequestContext, @Args() { orderCode }: { orderCode: string }) {
        return this.quoteService.rejectQuote(ctx, orderCode);
    }
}
