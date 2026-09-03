import {
    defaultOrderProcess,
    LanguageCode,
    Logger,
    PluginCommonModule,
    Type,
    VendurePlugin,
} from '@vendure/core';

import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { QuoteAdminResolver } from './api/quote-admin.resolver';
import { QuoteShopResolver } from './api/quote-shop.resolver';
import {
    AcceptQuoteResultResolver,
    RejectQuoteResultResolver,
    RequestQuoteResultResolver,
    WithdrawQuoteResultResolver,
} from './api/quote-union.resolvers';
import { quoteOrderProcess } from './config/quote-order-process';
import { QUOTE_PLUGIN_OPTIONS, loggerCtx } from './constants';
import { QuoteSequence } from './entities/quote-sequence.entity';
import { QuoteReferenceService } from './services/quote-reference.service';
import { quoteExpirySweepTask } from './services/quote-expiry-sweep.task';
import { QuoteService } from './services/quote.service';
import { QuotePluginOptions, QuoteStatus } from './types';

const QUOTE_STATUS_OPTIONS: Array<{ value: QuoteStatus; label: Array<{ languageCode: LanguageCode; value: string }> }> = [
    { value: 'requested', label: [{ languageCode: LanguageCode.en, value: 'Requested' }] },
    { value: 'sent', label: [{ languageCode: LanguageCode.en, value: 'Sent' }] },
    { value: 'accepted', label: [{ languageCode: LanguageCode.en, value: 'Accepted' }] },
    { value: 'rejected', label: [{ languageCode: LanguageCode.en, value: 'Rejected' }] },
    { value: 'expired', label: [{ languageCode: LanguageCode.en, value: 'Expired' }] },
    { value: 'withdrawn', label: [{ languageCode: LanguageCode.en, value: 'Withdrawn' }] },
];

