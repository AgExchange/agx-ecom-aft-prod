import {
    ChannelService,
    EntityHydrator,
    idsAreEqual,
    Injector,
    Order,
    RequestContext,
    ShippingLine,
    ShippingLineAssignmentStrategy,
} from '@vendure/core';

/**
 * Assigns each ShippingLine to the OrderLines belonging to the same seller Channel.
 *
 * Installing this plugin replaces the server's default ShippingLineAssignmentStrategy (it is a
 * singular VendureConfig property, not an additive list like the eligibility-checkers array).
 * For an order with no seller-channel-scoped lines at all (the existing, non-marketplace LBP
 * checkout path) no ShippingMethod's Channels match a 2-channel seller pattern, so the `channels
 * !== 2` branch falls through and every OrderLine is assigned to the single ShippingLine —
 * identical behaviour to DefaultShippingLineAssignmentStrategy for that case.
 */
export class MultivendorShippingLineAssignmentStrategy implements ShippingLineAssignmentStrategy {
    private entityHydrator: EntityHydrator;
    private channelService: ChannelService;

    init(injector: Injector) {
        this.entityHydrator = injector.get(EntityHydrator);
        this.channelService = injector.get(ChannelService);
    }

    async assignShippingLineToOrderLines(ctx: RequestContext, shippingLine: ShippingLine, order: Order) {
        const defaultChannel = await this.channelService.getDefaultChannel();
        await this.entityHydrator.hydrate(ctx, shippingLine, { relations: ['shippingMethod.channels'] });
        const { channels } = shippingLine.shippingMethod;

        if (channels.length === 2) {
            const sellerChannel = channels.find(c => !idsAreEqual(c.id, defaultChannel.id));
            if (sellerChannel) {
                return order.lines.filter(line => idsAreEqual(line.sellerChannelId, sellerChannel.id));
            }
        }
        return order.lines;
    }
}

export const mvShippingLineAssignmentStrategy = new MultivendorShippingLineAssignmentStrategy();
