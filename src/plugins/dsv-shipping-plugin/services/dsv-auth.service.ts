/**
 * DSV Authentication Service
 * 
 * Handles OAuth 2.0 authentication with DSV API
 * - Token acquisition
 * - Automatic token refresh (5 minutes before expiry)
 * - Token caching
 */

import { Injectable } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import {
    DsvShippingPluginOptions,
    DsvTokenResponse,
    CachedToken,
} from '../types/plugin-options.types';

@Injectable()
export class DsvAuthService {
    private options!: DsvShippingPluginOptions;
    private axiosInstance: AxiosInstance;
    private baseUrl: string = '';
    private accessToken: CachedToken | null = null;
    private tokenBufferSeconds = 60; // Refresh 1 minute before expiry (tokens last ~10 min)
    
    constructor() {
        // Basic axios instance - will be configured in init()
        this.axiosInstance = axios.create({
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
            },
            timeout: 30000,
        });
    }
    
    /**
     * Initialize service with plugin options
     * Called from calculator/handler init()
     */
    init(options: DsvShippingPluginOptions): void {
        this.options = options;
        this.baseUrl = options.auth.apiBaseUrl;
        
        this.axiosInstance.defaults.baseURL = this.baseUrl;
        
        this.log('info', 'DSV Auth Service initialized', {
            apiBaseUrl: options.auth.apiBaseUrl,
            tokenEndpoint: options.auth.tokenEndpoint,
        });
    }
    
    /**
     * Get valid access token
     * Tries to refresh using refresh_token first, falls back to new token
     */
    async getAccessToken(): Promise<string> {
        // Check if we have a valid cached token
        if (this.accessToken && this.isTokenValid(this.accessToken)) {
            this.log('debug', 'Using cached access token');
            return this.accessToken.token;
        }
        
        // Try to refresh with refresh token if we have one
        if (this.accessToken?.refreshToken && this.isRefreshTokenValid(this.accessToken)) {
            this.log('info', 'Refreshing access token using refresh_token');
            try {
                return await this.refreshToken(this.accessToken.refreshToken);
            } catch (error) {
                this.log('info', 'Refresh token failed, acquiring new token', {
                    error: this.formatError(error),
                });
            }
        }
        
        // Acquire new token with client_credentials
        this.log('info', 'Acquiring new access token with client_credentials');
        return await this.acquireToken();
    }
    
    /**
     * Check if refresh token is still valid
     */
    private isRefreshTokenValid(cachedToken: CachedToken): boolean {
        if (!cachedToken.refreshExpiresAt) {
            return false;
        }
        const now = new Date();
        return now < cachedToken.refreshExpiresAt;
    }
    
    /**
     * Check if cached token is still valid
     */
    private isTokenValid(cachedToken: CachedToken): boolean {
        const now = new Date();
        const expiresWithBuffer = new Date(
            cachedToken.expiresAt.getTime() - (this.tokenBufferSeconds * 1000)
        );
        return now < expiresWithBuffer;
    }
    
    /**
     * Acquire new access token from DSV OAuth endpoint
     */
    private async acquireToken(): Promise<string> {
        try {
            const params = new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: this.options.auth.clientEmail,
                client_secret: this.options.auth.clientPassword,
            });
            
            const fullUrl = `${this.baseUrl}${this.options.auth.tokenEndpoint}`;
            
            this.log('info', 'Requesting token from DSV', {
                url: fullUrl,
                client_id: this.options.auth.clientEmail,
                grant_type: 'client_credentials',
            });
            
            if (this.options.debugMode) {
                console.info('[DSV Auth Service] Request details:', {
                    method: 'POST',
                    url: fullUrl,
                    body: params.toString(),
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'DSV-Subscription-Key': this.options.auth.accessTokenKey ? '***' + this.options.auth.accessTokenKey.slice(-4) : 'MISSING',
                    },
                });
            }
            
            const response = await this.axiosInstance.post<DsvTokenResponse>(
                this.options.auth.tokenEndpoint,
                params.toString(),
                {
                    headers: {
                        'DSV-Subscription-Key': this.options.auth.accessTokenKey,
                    },
                }
            );
            
            const tokenData = response.data;
            
            // Calculate expiry times
            const expiresAt = new Date();
            expiresAt.setSeconds(expiresAt.getSeconds() + tokenData.expires_in);
            
            const refreshExpiresAt = tokenData.refresh_expires_in 
                ? new Date(Date.now() + (tokenData.refresh_expires_in * 1000))
                : undefined;
            
            // Cache token with refresh token
            this.accessToken = {
                token: tokenData.access_token,
                expiresAt,
                refreshToken: tokenData.refresh_token,
                refreshExpiresAt,
            };
            
            this.log('info', 'Access token acquired successfully', {
                expiresAt: expiresAt.toISOString(),
                expiresIn: tokenData.expires_in,
                hasRefreshToken: !!tokenData.refresh_token,
                refreshExpiresIn: tokenData.refresh_expires_in,
            });
            
            return tokenData.access_token;
            
        } catch (error) {
            this.log('error', 'Failed to acquire access token', {
                error: this.formatError(error),
            });
            throw new Error(`DSV OAuth authentication failed: ${this.formatError(error)}`);
        }
    }
    
    /**
     * Refresh access token using refresh_token
     */
    private async refreshToken(refreshToken: string): Promise<string> {
        try {
            const params = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            });
            
            this.log('debug', 'Refreshing token with refresh_token', {
                url: `${this.baseUrl}${this.options.auth.tokenEndpoint}`,
            });
            
            const response = await this.axiosInstance.post<DsvTokenResponse>(
                this.options.auth.tokenEndpoint,
                params.toString(),
                {
                    headers: {
                        'DSV-Subscription-Key': this.options.auth.accessTokenKey,
                    },
                }
            );
            
            const tokenData = response.data;
            
            // Calculate expiry times
            const expiresAt = new Date();
            expiresAt.setSeconds(expiresAt.getSeconds() + tokenData.expires_in);
            
            const refreshExpiresAt = tokenData.refresh_expires_in 
                ? new Date(Date.now() + (tokenData.refresh_expires_in * 1000))
                : undefined;
            
            // Cache refreshed token
            this.accessToken = {
                token: tokenData.access_token,
                expiresAt,
                refreshToken: tokenData.refresh_token || refreshToken, // Use new or keep old
                refreshExpiresAt,
            };
            
            this.log('info', 'Access token refreshed successfully', {
                expiresAt: expiresAt.toISOString(),
                expiresIn: tokenData.expires_in,
            });
            
            return tokenData.access_token;
            
        } catch (error) {
            this.log('error', 'Failed to refresh access token', {
                error: this.formatError(error),
            });
            throw error; // Let caller handle fallback
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
                console.error('[DSV Auth Service] Full error details:', {
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
