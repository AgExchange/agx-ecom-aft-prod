import {
    ChannelService,
    EntityHydrator,
    ID,
    idsAreEqual,
    Injector,
    InternalServerError,
    isGraphQlErrorResult,
    Logger,
    Order,
    OrderLine,
    OrderSellerStrategy,
    OrderService,
    RequestContext,
    SellerService,
    SplitOrderContents,
    Surcharge,
    TransactionalConnection,
} from '@vendure/core';

import {
    PLATFORM_FEE_SURCHARGE_DESCRIPTION,
    PLATFORM_FEE_SURCHARGE_SKU,
    SETTLEMENT_PAYMENT_METHOD_CODE,
    loggerCtx,
} from '../constants';

/**
 * Splits a checked-out aggregate Order into one sub-Order per seller Channel.
 *
 * Real payment (PayFast/Paystack) is collected once, on the aggregate Order, before this
 * strategy ever runs. `afterSellerOrdersCreated` therefore does NOT collect real money — it
 * attaches an internal no-op "settlement" Payment (see mv-settlement-payment-handler.ts) purely
 * so each Seller Order can progress through Vendure's payment-coverage checks, and records a
 * platform-fee Surcharge + payoutStatus for later manual disbursement (see docs in the plugin
 * plan — "the marketplace collects all payments and then later disburses the funds to Sellers").
 */
export class MultivendorSellerStrategy implements OrderSellerStrategy {
    private entityHydrator: EntityHydrator;
    private channelService: ChannelService;
    private connection: TransactionalConnection;
    private orderService: OrderService;
    private sellerService: SellerService;

    init(injector: Injector) {
        this.entityHydrator = injector.get(EntityHydrator);
        this.channelService = injector.get(ChannelService);
        this.connection = injector.get(TransactionalConnection);
        this.orderService = injector.get(OrderService);
        this.sellerService = injector.get(SellerService);
    }

    async setOrderLineSellerChannel(ctx: RequestContext, orderLine: OrderLine) {
        await this.entityHydrator.hydrate(ctx, orderLine.productVariant, { relations: ['channels'] });
        const defaultChannel = await this.channelService.getDefaultChannel();

        // If a ProductVariant is assigned to exactly 2 Channels, then one is the default Channel
        // and the other is the seller's Channel. A variant with only the default Channel (e.g.
        // an ordinary, non-marketplace product) yields no sellerChannel, and the line is treated
        // as belonging to the platform itself — no split occurs for it.
        if (orderLine.productVariant.channels.length === 2) {
            const sellerChannel = orderLine.productVariant.channels.find(
                c => !idsAreEqual(c.id, defaultChannel.id),
            );
            if (sellerChannel) {
                return sellerChannel;
            }
        }
    }

    async splitOrder(ctx: RequestContext, order: Order): Promise<SplitOrderContents[]> {
        const partialOrders = new Map<ID, SplitOrderContents>();
        for (const line of order.lines) {
            const sellerChannelId = line.sellerChannelId;
            if (sellerChannelId) {
                let partialOrder = partialOrders.get(sellerChannelId);
                if (!partialOrder) {
                    partialOrder = {
                        channelId: sellerChannelId,
                        shippingLines: [],
                        lines: [],
                        state: 'ArrangingPayment',
                    };
                    partialOrders.set(sellerChannelId, partialOrder);
                }
                partialOrder.lines.push(line);
            }
        }

        for (const partialOrder of partialOrders.values()) {
            const shippingLineIds = new Set(partialOrder.lines.map(l => l.shippingLineId));
            partialOrder.shippingLines = order.shippingLines.filter(shippingLine =>
                shippingLineIds.has(shippingLine.id),
            );
        }

        return [...partialOrders.values()];
    }

