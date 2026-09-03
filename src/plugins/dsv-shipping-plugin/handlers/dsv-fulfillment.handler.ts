/**
 * DSV Fulfillment Handler
 * 
 * Vendure FulfillmentHandler implementation for DSV shipment creation
 * - Integrates with DSV Booking API v2
 * - Uses StockLocationService for warehouse address
 * - Creates shipments when admin fulfills orders
 * - Returns DSV booking ID as tracking code
 */

import {
    FulfillmentHandler,
    LanguageCode,
    Injector,
    OrderLine,
    TransactionalConnection,
    StockLocationService,
} from '@vendure/core';
import { In } from 'typeorm';
import {
    DsvShippingPluginOptions,
    DsvBookingRequest,
} from '../types/plugin-options.types';
import { DsvAuthService } from '../services/dsv-auth.service';
import { DsvBookingService } from '../services/dsv-booking.service';
import {
    buildBookingParties,
    calculateBookingTime,
    convertToBookingPackages,
} from '../utils/booking-converter';

// Module-level variables
let authService: DsvAuthService;
let bookingService: DsvBookingService;
let stockLocationService: StockLocationService;
let connection: TransactionalConnection;
let pluginOptions: DsvShippingPluginOptions;

/**
 * Initialize handler with plugin options
 */
export function initDsvHandler(options: DsvShippingPluginOptions): void {
    pluginOptions = options;
    //console.info('[DSV Fulfillment Handler] Initializing with options');
}

/**
 * DSV Fulfillment Handler
 * Creates DSV shipments when fulfilling orders
 */
export const dsvFulfillmentHandler = new FulfillmentHandler({
    code: 'dsv-fulfillment',
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Create DSV shipment via Booking API v2',
        },
    ],
    
    args: {
        autoBook: {
            type: 'string',
            list: false,
            label: [{ languageCode: LanguageCode.en, value: 'Auto-Book Shipment' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Automatically book shipment when fulfilling order',
                },
            ],
            defaultValue: 'true',
        },
        
        includeInsurance: {
            type: 'string',
            list: false,
            label: [{ languageCode: LanguageCode.en, value: 'Include Insurance' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Add insurance coverage for shipment value',
                },
            ],
            defaultValue: 'false',
        },
    },
    
    /**
     * Initialize handler
     */
    init(injector: Injector) {
        //console.info('[DSV Fulfillment Handler] Initializing services');
        
        // Get services from injector
        authService = injector.get(DsvAuthService);
        bookingService = injector.get(DsvBookingService);
        stockLocationService = injector.get(StockLocationService);
        connection = injector.get(TransactionalConnection);
        
        // Initialize services
        authService.init(pluginOptions);
        bookingService.init(pluginOptions);
        
        //console.info('[DSV Fulfillment Handler] Services initialized successfully');
    },
    
    /**
     * Create DSV fulfillment when admin fulfills order
     */
    createFulfillment: async (ctx, orders, lines, args) => {
        // Parse string values to booleans
        const autoBook = args.autoBook === 'true';
        const includeInsurance = args.includeInsurance === 'true';
        
        //console.info('[DSV Fulfillment Handler] Creating fulfillment', {
            //orderCount: orders.length,
            //lineCount: lines.length,
            //autoBook,
            //includeInsurance,
        //});
        
        try {
            // Get the first order (typically only one)
            const order = orders[0];
            
            // Get warehouse for current channel
            const stockLocations = await stockLocationService.findAll(ctx);
            const warehouse = stockLocations.items.find(loc => 
                // Find first active warehouse
                // Could filter by channel if needed: loc.channels?.some(c => c.id === ctx.channelId)
                true
            ) || null;
            
            if (!warehouse) {
                //console.warn('[DSV Fulfillment Handler] No warehouse found, using fallback address');
            }
            
            // Load order lines with product variant details
            const orderLineIds = lines.map(l => l.orderLineId);
            const orderLines = await connection.getRepository(ctx, OrderLine).find({
                where: {
                    id: In(orderLineIds),
                },
                relations: {
                    productVariant: true,
                },
            });
            
            // Convert order lines to packages
            const packages = convertToBookingPackages(orderLines, pluginOptions);
            
            //console.info('[DSV Fulfillment Handler] Packages calculated', {
                //packageCount: packages.length,
                //warehouse: warehouse?.name || 'Fallback',
            //});
            
            // Build booking request with correct Booking API v2 structure
            const bookingRequest: DsvBookingRequest = {
                autobook: autoBook,
                
                product: {
                    name: pluginOptions.bookingDefaults.product,
                    dropOff: false,
                },
                
                parties: buildBookingParties(
                    order,
                    warehouse,
                    pluginOptions.testMdmAccount,
                    pluginOptions
                ),
                
                pickupTime: calculateBookingTime(
                    pluginOptions.bookingDefaults.pickupTime.daysFromNow,
                    pluginOptions.bookingDefaults.pickupTime.start,
                    pluginOptions.bookingDefaults.pickupTime.end
                ),
                
                deliveryTime: calculateBookingTime(
                    pluginOptions.bookingDefaults.deliveryTime.daysFromNow,
                    pluginOptions.bookingDefaults.deliveryTime.start,
                    pluginOptions.bookingDefaults.deliveryTime.end
                ),
                
                incoterms: pluginOptions.bookingDefaults.incoterms,
                
                packages,
                
                references: [
                    {
                        value: order.code,
                        type: 'ORDER_NUMBER',
                    },
                ],
                
                units: pluginOptions.bookingDefaults.units,
            };
            
            // Add insurance if enabled and requested
            if (args.includeInsurance && pluginOptions.bookingDefaults.insurance?.enabled) {
                bookingRequest.services = {
                    insurance: {
                        amount: {
                            value: order.totalWithTax / 100, // Convert from cents
                            currency: pluginOptions.bookingDefaults.insurance.currency,
                        },
                        category: pluginOptions.bookingDefaults.insurance.category,
                    },
                };
            }
            
            // Create booking with DSV
            const bookingResponse = await bookingService.createBooking(bookingRequest);
            
            //console.info('[DSV Fulfillment Handler] Booking created', {
                //bookingId: bookingResponse.bookingId,
                //shipmentId: bookingResponse.shipmentId,
                //status: bookingResponse.status,
            //});
            
            // Return fulfillment data to Vendure
            return {
                method: `DSV ${pluginOptions.bookingDefaults.product}`,
                trackingCode: bookingResponse.bookingId,
                customFields: {
                    dsvShipmentId: bookingResponse.shipmentId || bookingResponse.bookingId,
                    dsvTransportMode: bookingResponse.transportMode || pluginOptions.bookingDefaults.product,
                    dsvCarrier: bookingResponse.carrier || 'DSV',
                    dsvEstimatedDelivery: bookingResponse.estimatedDelivery || null,
                    dsvTrackingUrl: bookingResponse.trackingUrl || null,
                },
            };
            
        } catch (error) {
            //console.error('[DSV Fulfillment Handler] Failed to create fulfillment', {
                //error: error instanceof Error ? error.message : String(error),
            //});
            
            // Throw error to prevent fulfillment creation
            throw error;
        }
    },
});
