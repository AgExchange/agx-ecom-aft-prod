/**
 * DSV Shipping Eligibility Checker v3.0
 * 
 * Determines if DSV shipping is available for an order.
 * 
 * Two validation modes:
 * 1. Quote API Validation (toggle ON): Requests DSV Quote API to verify route exists
 * 2. Minimum Order Value (toggle OFF): Simple order total validation
 */

import {
    ShippingEligibilityChecker,
    LanguageCode,
    Injector,
} from '@vendure/core';
import { DsvQuoteService } from '../services/dsv-quote.service';
import { DsvShippingPluginOptions } from '../types/plugin-options.types';
import { buildDsvQuoteRequest } from '../utils/quote-request-builder';

// Module-level variables
let pluginOptions: DsvShippingPluginOptions;
let quoteService: DsvQuoteService;

/**
 * Initialize eligibility checker with plugin options
 */
export function initDsvEligibility(options: DsvShippingPluginOptions): void {
    pluginOptions = options;
}

export const dsvShippingEligibilityChecker = new ShippingEligibilityChecker({
    code: 'dsv-shipping-eligibility',
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Checks if order is eligible for DSV shipping (validates with Quote API)',
        },
    ],
    args: {
        enableQuoteValidation: {
            type: 'boolean',
            defaultValue: false,
            label: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Enable Quote API Validation',
                },
            ],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Request quote from DSV to verify route availability. If disabled, uses minimum order value validation.',
                },
            ],
        },
        orderMinimum: {
            type: 'int',
            defaultValue: 0,
            label: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Minimum Order Value',
                },
            ],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Order is eligible only if its total is greater or equal to this value (used for both validation modes)',
                },
            ],
            ui: {
                component: 'currency-form-input',
            },
        },
    },

    init(injector: Injector) {
        quoteService = injector.get(DsvQuoteService);
        if (pluginOptions) {
            quoteService.init(pluginOptions);
            //console.info('[DSV Eligibility] Initialized');
        }
    },

    check: async (ctx, order, args) => {
        // Safe defaults for args (handles legacy configs without these fields)
        const enableQuoteValidation = args.enableQuoteValidation !== undefined ? args.enableQuoteValidation : false;
        const orderMinimum = args.orderMinimum !== undefined ? args.orderMinimum : 0;
        
        //console.info('[DSV Eligibility] Checking order eligibility', {
            //orderCode: order.code,
            //orderTotal: order.subTotalWithTax,
            //mode: enableQuoteValidation ? 'Quote API' : 'Minimum Order Value',
            //minimumRequired: orderMinimum,
        //});

        // CHECK 1: Shipping address exists
        if (!order.shippingAddress) {
            //console.error('[DSV Eligibility] ❌ FAILED: No shipping address provided');
            return false;
        }

        // CHECK 2: Country code present
        if (!order.shippingAddress.countryCode) {
            //console.error('[DSV Eligibility] ❌ FAILED: Missing country code', {
                //address: order.shippingAddress,
            //});
            return false;
        }

        // CHECK 3: City present
        if (!order.shippingAddress.city) {
            //console.error('[DSV Eligibility] ❌ FAILED: Missing city', {
                //address: order.shippingAddress,
            //});
            return false;
        }

        //console.info('[DSV Eligibility] ✅ Basic address validation passed', {
            //country: order.shippingAddress.countryCode,
            //city: order.shippingAddress.city,
        //});

        // MODE 1: Quote API Validation
        if (enableQuoteValidation) {
            //console.info('[DSV Eligibility] Using Quote API validation mode');

            try {
                // Calculate total weight
                let totalWeight = 0;
                for (const line of order.lines) {
                    const variantWeight = (line as any).productVariant?.customFields?.weight || 1;
                    totalWeight += line.quantity * variantWeight;
                }

                //console.info('[DSV Eligibility] Requesting quote from DSV', {
                    //weight: totalWeight,
                    //from: 'Johannesburg, ZA',
                    //to: `${order.shippingAddress.city}, ${order.shippingAddress.countryCode}`,
                //});

                // Build quote request using shared utility
                const quoteRequest = buildDsvQuoteRequest({ order, totalWeight });
                
                // Request quote from DSV
                const quoteResponse = await quoteService.getQuote(quoteRequest as any);

                if (quoteResponse?.quoteRequestId) {
                    //console.info('[DSV Eligibility] ✅ PASSED: Quote received - route available', {
                        //quoteRequestId: quoteResponse.quoteRequestId,
                        //quoteCode: quoteResponse.code,
                        //status: quoteResponse.status,
                        //quotesCount: quoteResponse.quotes?.length || 0,
                    //});
                    return true;
                }

                //console.error('[DSV Eligibility] ❌ FAILED: DSV returned no quote (route may not be serviceable)', {
                    //response: quoteResponse,
                //});
                return false;

            } catch (error) {
                //console.error('[DSV Eligibility] ❌ FAILED: Quote API request failed', {
                    //error: error instanceof Error ? error.message : 'Unknown',
                    //stack: error instanceof Error ? error.stack : undefined,
                //});
                return false;
            }
        }

        // MODE 2: Minimum Order Value
        //console.info('[DSV Eligibility] Using Minimum Order Value mode', {
            //orderTotal: order.subTotalWithTax,
            //minimumRequired: orderMinimum,
        //});

        const passes = order.subTotalWithTax >= orderMinimum;

        if (passes) {
            //console.info('[DSV Eligibility] ✅ PASSED: Order total meets minimum', {
                //orderTotal: order.subTotalWithTax,
                //minimum: orderMinimum,
            //});
        } else {
            //console.error('[DSV Eligibility] ❌ FAILED: Order total below minimum', {
                //orderTotal: order.subTotalWithTax,
                //minimum: orderMinimum,
                //shortfall: orderMinimum - order.subTotalWithTax,
            //});
        }

        return passes;
    },
});
