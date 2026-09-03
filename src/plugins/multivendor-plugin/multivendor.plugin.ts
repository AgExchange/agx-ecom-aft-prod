import { OnApplicationBootstrap } from '@nestjs/common';
import { ID } from '@vendure/common/lib/shared-types';
import {
    ChannelEvent,
    ChannelService,
    configureDefaultOrderProcess,
    defaultOrderProcess,
    EventBus,
    LanguageCode,
    Logger,
    PaymentMethod,
    PaymentMethodService,
    PluginCommonModule,
    RequestContextService,
    TransactionalConnection,
    Type,
    VendurePlugin,
} from '@vendure/core';

import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { MultivendorAdminResolver } from './api/mv-admin.resolver';
import { MultivendorSellerEntityResolver } from './api/mv-seller-entity.resolver';
import { MultivendorShopResolver } from './api/mv-shop.resolver';
import { mvOrderProcess } from './config/mv-order-process';
import { MultivendorSellerStrategy } from './config/mv-order-seller-strategy';
import {
    mvSettlementPaymentEligibilityChecker,
    mvSettlementPaymentHandler,
} from './config/mv-settlement-payment-handler';
import { mvShippingEligibilityChecker } from './config/mv-shipping-eligibility-checker';
import { mvShippingLineAssignmentStrategy } from './config/mv-shipping-line-assignment-strategy';
import { SETTLEMENT_PAYMENT_METHOD_CODE, loggerCtx } from './constants';
import { MultivendorService } from './services/mv.service';
import './types';

