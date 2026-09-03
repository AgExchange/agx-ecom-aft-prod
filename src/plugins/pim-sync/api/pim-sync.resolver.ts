import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';
import { PimSyncStatus } from '../types';
import { PimSyncService } from '../services/pim-sync.service';

@Resolver()
export class PimSyncResolver {
    constructor(private pimSyncService: PimSyncService) {}

    @Query()
    @Allow(Permission.SuperAdmin)
    getPimSyncStatus(@Ctx() _ctx: RequestContext): PimSyncStatus {
        return this.pimSyncService.getStatus();
    }

    @Mutation()
    @Allow(Permission.SuperAdmin)
    async triggerPimSync(
        @Ctx() ctx: RequestContext,
        @Args('includePriceStock') includePriceStock?: boolean,
    ): Promise<PimSyncStatus> {
        return this.pimSyncService.enqueueSync(ctx, includePriceStock ?? false);
    }

    @Mutation()
    @Allow(Permission.SuperAdmin)
    async triggerPimDeltaSync(
        @Ctx() ctx: RequestContext,
        @Args('includePriceStock') includePriceStock?: boolean,
    ): Promise<PimSyncStatus> {
        return this.pimSyncService.enqueueDeltaSync(ctx, includePriceStock ?? false);
    }
}