/**
 * Adds a quote workflow to the order system. A quote is a real Order that spends its
 * entire negotiation in Vendure's own `Draft` state (see `quoteOrderProcess`) — never a
 * parallel entity, and never a custom `OrderState`. The negotiation phase is tracked by
 * `customFields.quoteStatus` instead (see `types.ts` for the full rationale).
 *
 * ## Setup
 *
 * ```ts
 * // vendure-config.ts
 * QuotePlugin.init({
 *     defaultQuoteValidityDays: 30,
 *     quoteReferencePrefix: 'Q',
 * }),
 * ```
 *
 * The plugin self-registers its Order custom fields, the custom OrderProcess (combined
 * with `defaultOrderProcess`) and a scheduled expiry-sweep task via its `configuration`
 * function — no manual edits to `orderOptions`/`schedulerOptions` are required. After
 * installing, generate a migration with `npx vendure migrate` to create the custom-field
 * columns and the `quote_sequence` table.
 *
 * Lifecycle (all within `order.state === 'Draft'`, tracked via `quoteStatus`):
 * `requested -> sent -> accepted` (order then transitions `Draft -> ArrangingPayment`),
 * with terminal `rejected` / `expired` / `withdrawn` (the latter returns the order itself
 * to `AddingItems`, i.e. an ordinary cart). `sent` is re-enterable: editing an already-sent
 * quote and re-sending it bumps `quoteRevision` rather than resetting status. All Order
 * writes go through the standard `OrderService`/`orderService.updateCustomFields`, so
 * Vendure's standard events keep firing (the seam a later CRM plugin will hook) and quoted
 * prices are preserved on acceptance (no recalculation).
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [QuoteSequence],
    providers: [
        QuoteService,
        QuoteReferenceService,
        {
            provide: QUOTE_PLUGIN_OPTIONS,
            useFactory: () => QuotePlugin.options,
        },
    ],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [
            QuoteShopResolver,
            RequestQuoteResultResolver,
            AcceptQuoteResultResolver,
            RejectQuoteResultResolver,
            WithdrawQuoteResultResolver,
        ],
    },
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [QuoteAdminResolver],
    },
    configuration: config => {
        config.customFields.Order.push(
            {
                name: 'quoteValidUntil',
                type: 'datetime',
                nullable: true,
                public: true,
                label: [{ languageCode: LanguageCode.en, value: 'Quote valid until' }],
            },
            {
                name: 'quoteReference',
                type: 'string',
                nullable: true,
                public: true,
                label: [{ languageCode: LanguageCode.en, value: 'Quote reference' }],
            },
            {
                name: 'quoteNotes',
                type: 'text',
                nullable: true,
                public: true,
                label: [{ languageCode: LanguageCode.en, value: 'Quote notes' }],
            },
            {
                name: 'quoteAcceptedAt',
                type: 'datetime',
                nullable: true,
                public: true,
                label: [{ languageCode: LanguageCode.en, value: 'Quote accepted at' }],
            },
            {
                name: 'quoteStatus',
                type: 'string',
                nullable: true,
                public: true,
                readonly: true,
                // `ui.dashboard: false` (on top of `readonly`) — see quoteRevision below for why.
                ui: { dashboard: false },
                options: QUOTE_STATUS_OPTIONS,
                label: [{ languageCode: LanguageCode.en, value: 'Quote status' }],
            },
            {
                name: 'quoteRequestedAt',
                type: 'datetime',
                nullable: true,
                public: true,
                readonly: true,
                ui: { dashboard: false },
                label: [{ languageCode: LanguageCode.en, value: 'Quote requested at' }],
            },
            {
                name: 'quoteSentAt',
                type: 'datetime',
                nullable: true,
                public: true,
                readonly: true,
                ui: { dashboard: false },
                label: [{ languageCode: LanguageCode.en, value: 'Quote last sent at' }],
            },
            {
                name: 'quoteRevision',
                type: 'int',
                nullable: true,
                public: true,
                readonly: true,
                // `readonly` alone isn't enough to keep these out of Vendure's built-in
                // "Modify order"/draft-order custom-fields panel: that UI still fetches
                // every `public` custom field into its form state and resubmits the whole
                // customFields blob on save, which the server then rejects (readonly fields
                // aren't part of the generated *CustomFieldsInput* type) —
                // "Field \"quoteStatus\" is not defined by type \"UpdateOrderCustomFieldsInput\"".
                // `ui.dashboard: false` makes the *server* omit these fields from
                // `serverConfig.entityCustomFields` entirely (see
                // GlobalSettingsResolver.generateEntityCustomFieldConfig in @vendure/core),
                // so the Dashboard's generic form never learns they exist, never fetches
                // them, and can never resubmit them. Our own dashboard/index.tsx panel still
                // reads them fine — it uses hand-written GraphQL documents, not the
                // Dashboard's auto-introspected ones — and they remain fully queryable via
                // the Admin/Shop APIs.
                ui: { dashboard: false },
                label: [{ languageCode: LanguageCode.en, value: 'Quote revision' }],
                description: [
                    {
                        languageCode: LanguageCode.en,
                        value: 'Bumped each time an already-sent quote is edited and re-sent.',
                    },
                ],
            },
        );

        // Combine our quote process with whatever is already configured. We append rather
        // than prepend, so a pre-existing `defaultOrderProcess` is never duplicated.
        config.orderOptions.process = [
            ...(config.orderOptions.process ?? [defaultOrderProcess]),
            quoteOrderProcess,
        ];

        // The expiry sweep is a single scheduled task, registered here so installing the
        // plugin is sufficient — no separate wiring in vendure-config.ts.
        config.schedulerOptions.tasks = [...(config.schedulerOptions.tasks ?? []), quoteExpirySweepTask];

        return config;
    },
    compatibility: '^3.0.0',
    dashboard: './dashboard/index.tsx',
})
export class QuotePlugin {
    static options: QuotePluginOptions;

    static init(options: QuotePluginOptions): Type<QuotePlugin> {
        QuotePlugin.options = { quoteReferencePrefix: 'Q', ...options };
        Logger.info(
            `QuotePlugin initialised (validity ${QuotePlugin.options.defaultQuoteValidityDays} days, ` +
                `reference prefix "${QuotePlugin.options.quoteReferencePrefix}")`,
            loggerCtx,
        );
        return QuotePlugin;
    }
}
