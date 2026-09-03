/**
 * DSV Shipping Rate Calculator v3.0
 * 
 * Calculates shipping cost using one of two methods:
 * 1. Quote API Pricing (toggle ON): Requests real-time pricing from DSV
 * 2. Rules-Based Pricing (toggle OFF): Base price + weight-based calculation
 * 
 * Base/PerKG fields always visible - serve as fallback rates when:
 * - Quote API is disabled
 * - Quote API returns NULL price
 * - Quote API fails
 */

import {
    ShippingCalculator,
    LanguageCode,
    ShippingCalculationResult,
    Injector,
} from '@vendure/core';
import { DsvQuoteService } from '../services/dsv-quote.service';
import { DsvShippingPluginOptions } from '../types/plugin-options.types';
import { buildDsvQuoteRequest } from '../utils/quote-request-builder';

// Module-level variables
let pluginOptions: DsvShippingPluginOptions;
let quoteService: DsvQuoteService;

/**
 * Initialize calculator with plugin options
 */
export function initDsvCalculator(options: DsvShippingPluginOptions): void {
    pluginOptions = options;
}

export const dsvRateCalculator = new ShippingCalculator({
    code: 'dsv-rate-calculator',
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'DSV Shipping Rates - Quote API or Rules-Based',
        },
    ],
    args: {
        useQuoteApi: {
            type: 'boolean',
            defaultValue: false,
            label: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Use Quote API for Pricing',
                },
            ],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Request real-time pricing from DSV Quote API. If disabled or if API fails, uses rules-based calculation below.',
                },
            ],
        },
        basePrice: {
            type: 'int',
            defaultValue: 500, // $5.00
            label: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Base Shipping Price',
                },
            ],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Base shipping cost (used when Quote API disabled, or as fallback when API fails)',
                },
            ],
            ui: {
                component: 'currency-form-input',
            },
        },
        pricePerKg: {
            type: 'int',
            defaultValue: 100, // $1.00 per KG
            label: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Price per KG',
                },
            ],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Additional cost per kilogram (used when Quote API disabled, or as fallback when API fails)',
                },
            ],
            ui: {
                component: 'currency-form-input',
            },
        },
        taxRate: {
            type: 'float',
            defaultValue: 15,
            label: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Tax Rate',
                },
            ],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Tax percentage to apply to shipping cost',
                },
            ],
            ui: {
                component: 'number-form-input',
                suffix: '%',
            },
        },
    },

    init(injector: Injector) {
        quoteService = injector.get(DsvQuoteService);
        if (pluginOptions) {
            quoteService.init(pluginOptions);
            //console.info('[DSV Calculator] Initialized');
        }
    },

    /**
     * Calculate shipping rate for order
     * 
     * MODE 1 (useQuoteApi = true): Request DSV Quote API for actual pricing
     * MODE 2 (useQuoteApi = false): Rules-based calculation (base + weight)
     */
    calculate: async (ctx, order, args): Promise<ShippingCalculationResult> => {
        // Safe defaults for args (handles legacy configs without these fields)
        const useQuoteApi = args.useQuoteApi !== undefined ? args.useQuoteApi : false;
        const basePrice = args.basePrice !== undefined ? args.basePrice : 500; // $5.00
        const pricePerKg = args.pricePerKg !== undefined ? args.pricePerKg : 100; // $1.00
        const taxRate = args.taxRate !== undefined ? args.taxRate : 15;
        
        //console.info('[DSV Calculator] Calculating shipping cost', {
            //orderCode: order.code,
            //mode: useQuoteApi ? 'Quote API' : 'Rules-Based',
        //});

        // Calculate total weight
        let totalWeight = 0;
        for (const line of order.lines) {
            const variantWeight = (line as any).productVariant?.customFields?.weight || 1;
            totalWeight += line.quantity * variantWeight;
        }

        // MODE 1: Quote API Pricing
        if (useQuoteApi) {
            try {
                //console.info('[DSV Calculator] Requesting quote from DSV', {
                    //weight: totalWeight,
                    //destination: `${order.shippingAddress.city}, ${order.shippingAddress.countryCode}`,
                //});

                // Build quote request using shared utility
                const quoteRequest = buildDsvQuoteRequest({ order, totalWeight });
                
                // Request quote from DSV
                const quoteResponse = await quoteService.getQuote(quoteRequest as any);

                // Check if quote has valid price
                const firstQuote = quoteResponse.quotes?.[0];
                
                if (firstQuote?.price?.value && firstQuote.price.value > 0) {
                    // Convert DSV price to cents (assuming DSV returns in currency units)
                    const dsvPrice = Math.round(firstQuote.price.value * 100);

                    //console.info('[DSV Calculator] Using DSV Quote API price', {
                        //quoteCode: quoteResponse.code,
                        //price: dsvPrice,
                        //currency: firstQuote.price.currency,
                    //});

                    return {
                        price: dsvPrice,
                        priceIncludesTax: false,
                        taxRate: taxRate,
                        metadata: {
                            source: 'DSV Quote API',
                            quoteRequestId: quoteResponse.quoteRequestId,
                            quoteCode: quoteResponse.code,
                            quoteStatus: firstQuote.quoteProviderStatus,
                            estimatedDelivery: calculateEstimatedDelivery(),
                            totalWeight,
                        },
                    };
                }

                // Quote returned but price is null - fall back to rules
                //console.warn('[DSV Calculator] Quote price is NULL - falling back to rules-based', {
                    //quoteCode: quoteResponse.code,
                    //quoteStatus: firstQuote?.quoteProviderStatus,
                //});

                // Fallback to rules-based
                const fallbackPrice = basePrice + (totalWeight * pricePerKg);
                
                return {
                    price: fallbackPrice,
                    priceIncludesTax: false,
                    taxRate: taxRate,
                    metadata: {
                        source: 'Rules-Based (Quote API returned NULL price)',
                        quoteCode: quoteResponse.code,
                        quoteStatus: firstQuote?.quoteProviderStatus || 'Unknown',
                        estimatedDelivery: calculateEstimatedDelivery(),
                        totalWeight,
                        note: `DSV Quote: ${quoteResponse.code} (Price unavailable - using fallback rate)`,
                    },
                };

            } catch (error) {
                //console.error('[DSV Calculator] Quote API failed - falling back to rules-based', {
                    //error: error instanceof Error ? error.message : 'Unknown',
                //});

                // Fallback to rules-based
                const fallbackPrice = basePrice + (totalWeight * pricePerKg);
                
                return {
                    price: fallbackPrice,
                    priceIncludesTax: false,
                    taxRate: taxRate,
                    metadata: {
                        source: 'Rules-Based (Quote API failed)',
                        estimatedDelivery: calculateEstimatedDelivery(),
                        totalWeight,
                        note: 'Fallback rate - Quote API error',
                    },
                };
            }
        }

        // MODE 2: Rules-Based Pricing
        const rulesPrice = basePrice + (totalWeight * pricePerKg);

        //console.info('[DSV Calculator] Using rules-based pricing', {
            //basePrice: basePrice,
            //pricePerKg: pricePerKg,
            //weight: totalWeight,
            //total: rulesPrice,
        //});

        return {
            price: rulesPrice,
            priceIncludesTax: false,
            taxRate: taxRate,
            metadata: {
                source: 'Rules-Based',
                estimatedDelivery: calculateEstimatedDelivery(),
                totalWeight,
            },
        };
    },
});

/**
 * Helper: Calculate estimated delivery date (2 days from now)
 */
function calculateEstimatedDelivery(): string {
    const date = new Date();
    date.setDate(date.getDate() + 2);
    return date.toISOString().split('T')[0];
}
