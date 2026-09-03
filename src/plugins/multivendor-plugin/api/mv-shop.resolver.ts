import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { OrderListOptions } from '@vendure/common/lib/generated-types';
import { Allow, Ctx, Permission, RequestContext, Transaction } from '@vendure/core';

import { MultivendorService } from '../services/mv.service';
import { RegisterSellerServiceInput } from '../types';

@Resolver()
export class MultivendorShopResolver {
    constructor(private multivendorService: MultivendorService) {}

    @Transaction()
    @Mutation()
    @Allow(Permission.Public)
    registerNewSeller(
        @Ctx() ctx: RequestContext,
        @Args() { input }: { input: RegisterSellerServiceInput },
    ) {
        return this.multivendorService.registerSeller(ctx, input);
    }

    @Query()
    @Allow(Permission.Owner)
    myOrders(@Ctx() ctx: RequestContext, @Args() { options }: { options?: OrderListOptions }) {
        return this.multivendorService.myOrders(ctx, options);
    }
}
