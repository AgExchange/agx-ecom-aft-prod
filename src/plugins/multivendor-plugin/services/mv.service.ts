import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { OrderListOptions, OrderType, Permission } from '@vendure/common/lib/generated-types';
import { normalizeString } from '@vendure/common/lib/normalize-string';
import { ID, PaginatedList } from '@vendure/common/lib/shared-types';
import {
    AdministratorService,
    Channel,
    ChannelService,
    ConfigService,
    CustomerService,
    generatePublicId,
    InternalServerError,
    isGraphQlErrorResult,
    Logger,
    Order,
    OrderService,
    PaymentMethod,
    RequestContext,
    RequestContextService,
    RoleService,
    Seller,
    SellerService,
    StockLocation,
    StockLocationService,
    TransactionalConnection,
    User,
    UserInputError,
} from '@vendure/core';

import { loggerCtx, SETTLEMENT_PAYMENT_METHOD_CODE } from '../constants';
import { OnboardSellerServiceInput, ProvisionVendorInfrastructureInput, RegisterSellerServiceInput } from '../types';

/**
 * Permissions granted to every seller Channel's manager Role. Deliberately narrower than the
 * Vendure reference plugin's list: no Customer create/update/delete (customers are shared
 * platform-wide, not owned by a seller) and no Promotion permissions (promotions are an
 * admin + marketing-agency function, out of scope for sellers).
 */
const SELLER_ROLE_PERMISSIONS: Permission[] = [
    Permission.CreateCatalog,
    Permission.ReadCatalog,
    Permission.UpdateCatalog,
    Permission.DeleteCatalog,
    Permission.CreateOrder,
    Permission.ReadOrder,
    Permission.UpdateOrder,
    Permission.ReadCustomer,
    Permission.ReadPaymentMethod,
    Permission.ReadShippingMethod,
    Permission.ReadCountry,
    Permission.ReadZone,
    Permission.ReadTag,
    Permission.CreateTag,
    Permission.UpdateTag,
];

export interface CreateSellerResult {
    channel: Channel;
    /** Shown once, in the mutation response only — never persisted or logged in plaintext. */
    temporaryPassword: string;
}

@Injectable()
export class MultivendorService {
    constructor(
        private sellerService: SellerService,
        private channelService: ChannelService,
        private roleService: RoleService,
        private administratorService: AdministratorService,
        private stockLocationService: StockLocationService,
        private orderService: OrderService,
        private customerService: CustomerService,
        private configService: ConfigService,
        private requestContextService: RequestContextService,
        private connection: TransactionalConnection,
    ) {}

    /**
     * Admin-facing entry point. Onboards a PRE-EXISTING Seller (created via the native
     * Sellers > New Seller Dashboard screen). Rejects Sellers that already have a Channel —
     * re-running onboarding on an already-provisioned Seller is not supported (no upsert
     * semantics for Channel/Role/Administrator).
     */
    async onboardExistingSeller(
        ctx: RequestContext,
        sellerId: ID,
        input: ProvisionVendorInfrastructureInput,
    ): Promise<CreateSellerResult> {
        const superAdminCtx = await this.getSuperAdminContext(ctx);
        const seller = await this.sellerService.findOne(superAdminCtx, sellerId);
        if (!seller) {
            throw new UserInputError(`Seller with id "${sellerId}" was not found.`);
        }
        const existingChannels = await this.getChannelsForSeller(superAdminCtx, seller.id);
        if (existingChannels.length > 0) {
            throw new UserInputError(
                `Seller "${seller.name}" has already been onboarded (Channel "${existingChannels[0].token}" already exists).`,
            );
        }
        return this.provisionVendorInfrastructure(superAdminCtx, seller, input);
    }

    /**
     * Public shop-facing entry point — the only remaining path that creates the Seller itself.
     * Always performs its privileged work under a freshly built superadmin RequestContext,
     * regardless of the caller's own (anonymous) permissions.
     */
    async registerSeller(ctx: RequestContext, input: RegisterSellerServiceInput): Promise<CreateSellerResult> {
        const superAdminCtx = await this.getSuperAdminContext(ctx);
        const seller = await this.sellerService.create(superAdminCtx, { name: input.shopName });
        return this.provisionVendorInfrastructure(superAdminCtx, seller, input);
    }

    async getChannelsForSeller(ctx: RequestContext, sellerId: ID): Promise<Channel[]> {
        return this.connection.getRepository(ctx, Channel).find({ where: { sellerId } });
    }

