import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Logger, Permission, RequestContext, UnauthorizedError } from '@vendure/core';

import { loggerCtx } from '../constants';
import { PayFastService } from '../payfast.service';

@Resolver()
export class PayFastResolver {
    constructor(private payFastService: PayFastService) {
        Logger.info('PayFastResolver constructed', loggerCtx);
    }

    @Query()
    @Allow(Permission.Public)
    async payfastAvailablePaymentMethods(@Ctx() ctx: RequestContext) {
        return this.payFastService.getAvailablePaymentMethods(ctx);
    }

    @Mutation()
    @Allow(Permission.Owner)
    async createPayfastPaymentIntent(
        @Ctx() ctx: RequestContext,
        @Args() { input }: { input: { redirectUrl: string; paymentMethod?: string } },
    ) {
        Logger.info(`createPayfastPaymentIntent called — channel: ${ctx.channel.token}, redirectUrl: ${input.redirectUrl}, paymentMethod: ${input.paymentMethod ?? 'all'}`, loggerCtx);
        if (!ctx.authorizedAsOwnerOnly) {
            throw new UnauthorizedError();
        }
        return this.payFastService.initializeTransaction(ctx, input.redirectUrl, input.paymentMethod as any);
    }
}
