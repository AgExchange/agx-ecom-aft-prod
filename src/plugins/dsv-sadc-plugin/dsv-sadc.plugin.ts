import { Logger, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import { DSV_SADC_PLUGIN_OPTIONS, loggerCtx } from './constants';
import { DsvSadcPluginOptions } from './types/plugin-options.types';
import { DsvSoapService } from './services/dsv-soap.service';
import { DsvSadcShipmentService } from './services/dsv-shipment.service';
import { DsvSadcCancelService } from './services/dsv-cancel.service';
import { DsvSadcLabelService } from './services/dsv-label.service';
import { DsvSadcAddressService } from './services/dsv-address.service';
import { dsvSadcEligibilityChecker } from './calculators/dsv-sadc-eligibility.checker';
import { dsvSadcPoaEligibilityChecker } from './calculators/dsv-sadc-poa-eligibility.checker';
import { dsvSadcRateCalculator } from './calculators/dsv-sadc-rate.calculator';
import { dsvSadcFulfillmentHandler } from './handlers/dsv-sadc-fulfillment.handler';
import { DsvSadcWebhookController } from './controllers/dsv-sadc-webhook.controller';
import { historyApiExtensions } from './api/history-api-extensions';

@VendurePlugin({
    compatibility: '^3.0.0',
    imports: [PluginCommonModule],
    controllers: [DsvSadcWebhookController],
    adminApiExtensions: {
        schema: historyApiExtensions,
    },
    providers: [
        { provide: DSV_SADC_PLUGIN_OPTIONS, useFactory: () => DsvSadcPlugin.options },
        DsvSoapService,
        DsvSadcShipmentService,
        DsvSadcCancelService,
        DsvSadcLabelService,
        DsvSadcAddressService,
    ],
    configuration: config => {
        config.shippingOptions.shippingEligibilityCheckers = [
            ...(config.shippingOptions.shippingEligibilityCheckers ?? []),
            dsvSadcEligibilityChecker,
            dsvSadcPoaEligibilityChecker,
        ];
        config.shippingOptions.shippingCalculators = [
            ...(config.shippingOptions.shippingCalculators ?? []),
            dsvSadcRateCalculator,
        ];
        config.shippingOptions.fulfillmentHandlers = [
            ...(config.shippingOptions.fulfillmentHandlers ?? []),
            dsvSadcFulfillmentHandler,
        ];
        return config;
    },
})
export class DsvSadcPlugin {
    static options: DsvSadcPluginOptions;

    static init(options: DsvSadcPluginOptions): Type<DsvSadcPlugin> {
        this.validateOptions(options);
        this.options = options;
        Logger.info(
            `DsvSadcPlugin initialized — serviceLevel: ${options.defaults.serviceLevel}, ` +
            `labels: ${options.features.labels}, cancel: ${options.features.cancel}, webhooks: ${options.features.webhooks}`,
            loggerCtx,
        );
        return DsvSadcPlugin;
    }

    private static validateOptions(options: DsvSadcPluginOptions): void {
        const required: (keyof DsvSadcPluginOptions)[] = [
            'apiUrl', 'ediCustomerNumber', 'ediCustomerDepartment',
            'shipperPrefix', 'relationNumber', 'warehouseSearchName',
        ];
        const missing = required.filter(k => !options[k]);
        if (missing.length > 0) {
            throw new Error(`DsvSadcPlugin configuration missing: ${missing.join(', ')}`);
        }
        if (!options.defaults?.serviceLevel) {
            throw new Error('DsvSadcPlugin: defaults.serviceLevel is required');
        }
    }
}