/**
 * Multi-vendor marketplace plugin, adapted from Vendure's reference implementation
 * (https://docs.vendure.io/current/core/how-to/multi-vendor-marketplaces) for agx-stores.
 * See docs/ (plan handoff) for the full list of deliberate deviations — in short: onboarding
 * has both an admin-provisioned and a public self-service entry point, no ShippingMethod or
 * PaymentMethod is auto-created for a new seller Channel, payment is collected once on the
 * Aggregate Order with an internal no-op settlement Payment on each Seller Order, and a
 * platform-fee Surcharge + payoutStatus custom field support later manual disbursement.
 *
 * ## Setup
 *
 * ```ts
 * MultivendorPlugin.init(),
 * ```
 *
 * Self-contained install — no manual edits to orderOptions/shippingOptions/paymentOptions are
 * required beyond adding the plugin to VendureConfig.plugins. After installing, generate a
 * migration with `npx vendure migrate` for the new Seller/Order custom-field columns.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [MultivendorService],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [MultivendorAdminResolver, MultivendorSellerEntityResolver],
    },
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [MultivendorShopResolver],
    },
    configuration: config => {
        config.customFields.Seller.push({
            name: 'sellerOnboardingNote',
            type: 'text',
            nullable: true,
            public: false,
            label: [{ languageCode: LanguageCode.en, value: 'Seller Onboarding Note' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Optional shipping/payment preference captured at onboarding for admin review — does not auto-assign any method.',
                },
            ],
        });

        config.customFields.Seller.push({
            name: 'platformFeePercent',
            type: 'float',
            nullable: false,
            defaultValue: 10,
            min: 0,
            max: 100,
            public: false,
            label: [{ languageCode: LanguageCode.en, value: 'Platform Fee %' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: "Percentage of this seller's Order subtotal deducted as a platform fee at checkout (mv-order-seller-strategy.ts's afterSellerOrdersCreated). Editable per seller on this page — replaces the old global MV_PLATFORM_FEE_PERCENT env var.",
                },
            ],
        });

        config.customFields.Order.push({
            name: 'payoutStatus',
            type: 'string',
            nullable: true,
            public: true,
            readonly: true,
            // See quote-plugin/quote.plugin.ts's quoteStatus field for why both `readonly` and
            // `ui.dashboard: false` are required — readonly alone doesn't stop the Dashboard's
            // generic order-customFields panel from resubmitting the field and getting a
            // server-side rejection.
            ui: { dashboard: false },
            options: [
                { value: 'pending', label: [{ languageCode: LanguageCode.en, value: 'Pending' }] },
                { value: 'paid', label: [{ languageCode: LanguageCode.en, value: 'Paid' }] },
            ],
            label: [{ languageCode: LanguageCode.en, value: 'Payout status' }],
        });

        config.orderOptions.orderSellerStrategy = new MultivendorSellerStrategy();
        // Aggregate Orders never have their own Fulfillments (their Shipped/Delivered state is
        // derived from their Seller Orders — see mv-order-process.ts's onTransitionEnd), so the
        // default process's unconditional checkFulfillmentStates guard must be relaxed, or it
        // rejects transitioning them to Shipped/Delivered — matching the Vendure reference
        // plugin's own mitigation for this. Position 0 is replaced rather than filtered by
        // `=== defaultOrderProcess`: by the time this hook runs, config.orderOptions.process[0]
        // is no longer reference-equal to the imported singleton (confirmed by direct
        // observation — reference filtering silently left the strict guard in place). Position
        // 0 is, by this codebase's convention (processes are appended, never prepended — see
        // quote-plugin's own comment), reliably "the default process" regardless of identity.
        const relaxedDefaultOrderProcess = configureDefaultOrderProcess({ checkFulfillmentStates: false });
        const existingProcesses = config.orderOptions.process ?? [defaultOrderProcess];
        config.orderOptions.process = [
            relaxedDefaultOrderProcess,
            ...existingProcesses.slice(1),
            mvOrderProcess,
        ];

        config.shippingOptions.shippingEligibilityCheckers = [
            ...(config.shippingOptions.shippingEligibilityCheckers ?? []),
            mvShippingEligibilityChecker,
        ];
        config.shippingOptions.shippingLineAssignmentStrategy = mvShippingLineAssignmentStrategy;

        config.paymentOptions.paymentMethodHandlers = [
            ...(config.paymentOptions.paymentMethodHandlers ?? []),
            mvSettlementPaymentHandler,
        ];
        config.paymentOptions.paymentMethodEligibilityCheckers = [
            ...(config.paymentOptions.paymentMethodEligibilityCheckers ?? []),
            mvSettlementPaymentEligibilityChecker,
        ];

        return config;
    },
    compatibility: '^3.0.0',
    dashboard: './dashboard/index.tsx',
})
export class MultivendorPlugin implements OnApplicationBootstrap {
    constructor(
        private connection: TransactionalConnection,
        private requestContextService: RequestContextService,
        private paymentMethodService: PaymentMethodService,
        private channelService: ChannelService,
        private eventBus: EventBus,
    ) {}

    static init(): Type<MultivendorPlugin> {
        return MultivendorPlugin;
    }

    async onApplicationBootstrap(): Promise<void> {
        const paymentMethodId = await this.ensureSettlementPaymentMethodExists();
        await this.assignSettlementPaymentMethodToAllChannels(paymentMethodId);
        this.subscribeSettlementPaymentMethodToNewChannels(paymentMethodId);
    }

    /**
     * Idempotently ensures exactly one PaymentMethod row exists for the internal settlement
     * handler, created in the default Channel. It stays invisible/unusable from the storefront
     * not because of channel assignment but because of `mvSettlementPaymentEligibilityChecker`,
     * which restricts it to `ctx.apiType === 'admin'` — see mv-settlement-payment-handler.ts.
     */
    private async ensureSettlementPaymentMethodExists(): Promise<ID> {
        const existing = await this.connection.rawConnection.getRepository(PaymentMethod).findOne({
            where: { code: SETTLEMENT_PAYMENT_METHOD_CODE },
        });
        if (existing) {
            return existing.id;
        }
        const ctx = await this.requestContextService.create({ apiType: 'admin' });
        const created = await this.paymentMethodService.create(ctx, {
            code: SETTLEMENT_PAYMENT_METHOD_CODE,
            enabled: true,
            handler: { code: mvSettlementPaymentHandler.code, arguments: [] },
            checker: { code: mvSettlementPaymentEligibilityChecker.code, arguments: [] },
            translations: [{ languageCode: LanguageCode.en, name: 'Multivendor Internal Settlement' }],
        });
        Logger.info(`Provisioned internal settlement PaymentMethod "${SETTLEMENT_PAYMENT_METHOD_CODE}"`, loggerCtx);
        return created.id;
    }

    /**
     * `PaymentMethodService.getMethodAndOperations` (used by `addPaymentToOrder`) channel-scopes
     * its lookup to `ctx.channelId`. `afterSellerOrdersCreated` (mv-order-seller-strategy.ts)
     * deliberately settles each Seller Order using the SAME `ctx` (and therefore the SAME
     * already-open database transaction) that created it — building a fresh, channel-rescoped
     * RequestContext there previously started a genuinely separate transaction, which could not
     * see the still-uncommitted Seller Order row and caused `insert or update on table
     * "surcharge" violates foreign key constraint` in production (never caught by e2e — sql.js
     * doesn't enforce real cross-transaction isolation the way Postgres does). So instead of
     * rescoping ctx per-write, the settlement PaymentMethod is assigned to EVERY Channel
     * up-front — safe, since it's invisible/unusable by customers regardless of channel
     * assignment (the real security boundary is `mvSettlementPaymentEligibilityChecker`'s
     * `ctx.apiType === 'admin'` gate, not channel scoping).
     */
    private async assignSettlementPaymentMethodToAllChannels(paymentMethodId: ID): Promise<void> {
        const ctx = await this.requestContextService.create({ apiType: 'admin' });
        // ListQueryBuilder caps `take` at 1000 — paginate rather than assume one page covers
        // every Channel.
        let skip = 0;
        const take = 1000;
        for (;;) {
            const { items, totalItems } = await this.channelService.findAll(ctx, { skip, take });
            if (items.length === 0) {
                break;
            }
            await this.channelService.assignToChannels(
                ctx,
                PaymentMethod,
                paymentMethodId,
                items.map(c => c.id),
            );
            skip += items.length;
            if (skip >= totalItems) {
                break;
            }
        }
    }

    /** Keeps every newly created Channel (seller or otherwise) covered, going forward. */
    private subscribeSettlementPaymentMethodToNewChannels(paymentMethodId: ID): void {
        this.eventBus.ofType(ChannelEvent).subscribe(event => {
            if (event.type !== 'created') {
                return;
            }
            this.requestContextService
                .create({ apiType: 'admin' })
                .then(ctx => this.channelService.assignToChannels(ctx, PaymentMethod, paymentMethodId, [event.entity.id]))
                .catch(err =>
                    Logger.error(
                        `Failed to assign settlement PaymentMethod to new Channel ${event.entity.id}: ${err}`,
                        loggerCtx,
                    ),
                );
        });
    }
}
