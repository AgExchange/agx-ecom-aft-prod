import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, RequestContext, Seller } from '@vendure/core';

import { MultivendorService } from '../services/mv.service';

/**
 * Exposes Seller.channels (admin-API only — see api-extensions.ts) so the Dashboard's native
 * seller-detail page can tell whether a Seller has already been onboarded (has a Channel)
 * without any plugin-side custom-field bookkeeping. Not native to Vendure 3.7 core — unlike
 * Order.aggregateOrder/sellerOrders, which already ship a working resolver.
 */
@Resolver('Seller')
export class MultivendorSellerEntityResolver {
    constructor(private multivendorService: MultivendorService) {}

    @ResolveField()
    channels(@Ctx() ctx: RequestContext, @Parent() seller: Seller) {
        return this.multivendorService.getChannelsForSeller(ctx, seller.id);
    }
}
