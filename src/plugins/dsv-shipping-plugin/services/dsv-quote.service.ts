/**
 * DSV Quote API Service
 * 
 * Handles integration with DSV Quote API
 * - Quote request formatting
 * - API communication
 * - Response parsing
 * - Quote caching (5-minute TTL)
 */

import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import NodeCache from 'node-cache';
import {
    DsvShippingPluginOptions,
    DsvQuoteRequest,
    DsvQuoteResponse,
    CachedQuote,
} from '../types/plugin-options.types';
import { DsvAuthService } from './dsv-auth.service';

@Injectable()
export class DsvQuoteService {
    private options!: DsvShippingPluginOptions;
    private axiosInstance: AxiosInstance;
    private baseUrl: string = '';
    private quoteCache: NodeCache;
    
    constructor(private readonly authService: DsvAuthService) {
        // Basic axios instance - will be configured in init()
        this.axiosInstance = axios.create({
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            timeout: 60000, // Quotes can take longer
        });
        
        // Quote cache - TTL set in init()
        this.quoteCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
    }
    
    /**
     * Initialize service with plugin options
     * Called from calculator init()
     */
    init(options: DsvShippingPluginOptions): void {
        this.options = options;
        this.baseUrl = options.auth.apiBaseUrl;
        
        this.axiosInstance.defaults.baseURL = this.baseUrl;
        
        // Initialize auth service
        this.authService.init(options);
        
        // Configure cache TTL
        const ttl = options.quoteCacheTTL || 300;
        this.quoteCache = new NodeCache({ stdTTL: ttl, checkperiod: Math.floor(ttl / 5) });
        
        this.log('info', 'DSV Quote Service initialized', {
            apiBaseUrl: options.auth.apiBaseUrl,
            quoteEndpoint: options.apiEndpoints.quote,
            cacheTTL: ttl,
        });
    }
    
    /**
     * Get shipping quote from DSV API
     * Uses cache if available
     */
    async getQuote(request: DsvQuoteRequest): Promise<DsvQuoteResponse> {
        // Generate cache key from request
        const cacheKey = this.generateCacheKey(request);
        
        // Check cache
        const cachedQuote = this.quoteCache.get<CachedQuote>(cacheKey);
        if (cachedQuote) {
            this.log('info', 'Returning cached quote', {
                quoteId: cachedQuote.quoteId,
                cachedAt: cachedQuote.cachedAt,
            });
            return cachedQuote.response;
        }
        
        // Get fresh quote from API
        this.log('info', 'Requesting quote from DSV API', {
            from: `${request.from?.city}, ${request.from?.country}`,
            to: `${request.to?.city}, ${request.to?.country}`,
            packages: Array.isArray(request.packages) ? request.packages.length : 0,
            totalWeight: request.totalWeight,
        });
        
        try {
            // Get access token
            const accessToken = await this.authService.getAccessToken();
            
            const fullUrl = `${this.baseUrl}${this.options.apiEndpoints.quote}`;
            
            if (this.options.debugMode) {
                console.info('[DSV Quote Service] Request details:', {
                    method: 'POST',
                    url: fullUrl,
                    headers: {
                        'Authorization': 'Bearer ' + accessToken.substring(0, 20) + '...',
                        'DSV-Subscription-Key': this.options.subscriptionKeys.quote ? 
                            '***' + this.options.subscriptionKeys.quote.slice(-4) : 'MISSING',
                    },
                    bodyPreview: {
                        requestedBy: (request as any).requestedBy?.userId,
                        bookingParty: (request as any).bookingParty?.mdm,
                        from: request.from,
                        to: request.to,
                        cargoType: request.cargoType,
                        packages: Array.isArray(request.packages) ? request.packages.length : 0,
                        totalWeight: request.totalWeight,
                    },
                });
            }
            
            // apiEndpoints.quote is optional in DsvApiEndpoints (Quote API is Phase 5).
            // validateOptions() only enforces it when features.quote is enabled, so guard
            // here to fail loudly instead of POSTing to `undefined`.
            const quoteEndpoint = this.options.apiEndpoints.quote;
            if (!quoteEndpoint) {
                throw new Error('DSV Quote API endpoint is not configured (apiEndpoints.quote)');
            }

            // Call Quote API
            const response = await this.axiosInstance.post<DsvQuoteResponse>(
                quoteEndpoint,
                request,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'DSV-Subscription-Key': this.options.subscriptionKeys.quote,
                    },
                }
            );
            
            const quoteResponse = response.data;
            
            // Log full response in debug mode
            if (this.options.debugMode) {
                console.info('[DSV Quote Service] Full response from DSV:', JSON.stringify(quoteResponse, null, 2));
            }
            
            this.log('info', 'Quote received successfully', {
                quoteId: quoteResponse.quoteRequestId,
                quotes: quoteResponse.quotes?.length || 0,
                status: quoteResponse.status,
            });
            
            // Cache the quote
            this.quoteCache.set(cacheKey, {
                quoteId: quoteResponse.quoteRequestId,
                response: quoteResponse,
                cachedAt: new Date(),
            });
            
            return quoteResponse;
            
        } catch (error) {
            this.log('error', 'Failed to get quote from DSV', {
                error: this.formatError(error),
            });
            throw new Error(`DSV Quote API failed: ${this.formatError(error)}`);
        }
    }
    
    /**
     * Generate cache key from quote request
     */
    private generateCacheKey(request: DsvQuoteRequest): string {
        // Create a deterministic key from request properties
        const keyParts = [
            request.from.country,
            request.from.city,
            request.from.zipCode || '',
            request.to.country,
            request.to.city,
            request.to.zipCode || '',
            request.totalWeight.toString(),
            request.packages.length.toString(),
            request.cargoType,
        ];
        
        // Add transport mode specific data
        if (request.air) {
            keyParts.push('air', request.air.serviceLevel || '');
        }
        if (request.sea) {
            keyParts.push('sea', request.sea.serviceLevel || '');
        }
        if (request.road) {
            keyParts.push('road', request.road.serviceLevel || '');
        }
        if (request.rail) {
            keyParts.push('rail', request.rail.serviceLevel || '');
        }
        
        return keyParts.join('|');
    }
    
    /**
     * Clear quote cache
     * Useful for testing or manual cache invalidation
     */
    clearCache(): void {
        this.quoteCache.flushAll();
        this.log('info', 'Quote cache cleared');
    }
    
    /**
     * Get cache statistics
     */
    getCacheStats(): { keys: number; hits: number; misses: number } {
        const stats = this.quoteCache.getStats();
        return {
            keys: stats.keys,
            hits: stats.hits,
            misses: stats.misses,
        };
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
                console.error('[DSV Quote Service] Full error details:', {
                    url,
                    status,
                    statusText,
                    data,
                    headers: error.response?.headers,
                    requestHeaders: error.config?.headers,
                });
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
