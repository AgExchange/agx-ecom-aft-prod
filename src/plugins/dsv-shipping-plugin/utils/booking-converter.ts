/**
 * Booking Converter Utilities
 * 
 * Converts Vendure entities to DSV Booking API v2 structures
 * Includes fallback logic for missing data
 */

import { OrderAddress } from '@vendure/common/lib/generated-types';
import { Customer, Order, OrderLine, StockLocation } from '@vendure/core';
import {
    DsvBookingAddress,
    DsvBookingContact,
    DsvBookingParty,
    DsvBookingParties,
    DsvBookingPackage,
    DsvBookingTime,
    DsvShippingPluginOptions,
} from '../types/plugin-options.types';

/**
 * Convert Vendure Address to DSV Booking API v2 Address
 * Matches working DSV example format exactly
 */
export function convertVendureAddress(
    address: OrderAddress,
    mdm?: string
): DsvBookingAddress {
    return {
        companyName: address.company || 'Private Customer',  // Always provide a value
        addressId: undefined,  // Vendure doesn't have this
        addressLine1: address.streetLine1 || '',
        addressLine2: address.streetLine2 || undefined,
        addressLine3: null,  // DSV expects explicit null if not provided
        city: address.city || 'Unknown',
        countryCode: address.countryCode || '',
        state: address.province || null,  // EXPLICIT null if not provided (not undefined)
        zipCode: address.postalCode || '0000',
        instructions: null,  // DSV expects explicit null if not provided
        mdm: mdm || null,  // Explicit null if not provided (not undefined)
    };
}

/**
 * Convert Vendure Customer/Order to DSV Booking Contact
 * Handles undefined customer with sensible fallbacks
 * Completely safe for test orders without customer data
 * 
 * VERSION: v0.4.6 - READS FROM SHIPPING ADDRESS
 */
export function convertVendureContact(
    customer: Customer | undefined | null,
    order?: Order
): DsvBookingContact {
    //console.info('[DSV Converter v0.4.6] convertVendureContact called', {
        //hasCustomer: !!customer,
        //hasOrder: !!order,
        //hasOrderCustomer: !!order?.customer,
        //hasShippingAddress: !!order?.shippingAddress,
        //customerType: typeof customer,
        //orderCustomerType: typeof order?.customer,
    //});
    
    // Handle completely missing customer - try shipping address first
    if (!customer && !order?.customer) {
        //console.info('[DSV Converter v0.4.6] No customer object - checking shipping address');
        
        // Try to extract from shipping address
        if (order?.shippingAddress) {
            const addr = order.shippingAddress;
            const name = addr.fullName || addr.company || 'Customer';
            const email = 'noreply@example.com'; // Address doesn't have email
            const telephone = addr.phoneNumber || '+27000000000';
            
            //console.info('[DSV Converter v0.4.6] Using shipping address data', {
                //name,
                //telephone,
            //});
            
            return {
                name,
                email,
                telephone,
            };
        }
        
        // Last resort fallback
        //console.info('[DSV Converter v0.4.6] No customer or address data - using fallback');
        return {
            name: 'Customer',
            email: 'noreply@example.com',
            telephone: '+27000000000',
        };
    }
    
    // Use provided customer or fallback to order.customer
    const cust = customer || order?.customer;
    
    //console.info('[DSV Converter v0.4.6] Using customer object', {
        //hasCust: !!cust,
        //custType: typeof cust,
        //hasFirstName: cust ? 'firstName' in cust : false,
        //firstNameValue: cust?.firstName,
    //});
    
    const firstName = cust?.firstName || 'Customer';
    const lastName = cust?.lastName || '';
    const email = cust?.emailAddress || 'noreply@example.com';
    const phone = cust?.phoneNumber || '+27000000000';
    
    const result = {
        name: `${firstName} ${lastName}`.trim() || 'Customer',
        email,
        telephone: phone,
    };
    
    //console.info('[DSV Converter v0.4.6] Returning contact', result);
    
    return result;
}

/**
 * Convert StockLocation to DSV Booking Address with fallback
 * Matches working DSV example format exactly
 */