    /**
     * Channel.code is meant to be a human-readable identifier (shown throughout the native
     * Channel screens) — unlike Channel.token, it should never just echo the opaque
     * onboarding token. Derived from the Seller's name, with a numeric suffix on collision
     * (two sellers can share a name).
     */
    private async generateUniqueChannelCode(ctx: RequestContext, sellerName: string): Promise<string> {
        const base = normalizeString(sellerName, '-');
        const channelRepository = this.connection.getRepository(ctx, Channel);
        let code = base;
        let suffix = 1;
        while (await channelRepository.findOne({ where: { code } })) {
            suffix++;
            code = `${base}-${suffix}`;
        }
        return code;
    }

    /**
     * The current Customer's own order history — one row per checkout — for the Shop API.
     *
     * `OrderSplitter.createSellerOrders` (@vendure/core) assigns every freshly-split Seller
     * Order to both the seller's own Channel AND the default Channel (needed so Admin API
     * channel-scoped queries can find it regardless of which channel an admin is browsing).
     * That's what let Seller Orders leak into the native `Customer.orders` field
     * (`CustomerEntityResolver.orders` → `OrderService.findByCustomerId`, which filters only
     * on channelId + customerId, never on `Order.type`) — a customer's order history showed
     * the Aggregate Order they actually placed AND one extra row per seller in the cart,
     * duplicating what is really one purchase. This method is the Shop-API-side fix: identical
     * to `findByCustomerId`, but always excludes `OrderType.Seller` — the caller cannot
     * override this via `options.filter.type` (this filter is spread in last).
     *
     * Deliberately NOT implemented via `EntityAccessControlStrategy` (3.6.0
     * experimental/developer-preview row-level filtering) — that was tried and reverted:
     * `OrderSplitter.createSellerOrders` (core, unmodified) reads back the Seller Order it
     * just created — via `OrderService.applyPriceAdjustments` → `OrderCalculator.applyShipping`
     * → `mvShippingEligibilityChecker` → `entityHydrator.hydrate` — using the SAME
     * customer/shop-api-scoped `ctx` that triggered the split, before this plugin's
     * `afterSellerOrdersCreated` hook (mv-order-seller-strategy.ts) ever runs. A row-level
     * strategy gated on `ctx.apiType === 'shop'` has no way to distinguish that internal
     * core read from a genuine customer browsing their order list — both share the exact same
     * ctx.apiType — so it hid the Order from the engine that had just created it and crashed
     * every multi-seller checkout (reproduced in e2e; see docs/multivendor-plugin.md §11).
     */
    async myOrders(ctx: RequestContext, options?: OrderListOptions): Promise<PaginatedList<Order>> {
        if (!ctx.activeUserId) {
            return { items: [], totalItems: 0 };
        }
        const customer = await this.customerService.findOneByUserId(ctx, ctx.activeUserId);
        if (!customer) {
            return { items: [], totalItems: 0 };
        }
        return this.orderService.findByCustomerId(ctx, customer.id, {
            ...options,
            filter: {
                ...options?.filter,
                // Spread last — always wins over anything a caller supplies, so this exclusion
                // can't be overridden from the client side.
                type: { notEq: OrderType.Seller },
            },
        });
    }

    async markPayoutsPaid(ctx: RequestContext, orderIds: ID[]): Promise<Order[]> {
        const results: Order[] = [];
        for (const orderId of orderIds) {
            const order = await this.orderService.findOne(ctx, orderId);
            if (!order || order.type !== OrderType.Seller) {
                continue;
            }
            const updated = await this.orderService.updateCustomFields(ctx, orderId, {
                payoutStatus: 'paid',
            });
            results.push(updated);
        }
        return results;
    }

