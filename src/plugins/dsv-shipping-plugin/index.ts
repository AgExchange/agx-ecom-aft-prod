/**
 * DSV Shipping Plugin - Main Entry Point
 * 
 * Vendure 3.x plugin for DSV shipping integration
 * Phase 1: OAuth + Quote API for real-time shipping rates
 */

import { Logger, PluginCommonModule, VendurePlugin } from '@vendure/core';

const logCtx = 'DsvShippingPlugin';
import { DsvShippingPluginOptions } from './types/plugin-options.types';
import { DsvAuthService } from './services/dsv-auth.service';
import { DsvQuoteService } from './services/dsv-quote.service';
import { DsvBookingService } from './services/dsv-booking.service';
import { dsvRateCalculator, initDsvCalculator } from './calculators/dsv-rate.calculator';
import { dsvShippingEligibilityChecker, initDsvEligibility } from './calculators/dsv-eligibility.checker';
import { dsvFulfillmentHandler, initDsvHandler } from './handlers/dsv-fulfillment.handler';

/**
 * Validate plugin options
 */
function validateOptions(options: DsvShippingPluginOptions): void {
    //console.info('='.repeat(80));
    //console.info('[DSV Plugin] INITIALIZING VERSION 2.0.0 (BOOKING API V2)');
    //console.info('[DSV Plugin] This version includes extensive logging for debugging');
    //console.info('='.repeat(80));
    
    const errors: string[] = [];
    
    // Validate auth configuration
    if (!options.auth) {
        errors.push('auth configuration is required');
    } else {
        if (!options.auth.clientEmail) {
            errors.push('auth.clientEmail is required');
        }
        if (!options.auth.clientPassword) {
            errors.push('auth.clientPassword is required');
        }
        if (!options.auth.accessTokenKey) {
            errors.push('auth.accessTokenKey is required');
        }
        if (!options.auth.apiBaseUrl) {
            errors.push('auth.apiBaseUrl is required (e.g., https://api.dsv.com)');
        }
        if (!options.auth.tokenEndpoint) {
            errors.push('auth.tokenEndpoint is required (e.g., /my-demo/oauth/v1/token)');
        }
    }
    
    // Validate subscription keys
    if (!options.subscriptionKeys) {
        errors.push('subscriptionKeys configuration is required');
    } else {
        // Booking is required for Phase 2
        if (options.features.booking && !options.subscriptionKeys.booking) {
            errors.push('subscriptionKeys.booking is required when booking feature is enabled');
        }
        
        // Quote is optional (Phase 5)
        if (options.features.quote && !options.subscriptionKeys.quote) {
            errors.push('subscriptionKeys.quote is required when quote feature is enabled');
        }
    }
    
    // Validate API endpoints
    if (!options.apiEndpoints) {
        errors.push('apiEndpoints configuration is required');
    } else {
        // Booking endpoint required for Phase 2
        if (options.features.booking && !options.apiEndpoints.booking) {
            errors.push('apiEndpoints.booking is required when booking feature is enabled (e.g., /my-demo/booking/v2)');
        }
        
        // Quote endpoint optional (Phase 5)
        if (options.features.quote && !options.apiEndpoints.quote) {
            errors.push('apiEndpoints.quote is required when quote feature is enabled (e.g., /qs-demo/quote/v1/quotes)');
        }
    }
    
    // Validate test MDM account
    if (!options.testMdmAccount) {
        errors.push('testMdmAccount is required');
    }
    
    // Validate booking defaults (REQUIRED for Phase 2)
    if (!options.bookingDefaults) {
        errors.push('bookingDefaults configuration is required');
    } else {
        if (!options.bookingDefaults.product) {
            errors.push('bookingDefaults.product is required (Road, Air, Sea, or Rail)');
        }
        if (!options.bookingDefaults.packageType) {
            errors.push('bookingDefaults.packageType is required (e.g., CTN, PLT, BAG)');
        }
        if (!options.bookingDefaults.stackable) {
            errors.push('bookingDefaults.stackable is required (STACKABLE or NO)');
        }
        if (!options.bookingDefaults.incoterms || !options.bookingDefaults.incoterms.code) {
            errors.push('bookingDefaults.incoterms.code is required (e.g., EXW, FOB)');
        }
        if (!options.bookingDefaults.incoterms || !options.bookingDefaults.incoterms.location) {
            errors.push('bookingDefaults.incoterms.location is required');
        }
        if (!options.bookingDefaults.pickupTime) {
            errors.push('bookingDefaults.pickupTime configuration is required');
        } else {
            if (!options.bookingDefaults.pickupTime.start) {
                errors.push('bookingDefaults.pickupTime.start is required (e.g., 08:00:00)');
            }
            if (!options.bookingDefaults.pickupTime.end) {
                errors.push('bookingDefaults.pickupTime.end is required (e.g., 17:00:00)');
            }
            if (typeof options.bookingDefaults.pickupTime.daysFromNow !== 'number') {
                errors.push('bookingDefaults.pickupTime.daysFromNow must be a number');
            }
        }
        if (!options.bookingDefaults.deliveryTime) {
            errors.push('bookingDefaults.deliveryTime configuration is required');
        } else {
            if (!options.bookingDefaults.deliveryTime.start) {
                errors.push('bookingDefaults.deliveryTime.start is required (e.g., 08:00:00)');
            }
            if (!options.bookingDefaults.deliveryTime.end) {
                errors.push('bookingDefaults.deliveryTime.end is required (e.g., 17:00:00)');
            }
            if (typeof options.bookingDefaults.deliveryTime.daysFromNow !== 'number') {
                errors.push('bookingDefaults.deliveryTime.daysFromNow must be a number');
            }
        }
        if (!options.bookingDefaults.units) {
            errors.push('bookingDefaults.units configuration is required');
        } else {
            if (!options.bookingDefaults.units.dimension) {
                errors.push('bookingDefaults.units.dimension is required (CM or M)');
            }
            if (!options.bookingDefaults.units.weight) {
                errors.push('bookingDefaults.units.weight is required (KG)');
            }
            if (!options.bookingDefaults.units.volume) {
                errors.push('bookingDefaults.units.volume is required (M3)');
            }
            if (!options.bookingDefaults.units.loadingSpace) {
                errors.push('bookingDefaults.units.loadingSpace is required (LM)');
            }
            if (!options.bookingDefaults.units.temperature) {
                errors.push('bookingDefaults.units.temperature is required (C)');
            }
        }
    }
    
    // Validate features
    if (!options.features) {
        errors.push('features configuration is required');
    }
    
    if (errors.length > 0) {
        throw new Error(`DSV Shipping Plugin configuration errors:\n- ${errors.join('\n- ')}`);
    }
    
    //console.info('[DSV Plugin] ✓ Configuration validation passed');
}

