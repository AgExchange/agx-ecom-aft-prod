import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext, Transaction } from '@vendure/core';

import { MultivendorService } from '../services/mv.service';
import { OnboardSellerServiceInput } from '../types';

@Resolver()
export class MultivendorAdminResolver {
    constructor(private multivendorService: MultivendorService) {}

    @Transaction()
    @Mutation()
    @Allow(Permission.SuperAdmin)
    onboardSeller(
        @Ctx() ctx: RequestContext,
        @Args() { input }: { input: OnboardSellerServiceInput },
    ) {
        const { sellerId, ...rest } = input;
        return this.multivendorService.onboardExistingSeller(ctx, sellerId, rest);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder)
    markPayoutsPaid(@Ctx() ctx: RequestContext, @Args() { orderIds }: { orderIds: string[] }) {
        return this.multivendorService.markPayoutsPaid(ctx, orderIds);
    }
}