    /**
     * Extracted from the original createSeller/createSellerChannelRoleAdmin. Takes an EXISTING
     * Seller entity — never creates one — so both entry points above can share it uniformly.
     */
    private async provisionVendorInfrastructure(
        ctx: RequestContext,
        seller: Seller,
        input: ProvisionVendorInfrastructureInput,
    ): Promise<CreateSellerResult> {
        // Channel.token is the opaque value AtroPIM channel codes get pre-coordinated against —
        // Channel.token is non-nullable at the service/GraphQL layer (unlike the Channel
        // entity's own constructor, which auto-generates one when none is supplied), so we
        // generate one ourselves using the same core-provided utility Vendure uses for this
        // exact purpose; generatePublicId()'s collision probability is documented as
        // negligible, so no uniqueness-check loop is needed for it. Admins wanting a specific
        // token to match a pre-coordinated AtroPIM Channel code just supply `token` explicitly.
        // Channel.code is a SEPARATE, human-readable identifier — it must never just equal the
        // token (that defeats the point of having a readable code at all) — so it's always
        // derived from the Seller's name instead, with its own collision handling.
        const token = input.token ?? generatePublicId();
        const code = await this.generateUniqueChannelCode(ctx, seller.name);
        const defaultChannel = await this.channelService.getDefaultChannel(ctx);

        const channelResult = await this.channelService.create(ctx, {
            code,
            token,
            sellerId: seller.id,
            defaultLanguageCode: defaultChannel.defaultLanguageCode,
            defaultCurrencyCode: defaultChannel.defaultCurrencyCode,
            pricesIncludeTax: defaultChannel.pricesIncludeTax,
            defaultTaxZoneId: defaultChannel.defaultTaxZone.id,
            defaultShippingZoneId: defaultChannel.defaultShippingZone.id,
        });
        if (isGraphQlErrorResult(channelResult)) {
            throw new InternalServerError(channelResult.message);
        }
        const channel = channelResult;

        const superAdminRole = await this.roleService.getSuperAdminRole(ctx);
        await this.roleService.assignRoleToChannel(ctx, superAdminRole.id, channel.id);

        const role = await this.roleService.create(ctx, {
            code: `seller-${token}`,
            description: `${seller.name} channel manager`,
            channelIds: [channel.id],
            permissions: SELLER_ROLE_PERMISSIONS,
        });

        const temporaryPassword = randomBytes(18).toString('base64url');
        await this.administratorService.create(ctx, {
            firstName: seller.name,
            lastName: 'Seller Admin',
            emailAddress: input.sellerEmail,
            password: temporaryPassword,
            roleIds: [role.id],
        });

        const stockLocation = await this.stockLocationService.create(ctx, { name: `${seller.name} Stock` });
        await this.channelService.assignToChannels(ctx, StockLocation, stockLocation.id, [channel.id]);

        // The internal settlement PaymentMethod (see mv-settlement-payment-handler.ts) is
        // channel-scoped like any PaymentMethod — PaymentMethodService.getMethodAndOperations
        // requires it to be assigned to whichever channel the addPaymentToOrder call runs
        // under. mv-order-seller-strategy.ts settles each Seller Order under a ctx scoped to
        // that seller's own Channel, so every new seller Channel needs this assignment too, not
        // just the default Channel it was created in.
        const settlementPaymentMethod = await this.connection.rawConnection
            .getRepository(PaymentMethod)
            .findOne({ where: { code: SETTLEMENT_PAYMENT_METHOD_CODE } });
        if (settlementPaymentMethod) {
            await this.channelService.assignToChannels(ctx, PaymentMethod, settlementPaymentMethod.id, [
                channel.id,
            ]);
        }

        // sellerOnboardingNote lives on Seller, not Channel — it's a note about the seller's
        // shipping/payment preference, conceptually a Seller-level fact, and this way it shows
        // up on the native Seller detail page's own Custom Fields block (visible/editable there
        // at any time via the generic Dashboard editor, not just captured once at onboarding).
        if (input.shippingPreferenceNote) {
            await this.sellerService.update(ctx, {
                id: seller.id,
                customFields: { sellerOnboardingNote: input.shippingPreferenceNote },
            });
        }

        Logger.info(
            `Seller "${seller.name}" provisioned — channel code "${code}", token "${token}". ` +
                `No ShippingMethod/PaymentMethod assigned — admin must do this via native channel screens.`,
            loggerCtx,
        );

        return { channel, temporaryPassword };
    }

    private async getSuperAdminContext(ctx: RequestContext): Promise<RequestContext> {
        const { superadminCredentials } = this.configService.authOptions;
        const superAdminUser = await this.connection.getRepository(ctx, User).findOne({
            where: { identifier: superadminCredentials?.identifier },
        });
        if (!superAdminUser) {
            throw new InternalServerError('Could not resolve the superadmin User for seller onboarding.');
        }
        return this.requestContextService.create({
            apiType: 'admin',
            user: superAdminUser,
        });
    }
}
