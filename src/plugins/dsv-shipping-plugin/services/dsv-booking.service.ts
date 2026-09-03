/**
 * DSV Booking API Service
 * 
 * Handles integration with DSV Booking API v2
 * - Booking creation (auto-book or draft)
 * - API communication with correct structure
 * - Response parsing
 */

import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import {
    DsvShippingPluginOptions,
    DsvBookingRequest,
    DsvBookingResponse,
} from '../types/plugin-options.types';
import { DsvAuthService } from './dsv-auth.service';

@Injectable()
export class DsvBookingService {
    private options!: DsvShippingPluginOptions;
    private axiosInstance: AxiosInstance;
    private baseUrl: string = '';
    
    constructor(private readonly authService: DsvAuthService) {
        // Basic axios instance - will be configured in init()
        this.axiosInstance = axios.create({
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            timeout: 60000, // Bookings can take longer
        });
    }
    
    /**
     * Initialize service with plugin options
     * Called from handler init()
     */
    init(options: DsvShippingPluginOptions): void {
        this.options = options;
        this.baseUrl = options.auth.apiBaseUrl;
        
        this.axiosInstance.defaults.baseURL = this.baseUrl;
        
        // Initialize auth service
        this.authService.init(options);
        
        this.log('info', 'DSV Booking Service initialized', {
            apiBaseUrl: options.auth.apiBaseUrl,
            bookingEndpoint: options.apiEndpoints.booking,
        });
    }
    
    /**
     * Create booking with DSV API v2
     * Accepts complete DsvBookingRequest structure
     */
    async createBooking(request: DsvBookingRequest): Promise<DsvBookingResponse> {
        this.log('info', 'Creating booking with DSV API v2', {
            autobook: request.autobook,
            product: request.product.name,
            packages: request.packages.length,
        });
        
        try {
            // Get access token
            const accessToken = await this.authService.getAccessToken();
            
            const fullUrl = `${this.baseUrl}${this.options.apiEndpoints.booking}`;
            
            if (this.options.debugMode) {
                console.info('[DSV Booking Service] Request details:', {
                    method: 'POST',
                    url: fullUrl,
                    headers: {
                        'Authorization': 'Bearer ' + accessToken.substring(0, 20) + '...',
                        'DSV-Subscription-Key': this.options.subscriptionKeys.booking ? 
                            '***' + this.options.subscriptionKeys.booking.slice(-4) : 'MISSING',
                    },
                    bodyPreview: {
                        autobook: request.autobook,
                        product: request.product,
                        parties: {
                            sender: request.parties.sender.address.companyName,
                            receiver: request.parties.receiver.address.companyName,
                        },
                        packages: request.packages.length,
                        pickupTime: request.pickupTime?.date,
                        deliveryTime: request.deliveryTime?.date,
                    },
                });
                
                // Log full request in debug mode
                console.info('[DSV Booking Service] Full request body:', JSON.stringify(request, null, 2));
            }
            
            // Call Booking API v2
            const response = await this.axiosInstance.post<DsvBookingResponse>(
                this.options.apiEndpoints.booking,
                request,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'DSV-Subscription-Key': this.options.subscriptionKeys.booking || '',
                    },
                }
            );
            
            const bookingResponse = response.data;
            
            this.log('info', 'Booking created successfully', {
                bookingId: bookingResponse.bookingId,
                shipmentId: bookingResponse.shipmentId,
                status: bookingResponse.status,
            });
            
            return bookingResponse;
            
        } catch (error) {
            this.log('error', 'Failed to create booking with DSV', {
                error: this.formatError(error),
            });
            throw new Error(`DSV Booking API failed: ${this.formatError(error)}`);
        }
    }
    
    /**
     * Format error for logging
     */
    private formatError(error: any): string {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status || 'NO_STATUS';
            const statusText = error.response?.statusText || 'NO_STATUS_TEXT';
            const data = error.response?.data;
            const url = error.config?.url || 'NO_URL';
            
            let errorMsg = `${status} ${statusText} (${url})`;
            
            if (data) {
                if (typeof data === 'string') {
                    errorMsg += ` - ${data}`;
                } else if (data.error) {
                    errorMsg += ` - ${data.error}`;
                } else if (data.message) {
                    errorMsg += ` - ${data.message}`;
                } else {
                    errorMsg += ` - ${JSON.stringify(data)}`;
                }
            }
            
            // Log full error details for debugging
            if (this.options?.debugMode) {
                console.error('[DSV Booking Service] Full error details:', {
                    url,
                    status,
                    statusText,
                    data,
                    headers: error.response?.headers,
                    requestHeaders: error.config?.headers,
                });
                
                // Specifically log field validation errors if present
                if (data?.fields && Array.isArray(data.fields)) {
                    console.error('[DSV Booking Service] Field validation errors:', 
                        JSON.stringify(data.fields, null, 2)
                    );
                }
            }
            
            return errorMsg;
        }
        
        if (error instanceof Error) {
            return error.message;
        }
        
        return String(error);
    }
    
    /**
     * Logging helper
     */
    private log(_level: 'debug' | 'info' | 'error', _message: string, _data?: any): void {
        // logging disabled
    }
}
