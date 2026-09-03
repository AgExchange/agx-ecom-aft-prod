import { ResolveField, Resolver } from '@nestjs/graphql';

/**
 * `__resolveType` implementations for the quote result unions. Apollo cannot infer which
 * member of a union (e.g. `Order | QuoteRequiresLoginError`) a value is at runtime, so a
 * `__resolveType` must be provided for each union that includes the `Order` entity.
 *
 * Our typed error results carry a `__typename`; the `Order` entity does not — so we map
 * anything with a `__typename` to its declared type and fall back to `'Order'`.
 */
function resolveQuoteResultType(value: any): string {
    return value?.__typename ?? 'Order';
}

@Resolver('RequestQuoteResult')
export class RequestQuoteResultResolver {
    @ResolveField()
    __resolveType(value: any): string {
        return resolveQuoteResultType(value);
    }
}

@Resolver('AcceptQuoteResult')
export class AcceptQuoteResultResolver {
    @ResolveField()
    __resolveType(value: any): string {
        return resolveQuoteResultType(value);
    }
}

@Resolver('RejectQuoteResult')
export class RejectQuoteResultResolver {
    @ResolveField()
    __resolveType(value: any): string {
        return resolveQuoteResultType(value);
    }
}

@Resolver('WithdrawQuoteResult')
export class WithdrawQuoteResultResolver {
    @ResolveField()
    __resolveType(value: any): string {
        return resolveQuoteResultType(value);
    }
}