/**
 * DSV Shipping Plugin
 * 
 * Provides DSV shipping integration with booking and fulfillment
 * 
 * @example
 * ```ts
 * // In vendure-config.ts
 * import { DsvShippingPlugin } from './plugins/dsv-shipping-plugin';
 * 
 * export const config: VendureConfig = {
 *   plugins: [
 *     DsvShippingPlugin.init({
 *       auth: {
 *         clientEmail: process.env.DSV_CLIENT_EMAIL!,
 *         clientPassword: process.env.DSV_CLIENT_PASSWORD!,
 *         accessTokenKey: process.env.DSV_ACCESS_TOKEN_KEY!,
 *         apiBaseUrl: process.env.DSV_API_BASE_URL!,
 *         tokenEndpoint: process.env.DSV_TOKEN_ENDPOINT!,
 *       },
 *       subscriptionKeys: {
 *         quote: process.env.DSV_QUOTE_API_KEY,
 *         booking: process.env.DSV_BOOKING_API_KEY!,
 *         tracking: process.env.DSV_TRACKING_API_KEY,
 *       },
 *       apiEndpoints: {
 *         quote: process.env.DSV_QUOTE_ENDPOINT,
 *         booking: process.env.DSV_BOOKING_ENDPOINT!,
 *         tracking: process.env.DSV_TRACKING_ENDPOINT,
 *       },
 *       testMdmAccount: process.env.DSV_TEST_MDM!,
 *       bookingDefaults: {
 *         product: process.env.DSV_DEFAULT_TRANSPORT_MODE! as 'Road' | 'Air' | 'Sea' | 'Rail',
 *         packageType: process.env.DSV_DEFAULT_PACKAGE_TYPE! as any,
 *         stackable: process.env.DSV_DEFAULT_STACKABLE! as 'STACKABLE' | 'NO',
 *         incoterms: {
 *           code: process.env.DSV_DEFAULT_INCOTERMS_CODE!,
 *           location: process.env.DSV_DEFAULT_INCOTERMS_LOCATION!,
 *         },
 *         pickupTime: {
 *           start: process.env.DSV_DEFAULT_PICKUP_START!,
 *           end: process.env.DSV_DEFAULT_PICKUP_END!,
 *           daysFromNow: parseInt(process.env.DSV_DEFAULT_PICKUP_DAYS_FROM_NOW || '1'),
 *         },
 *         deliveryTime: {
 *           start: process.env.DSV_DEFAULT_DELIVERY_START!,
 *           end: process.env.DSV_DEFAULT_DELIVERY_END!,
 *           daysFromNow: parseInt(process.env.DSV_DEFAULT_DELIVERY_DAYS_FROM_NOW || '3'),
 *         },
 *         units: {
 *           dimension: process.env.DSV_DEFAULT_UNIT_DIMENSION! as 'CM' | 'M',
 *           weight: process.env.DSV_DEFAULT_UNIT_WEIGHT! as 'KG',
 *           volume: process.env.DSV_DEFAULT_UNIT_VOLUME! as 'M3',
 *           loadingSpace: process.env.DSV_DEFAULT_UNIT_LOADING_SPACE! as 'LM',
 *           temperature: process.env.DSV_DEFAULT_UNIT_TEMPERATURE! as 'C',
 *         },
 *         insurance: {
 *           enabled: process.env.DSV_INSURANCE_ENABLED === 'true',
 *           category: process.env.DSV_INSURANCE_CATEGORY || 'STD',
 *           currency: process.env.DSV_INSURANCE_CURRENCY || 'ZAR',
 *         },
 *       },
 *       features: {
 *         quote: process.env.DSV_FEATURE_QUOTE === 'true',
 *         booking: process.env.DSV_FEATURE_BOOKING === 'true',
 *         tracking: process.env.DSV_FEATURE_TRACKING === 'true',
 *         webhooks: process.env.DSV_FEATURE_WEBHOOKS === 'true',
 *         labels: process.env.DSV_FEATURE_LABELS === 'true',
 *       },
 *       quoteCacheTTL: parseInt(process.env.DSV_QUOTE_CACHE_TTL || '300'),
 *       debugMode: process.env.DSV_DEBUG_MODE === 'true',
 *     }),
 *   ],
 * };
 * ```
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    
    providers: [
        DsvAuthService,
        DsvQuoteService,
        DsvBookingService,
    ],
    
    configuration: (config) => {
        // Note: We can't check options.features here as this runs before init()
        // Calculator will only work if initialized via init() with features.quote: true
        
        // Register eligibility checker (validates orders before calculating rates)
        if (config.shippingOptions.shippingEligibilityCheckers) {
            config.shippingOptions.shippingEligibilityCheckers.push(dsvShippingEligibilityChecker);
            //console.info('[DSV Plugin] Registered DSV Eligibility Checker');
        }

        // Always register calculator (will be initialized in init() if enabled)
        if (config.shippingOptions.shippingCalculators) {
            config.shippingOptions.shippingCalculators.push(dsvRateCalculator);
            //console.info('[DSV Plugin] Registered DSV Rate Calculator');
        }

        // Always register handler
        config.shippingOptions.fulfillmentHandlers = [
            ...(config.shippingOptions.fulfillmentHandlers || []),
            dsvFulfillmentHandler,
        ];
        //console.info('[DSV Plugin] Registered DSV Fulfillment Handler');
        
        return config;
    },
})
export class DsvShippingPlugin {
    /**
     * Initialize plugin with configuration options
     * 
     * @param options Plugin configuration
     * @returns Configured plugin class
     */
    static init(options: DsvShippingPluginOptions): typeof DsvShippingPlugin {
        //console.info('[DSV Plugin] Initializing DSV Shipping Plugin');
        //console.info('[DSV Plugin] Phase 2: OAuth + Booking API');
        //console.info('[DSV Plugin] API Base URL:', options.auth.apiBaseUrl);
        //console.info('[DSV Plugin] Token Endpoint:', options.auth.tokenEndpoint);
        //console.info('[DSV Plugin] Booking Endpoint:', options.apiEndpoints.booking);

        if (options.features.quote) {
            //console.info('[DSV Plugin] Quote Endpoint (optional):', options.apiEndpoints.quote);
        }
        
        // Validate options
        validateOptions(options);
        
        // Initialize eligibility checker (for Quote API validation)
        initDsvEligibility(options);
        
        // Always initialize calculator (even if quote feature disabled)
        // This prevents initialization errors when calculator is registered
        initDsvCalculator(options);
        
        // Initialize handler (booking required)
        initDsvHandler(options);
        
        Logger.info(`DSV Shipping Plugin v3.0.3 initialized (booking: ${options.features.booking}, quote: ${options.features.quote})`, logCtx);

        return this;
    }
}

// Export types for external use
export * from './types/plugin-options.types';

// Export services (for advanced use cases)
export { DsvAuthService } from './services/dsv-auth.service';
export { DsvQuoteService } from './services/dsv-quote.service';
export { DsvBookingService } from './services/dsv-booking.service';

// Export calculator and eligibility checker
export { dsvRateCalculator } from './calculators/dsv-rate.calculator';
export { dsvShippingEligibilityChecker } from './calculators/dsv-eligibility.checker';

// Export handler
export { dsvFulfillmentHandler } from './handlers/dsv-fulfillment.handler';

