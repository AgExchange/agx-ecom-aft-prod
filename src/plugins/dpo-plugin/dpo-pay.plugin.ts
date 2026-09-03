import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { DpoPayResolver, dpoPaySchemaExtension } from './api/dpo-pay.resolver';
import { DpoRedirectController } from './api/dpo-redirect.controller';
import { DpoWebhookController } from './api/dpo-webhook.controller';
import { dpoPaymentProcessExtension } from './config/dpo-payment-process';
import { DPO_PAY_PLUGIN_OPTIONS, DpoPluginOptions, validateDpoPluginOptions } from './config/dpo-plugin-options';
import { dpoPaymentHandler } from './dpo-payment-handler';
import { dpoPayEntities } from './entities';
import { DpoRefundService } from './service/dpo-refund.service';
import { DpoRequestContextHelper } from './service/dpo-request-context.helper';
import { DpoTransactionService } from './service/dpo-transaction.service';
import { DpoVerifyAndSettleService } from './service/dpo-verify-and-settle.service';

@VendurePlugin({
  imports: [PluginCommonModule],
  entities: dpoPayEntities,
  controllers: [DpoWebhookController, DpoRedirectController],
  providers: [
    { provide: DPO_PAY_PLUGIN_OPTIONS, useFactory: () => DpoPayPlugin.options },
    DpoTransactionService,
    DpoRequestContextHelper,
    DpoVerifyAndSettleService,
    DpoRefundService,
  ],
  shopApiExtensions: {
    schema: dpoPaySchemaExtension,
    resolvers: [DpoPayResolver],
  },
  configuration: config => {
    validateDpoPluginOptions(DpoPayPlugin.options);
    config.paymentOptions.paymentMethodHandlers.push(dpoPaymentHandler);
    // IMPORTANT: append, never replace. Vendure's mergeConfig treats arrays as a single
    // value that gets replaced wholesale, not merged — overwriting this array would
    // silently drop defaultPaymentProcess, which is what actually drives order-level
    // PaymentSettled/PaymentAuthorized transitions for every payment method in the
    // store, not just this one. See config/dpo-payment-process.ts for the full rationale.
    config.paymentOptions.process = [...(config.paymentOptions.process ?? []), dpoPaymentProcessExtension];
    return config;
  },
  compatibility: '^3.0.0',
})
export class DpoPayPlugin {
  static options: DpoPluginOptions;

  static init(options: DpoPluginOptions) {
    DpoPayPlugin.options = options;
    return DpoPayPlugin;
  }
}
