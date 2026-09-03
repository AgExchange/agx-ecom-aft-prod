import { OrderType } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
    ChannelService,
    idsAreEqual,
    Order,
    OrderProcess,
    orderItemsAreDelivered,
    orderItemsArePartiallyDelivered,
    orderItemsArePartiallyShipped,
    orderItemsAreShipped,
    OrderService,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';

let connection: TransactionalConnection;
let orderService: OrderService;
let channelService: ChannelService;
let requestContextService: RequestContextService;

/**
 * Keeps the Aggregate Order's state in sync with its Seller Orders. Appended (not replacing)
 * onto orderOptions.process alongside defaultOrderProcess and any other plugin's process (e.g.
 * quote-plugin's quoteOrderProcess) — see quote-plugin/config/quote-order-process.ts for the same
 * append idiom. Neither process's guard conditions overlap (this one keys off order.type; quote's
 * keys off customFields.quoteReference), so both compose safely.
 */
export const mvOrderProcess: OrderProcess<never> = {
    init(injector) {
        connection = injector.get(TransactionalConnection);
        orderService = injector.get(OrderService);
        channelService = injector.get(ChannelService);
        requestContextService = injector.get(RequestContextService);
    },

    async onTransitionStart(fromState, toState, data) {
        const { ctx, order } = data;
        if (fromState === 'AddingItems' && toState === 'ArrangingPayment') {
            for (const line of order.lines) {
                if (!line.shippingLineId) {
                    return 'not all lines have shipping';
                }
            }
        }

        // Aggregate Orders have no Fulfillments of their own — their fulfillment-driven state
        // (PartiallyShipped/Shipped/etc.) is derived from their Seller Orders in onTransitionEnd
        // below, not validated here.
        if (order.type !== OrderType.Aggregate) {
            const orderWithFulfillments = await findOrderWithFulfillments(ctx, order.id);
            if (toState === 'PartiallyShipped' && !orderItemsArePartiallyShipped(orderWithFulfillments)) {
                return 'message.cannot-transition-unless-some-order-items-shipped';
            }
            if (toState === 'Shipped' && !orderItemsAreShipped(orderWithFulfillments)) {
                return 'message.cannot-transition-unless-all-order-items-shipped';
            }
            if (toState === 'PartiallyDelivered' && !orderItemsArePartiallyDelivered(orderWithFulfillments)) {
                return 'message.cannot-transition-unless-some-order-items-delivered';
            }
            if (toState === 'Delivered' && !orderItemsAreDelivered(orderWithFulfillments)) {
                return 'message.cannot-transition-unless-all-order-items-delivered';
            }
        }
    },

    async onTransitionEnd(fromState, toState, data) {
        const { ctx, order } = data;
        if (order.type !== OrderType.Seller) {
            return;
        }
        if (
            toState !== 'Shipped' &&
            toState !== 'PartiallyShipped' &&
            toState !== 'Delivered' &&
            toState !== 'PartiallyDelivered'
        ) {
            return;
        }

        const aggregateOrder = await orderService.getAggregateOrder(ctx, order);
        if (!aggregateOrder) {
            return;
        }

        // The incoming ctx is scoped to the seller Channel and cannot update the Aggregate
        // Order (which lives in the default Channel) — rebuild an admin ctx on the default
        // Channel, same pattern used throughout this plugin (mv-order-seller-strategy.ts,
        // payfast.service.ts's ITN handler).
        const defaultChannel = await channelService.getDefaultChannel();
        const defaultChannelCtx = await requestContextService.create({
            apiType: 'admin',
            channelOrToken: defaultChannel.token,
            languageCode: ctx.languageCode,
        });

        const otherSellerOrders = (await orderService.getSellerOrders(ctx, aggregateOrder)).filter(
            so => !idsAreEqual(so.id, order.id),
        );
        const sellerOrderStates = [...otherSellerOrders.map(so => so.state), toState];

        if (sellerOrderStates.every(state => state === 'Shipped')) {
            await orderService.transitionToState(defaultChannelCtx, aggregateOrder.id, 'Shipped');
        } else if (sellerOrderStates.every(state => state === 'Delivered')) {
            await orderService.transitionToState(defaultChannelCtx, aggregateOrder.id, 'Delivered');
        } else if (sellerOrderStates.some(state => state === 'Delivered')) {
            await orderService.transitionToState(defaultChannelCtx, aggregateOrder.id, 'PartiallyDelivered');
        } else if (sellerOrderStates.some(state => state === 'Shipped')) {
            await orderService.transitionToState(defaultChannelCtx, aggregateOrder.id, 'PartiallyShipped');
        }
    },
};

async function findOrderWithFulfillments(ctx: RequestContext, id: ID): Promise<Order> {
    return connection.getEntityOrThrow(ctx, Order, id, {
        relations: ['lines', 'fulfillments', 'fulfillments.lines', 'fulfillments.lines.fulfillment'],
    });
}