export function convertStockLocationAddress(
    location: StockLocation | null,
    mdm?: string,
    fallbackOptions?: DsvShippingPluginOptions
): DsvBookingAddress {
    // If no location and no fallback, use minimal defaults
    if (!location && !fallbackOptions) {
        return {
            companyName: 'Warehouse',
            addressId: undefined,
            addressLine1: 'Warehouse Address',
            addressLine2: undefined,
            addressLine3: null,
            city: 'Johannesburg',
            countryCode: 'ZA',
            state: null,  // EXPLICIT null (not undefined)
            zipCode: '2000',
            instructions: null,
            mdm: mdm || null,
        };
    }
    
    // Try to get address from StockLocation custom fields
    const customFields = location?.customFields as any || {};
    
    // Build address from StockLocation or use fallbacks
    return {
        companyName: location?.name || customFields.companyName || 'Warehouse',
        addressId: undefined,  // Vendure doesn't have this
        addressLine1: customFields.addressLine1 || 'Warehouse Address',
        addressLine2: customFields.addressLine2 || undefined,
        addressLine3: null,  // DSV expects explicit null
        city: customFields.city || 'Johannesburg',
        countryCode: customFields.countryCode || 'ZA',
        state: customFields.state || customFields.province || null,  // EXPLICIT null (not undefined)
        zipCode: customFields.zipCode || customFields.postalCode || '2000',
        instructions: null,  // DSV expects explicit null
        mdm: mdm || null,  // Explicit null if not provided
    };
}

/**
 * Convert StockLocation to DSV Booking Contact with fallback
 */
export function convertStockLocationContact(
    location: StockLocation | null
): DsvBookingContact {
    const customFields = location?.customFields as any || {};
    
    return {
        name: customFields.contactName || location?.name || 'Warehouse Manager',
        email: customFields.contactEmail || 'warehouse@company.com',
        telephone: customFields.contactPhone || customFields.telephone || '+27000000000',
    };
}

/**
 * Build all 6 parties for booking request
 * Handles test orders without customer data
 */
export function buildBookingParties(
    order: Order,
    warehouse: StockLocation | null,
    mdm: string,
    options: DsvShippingPluginOptions
): DsvBookingParties {
    // Sender and Pickup = Warehouse
    const warehouseAddress = convertStockLocationAddress(warehouse, undefined, options);
    const warehouseContact = convertStockLocationContact(warehouse);
    
    // Receiver and Delivery = Customer
    // Handle test orders where customer might be completely missing
    const customerAddress = convertVendureAddress(order.shippingAddress);
    const customerContact = convertVendureContact(
        order.customer || undefined, 
        order
    );
    
    return {
        sender: {
            address: warehouseAddress,
            contact: warehouseContact,
        },
        receiver: {
            address: customerAddress,
            contact: customerContact,
        },
        delivery: {
            address: customerAddress,
            contact: customerContact,
        },
        pickup: {
            address: warehouseAddress,
            contact: warehouseContact,
        },
        freightPayer: {
            address: { mdm },
        },
        bookingParty: {
            address: { mdm },
        },
    };
}

/**
 * Calculate pickup/delivery dates and times
 */
export function calculateBookingTime(
    daysFromNow: number,
    start: string,
    end: string
): DsvBookingTime {
    const date = new Date();
    date.setDate(date.getDate() + daysFromNow);
    
    return {
        date: date.toISOString().split('T')[0], // YYYY-MM-DD
        start,
        end,
    };
}

/**
 * Convert Vendure OrderLines to DSV Booking Packages
 * Matches working DSV example format EXACTLY
 */
export function convertToBookingPackages(
    lines: OrderLine[],
    options: DsvShippingPluginOptions
): DsvBookingPackage[] {
    return lines.map((line, index) => {
        const variant = line.productVariant;
        const customFields = variant.customFields as any || {};
        
        // Get dimensions with fallbacks
        const weight = customFields.weight || customFields.shippingWeight || 1;
        const length = customFields.length || customFields.packageLength || 30;
        const width = customFields.width || customFields.packageWidth || 20;
        const height = customFields.height || customFields.packageHeight || 20;
        
        // Calculate volume in m3 (convert from cm3)
        const volumeCm3 = length * width * height;
        const volumeM3 = volumeCm3 / 1000000;
        
        // CRITICAL: Description is REQUIRED by DSV - never leave empty!
        const description = variant.name || variant.sku || `Product ${index + 1}`;
        
        //console.info('[DSV Converter v0.4.8] Package created', {
            //index,
            //variantName: variant.name,
            //variantSku: variant.sku,
            //description,
        //});
        
        // Match working example EXACTLY
        return {
            quantity: line.quantity,
            packageType: options.bookingDefaults.packageType,
            totalWeight: weight * line.quantity,
            netWeight: weight * line.quantity,  // Same as totalWeight for now
            length,
            height,
            width,
            stackable: options.bookingDefaults.stackable,
            totalVolume: volumeM3 * line.quantity,
            palletSpace: null,  // EXPLICIT null like working example
            loadingMeters: 0,  // Default to 0, can be customized
            description,  // REQUIRED - DSV will reject without this
            shippingMarks: line.order?.code || undefined,
        };
    });
}

/**
 * Calculate total weight from packages
 */
export function calculateTotalWeight(packages: DsvBookingPackage[]): number {
    return packages.reduce((sum, pkg) => sum + pkg.totalWeight, 0);
}
