import { Logger, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';

import { loggerCtx, PAYFAST_PLUGIN_OPTIONS } from './constants';
import { shopApiExtensions } from './api/api-extensions';
import { PayFastResolver } from './api/payfast.resolver';
import { payFastMinimumPaymentEligibilityChecker } from './payfast-minimum-payment.checker';
import { PayFastController } from './payfast.controller';
import { payFastPaymentHandler } from './payfast.handler';
import { PayFastService } from './payfast.service';
import { PayFastPluginOptions } from './types';

/**
 * PayFast payment plugin for Vendure.
 *
 * ## Setup
 *
 * 1. Add to `vendure-config.ts`:
 *    ```ts
 *    PayFastPlugin.init({
 *        vendureHost: process.env.API_HOST,
 *    }),
 *    ```
 *
 * 2. In the Admin UI, create a Payment Method with handler `payfast` and fill in its
 *    `merchantId` / `merchantKey` / `passphrase` / `sandbox` args (these are per-Payment-Method
 *    now, not global env vars — see below).
 * 3. Add the "PayFast — Minimum Order Amount" eligibility checker to the Payment Method
 *    (`payfast-minimum-payment.checker.ts`). PayFast enforces its own minimum transaction
 *    amount per payment method under the hood (around R5 for EFT/Card, R1 for Mobicred) — below
 *    that, PayFast silently reroutes to whichever method qualifies instead of honouring
 *    `payment_method`, which looks exactly like a broken payment-method selector. This checker
 *    hides PayFast from `eligiblePaymentMethods` for orders below the configured minimum
 *    (default R5) so customers never hit that behaviour.
 *
 * ### Multiple PayFast accounts (e.g. Live + Test)
 *
 * Merchant credentials and sandbox mode live on the `payfast` handler's configurable
 * `args` (`merchantId`, `merchantKey`, `passphrase`, `sandbox`), not on `PayFastPlugin.init()`.
 * This means multiple Payment Method entities can all use the `payfast` handler code with
 * different credentials — e.g. a "PayFast Live" Payment Method (sandbox: false, live
 * merchant account) and a "PayFast Test" Payment Method (sandbox: true, sandbox merchant
 * account) can both exist at once, each independently assigned to whichever Channels need
 * them via `assignPaymentMethodsToChannel`. Swapping a channel from Test to Live is then just
 * reassigning which Payment Method is enabled for that channel — no deploy or restart needed.
 *
 * ## Storefront integration
 *
 * The storefront passes its own return and cancel URLs — no storefront URL
 * needs to be configured in the plugin. Multiple storefronts are supported
 * without any code or config changes.
 *
 * ```graphql
 * mutation CreatePayFastPaymentIntent($input: PayFastPaymentIntentInput!) {
 *   createPayFastPaymentIntent(input: $input) {
 *     ... on PayFastPaymentIntent {
 *       redirectUrl   # redirect the browser here
 *     }
 *     ... on PayFastPaymentIntentError {
 *       errorCode
 *       message
 *     }
 *   }
 * }
 * ```
 *
 * Variables:
 * ```json
 * {
 *   "input": {
 *     "returnUrl": "https://my-store.com/checkout/confirmation",
 *     "cancelUrl": "https://my-store.com/checkout/payment?cancelled=1"
 *   }
 * }
 * ```
 *
 * ## Webhook / ITN
 *
 * PayFast will POST to `{vendureHost}/payments/payfast/notify` after each payment.
 * The plugin verifies the signature, confirms the amount, and settles the payment.
 * The channelToken is read from the ITN's `custom_str1` field for multi-channel support.
 *
 * ## Test credentials (sandbox)
 *
 * PayFast's published sandbox account — enter these as a Payment Method's `merchantId`/
 * `merchantKey` args with `sandbox: true`:
 * Merchant ID:  10000100
 * Merchant Key: 46f0cd694581a
 * Sandbox URL:  https://sandbox.payfast.co.za/eng/process
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [PayFastController],
    providers: [
        PayFastService,
        {
            provide: PAYFAST_PLUGIN_OPTIONS,
            useFactory: () => PayFastPlugin.options,
        },
    ],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [PayFastResolver],
    },
    configuration: config => {
        Logger.info('Registering PayFast payment method handler', loggerCtx);
        config.paymentOptions.paymentMethodHandlers.push(payFastPaymentHandler);
        config.paymentOptions.paymentMethodEligibilityCheckers = [
            ...(config.paymentOptions.paymentMethodEligibilityCheckers ?? []),
            payFastMinimumPaymentEligibilityChecker,
        ];
        return config;
    },
    compatibility: '^3.0.0',
})
export class PayFastPlugin {
    static options: PayFastPluginOptions;

    static init(options: PayFastPluginOptions): Type<PayFastPlugin> {
        Logger.info(`PayFastPlugin.init() — vendureHost: ${options.vendureHost}`, loggerCtx);
        this.options = options;
        return PayFastPlugin;
    }
}
