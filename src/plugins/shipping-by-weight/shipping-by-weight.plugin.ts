import { PluginCommonModule, Type, VendurePlugin } from '@vendure/core';

import { SHIPPING_BY_WEIGHT_PLUGIN_OPTIONS } from './constants';
import { PluginInitOptions } from './types';
import { weightBasedShippingEligibilityChecker } from './weight-based-shipping-eligibility-checker';
import { weightBasedShippingCalculator } from './weight-based-shipping-calculator';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [{ provide: SHIPPING_BY_WEIGHT_PLUGIN_OPTIONS, useFactory: () => ShippingByWeightPlugin.options }],
    configuration: config => {
        config.shippingOptions.shippingEligibilityCheckers = [
            ...config.shippingOptions.shippingEligibilityCheckers,
            weightBasedShippingEligibilityChecker,
        ];
        config.shippingOptions.shippingCalculators = [
            ...config.shippingOptions.shippingCalculators,
            weightBasedShippingCalculator,
        ];
        return config;
    },
    compatibility: '^3.0.0',
})
export class ShippingByWeightPlugin {
    static options: PluginInitOptions;

    static init(options: PluginInitOptions): Type<ShippingByWeightPlugin> {
        this.options = options;
        return ShippingByWeightPlugin;
    }
}