    async afterSellerOrdersCreated(ctx: RequestContext, aggregateOrder: Order, sellerOrders: Order[]) {
        const defaultChannel = await this.channelService.getDefaultChannel();

        for (const sellerOrder of sellerOrders) {
            // Every read/write on `sellerOrder` in this iteration — starting with the very
            // first one below — uses an admin-elevated ctx. Two independent reasons this is
            // required, not decorative:
            //
            // 1. mvSettlementPaymentEligibilityChecker gates the settlement PaymentMethod on
            //    `ctx.apiType === 'admin'` (see addPaymentToOrder below) — the real
            //    customer-visibility boundary for that internal PaymentMethod.
            // 2. MultivendorEntityAccessControlStrategy (mv-entity-access-control-strategy.ts)
            //    hides `OrderType.Seller` rows from every Shop API Order read at the
            //    data-access layer. `ctx` here can be shop-api-scoped (e.g. a customer's own
            //    transitionOrderToState call completing checkout — the expected case, not an
            //    edge case), and `sellerOrder` unavoidably has `type === Seller`. Without
            //    elevation, `entityHydrator.hydrate` below (which internally does
            //    `getRepository(ctx, Order).createQueryBuilder().getOne()` —
            //    entity-hydrator.service.js:117-126, one of the strategy's intercepted read
            //    paths) fails to find the very Order the engine just created, and every
            //    downstream operation in this iteration would fail the same way.
            //
            // `ctx.copy()` is the documented, public way to clone a context (a plain
            // Object.assign under the hood — see @vendure/core/dist/api/common/request-context.js)
            // and, because it's a plain Object.assign, it also carries over the internal
            // transaction-manager reference automatically — the same behaviour Vendure's own
            // core relies on internally (event-bus.js's awaitActiveTransactions). So this is
            // still the SAME already-open database transaction (courtesy of whichever
            // @Transaction()-decorated resolver or manual connection.withTransaction() call is
            // further up the stack — e.g. payfast.service.ts's ITN handler, or the shop-api
            // transitionOrderToState mutation itself) that created `sellerOrder` in the first
            // place — only the apiType changes, never the transaction. A PREVIOUS version of
            // this method built a fresh RequestContext via requestContextService.create()
            // (which always starts with NO transaction attached — it's documented as being for
            // use "outside the request-response cycle") and ran writes inside a NEW, separate
            // connection.withTransaction() call — which in real Postgres cannot see this
            // transaction's still-uncommitted sellerOrder row, and threw `insert or update on
            // table "surcharge" violates foreign key constraint` in production (never caught by
            // e2e, since sql.js doesn't enforce cross-transaction isolation the same way).
            // RequestContext exposes no public setter for apiType, so Reflect.set is used to
            // write the private field directly — this is the one narrowly-scoped place in this
            // plugin that reaches past RequestContext's public API, and only because there is
            // no supported alternative for "same transaction, elevated privilege".
            const sellerOrderAdminCtx = ctx.copy();
            Reflect.set(sellerOrderAdminCtx, '_apiType', 'admin');

            // entityHydrator.hydrate's merged `channels` relation has been observed to carry
            // stale/incorrect field data (correct ids, wrong token/code) for freshly-split
            // Orders in this codepath — the ids themselves are reliable, but the entity data on
            // them is not. Use the ids only, then re-fetch each Channel through the service
            // layer (never raw TypeORM) to get trustworthy data.
            await this.entityHydrator.hydrate(sellerOrderAdminCtx, sellerOrder, { relations: ['channels'] });
            const sellerChannelId = sellerOrder.channels
                .map(c => c.id)
                .find(id => !idsAreEqual(id, defaultChannel.id));
            const sellerChannel = sellerChannelId
                ? await this.channelService.findOne(sellerOrderAdminCtx, sellerChannelId)
                : undefined;
            if (!sellerChannel) {
                throw new InternalServerError(
                    `Could not determine Seller Channel for Order ${sellerOrder.code}`,
                );
            }

            // Rescope `_channel` (no public setter — same Reflect.set pattern as `_apiType`
            // above) to the seller's OWN Channel, not the aggregate order's channel that `ctx`
            // (and therefore `sellerOrderAdminCtx`, a plain copy) carries in. This matters
            // because `PaymentMethodService.getMethodAndOperations` — invoked internally by
            // `addPaymentToOrder` below — scopes its PaymentMethod lookup to `ctx.channelId`
            // (`andWhere('channel.id = :channelId', ...)` in payment-method.service.js). The
            // settlement PaymentMethod is assigned to every Channel at bootstrap specifically so
            // this lookup can't miss (see multivendor.plugin.ts), but that guarantee only holds
            // if the backfill/ChannelEvent-listener assignment for the *aggregate/default*
            // Channel is intact. A gap there (e.g. an unassigned channel) throws
            // `error.payment-method-not-found` from deep inside `OrderSplitter.createSellerOrders`
            // — which propagates out of whatever transaction is driving the split (e.g. a
            // payment webhook's `connection.withTransaction`) and rolls back the customer's real
            // payment along with it, even though the Seller Order's own Channel assignment was
            // never in doubt. Scoping to `sellerChannel` here removes that dependency entirely.
            Reflect.set(sellerOrderAdminCtx, '_channel', sellerChannel);

            // platformFeePercent lives on the Seller entity (Seller.customFields), not a global
            // plugin option — editable per seller via the native Seller detail page's custom
            // fields block. sellerChannel.sellerId is a real FK column (Channel.seller ManyToOne),
            // so no relation hydration is needed to read it.
            const seller = sellerChannel.sellerId
                ? await this.sellerService.findOne(ctx, sellerChannel.sellerId)
                : undefined;
            if (!seller) {
                throw new InternalServerError(
                    `Could not determine Seller for Channel ${sellerChannel.code} (Order ${sellerOrder.code})`,
                );
            }

            const platformFeeAmount = Math.round(
                sellerOrder.subTotalWithTax * (seller.customFields.platformFeePercent / 100),
            );

            // All reads/writes below use `sellerOrderAdminCtx` (built at the top of this loop
            // iteration) — same already-open database transaction as `ctx` (see the comment
            // above), elevated apiType only.
            if (platformFeeAmount > 0) {
                const surcharge = await this.connection.getRepository(sellerOrderAdminCtx, Surcharge).save(
                    new Surcharge({
                        taxLines: [],
                        sku: PLATFORM_FEE_SURCHARGE_SKU,
                        description: PLATFORM_FEE_SURCHARGE_DESCRIPTION,
                        // Negative — this is a deduction from what the seller is owed, not
                        // an additional charge to the customer (the aggregate Order already
                        // collected the full amount before the split).
                        listPrice: -platformFeeAmount,
                        listPriceIncludesTax: true,
                        order: sellerOrder,
                    }),
                );
                // applyPriceAdjustments recalculates totals from the in-memory Order's own
                // `surcharges` relation, not a fresh DB read — without assigning the saved
                // row back here first, it recomputes as if the surcharge didn't exist and
                // desyncs/clears it.
                sellerOrder.surcharges = [surcharge];
                await this.orderService.applyPriceAdjustments(sellerOrderAdminCtx, sellerOrder);
            }

            const paymentResult = await this.orderService.addPaymentToOrder(sellerOrderAdminCtx, sellerOrder.id, {
                method: SETTLEMENT_PAYMENT_METHOD_CODE,
                metadata: {
                    note: `Funded by aggregate order ${aggregateOrder.code} — no real transaction.`,
                },
            });
            if (isGraphQlErrorResult(paymentResult)) {
                throw new InternalServerError(
                    `Failed to settle Seller Order ${sellerOrder.code}: ${paymentResult.message}`,
                );
            }

            await this.orderService.updateCustomFields(sellerOrderAdminCtx, sellerOrder.id, {
                payoutStatus: 'pending',
            });

            Logger.info(
                `Seller Order ${sellerOrder.code} (channel ${sellerChannel.code}) settled internally, ` +
                    `platform fee ${platformFeeAmount}, payoutStatus=pending`,
                loggerCtx,
            );
        }
    }
}
