/**
 * Package Calculation Utilities
 * 
 * Converts Vendure Order data into DSV package formats
 */

import { Order, OrderLine } from '@vendure/core';
import {
    DsvPackage,
    DsvAddress,
    DsvContact,
    CalculatedPackages,
    DsvUnitsOfMeasurement,
} from '../types/plugin-options.types';

/**
 * Default units of measurement
 */
export const DEFAULT_UNITS: DsvUnitsOfMeasurement = {
    dimension: 'CM',
    weight: 'KG',
    volume: 'M3',
};

/**
 * Calculate packages from order lines
 * Combines all items into logical packages
 */
export function calculatePackages(order: Order): CalculatedPackages {
    const packages: DsvPackage[] = [];
    let totalWeight = 0;
    let totalValue = 0;
    
    // Group items by product variant
    const itemGroups = new Map<string, { line: OrderLine; quantity: number }>();
    
    for (const line of order.lines) {
        const key = line.productVariant.sku;
        const existing = itemGroups.get(key);
        
        if (existing) {
            existing.quantity += line.quantity;
        } else {
            itemGroups.set(key, { line, quantity: line.quantity });
        }
    }
    
    // Convert each group to a package
    for (const [sku, { line, quantity }] of itemGroups) {
        // ---------------------------------------------------------------------
        // NOTE: THIS ENTIRE FILE IS DEAD CODE — it has no callers. None of its five
        // exports (calculatePackages, convertAddress, convertContact,
        // validateOrderForQuote, DEFAULT_UNITS) is referenced anywhere in the plugin.
        //
        // It reads customFields.weight/length/width/height, which do not exist —
        // the real fields are dimensionWeightG / dimensionLengthMm / dimensionWidthMm /
        // dimensionHeightMm, in grams and millimetres.
        //
        // The SAME bug is live in two other files, which do execute:
        //   calculators/dsv-rate.calculator.ts:149   (every quote)
        //   utils/booking-converter.ts:260-263       (every booking)
        // Those two cast with `as any`, which is why the type checker flagged only
        // this dead copy when the plugin was flattened under strict mode.
        //
        // See docs/plugins/dsv-shipping-plugin-dimensions-bug.md. This file should
        // most likely just be deleted as part of that fix.
        // ---------------------------------------------------------------------
        const cf = line.productVariant.customFields as Record<string, unknown> | undefined;

        // Get weight from custom field or use default
        const weightPerItem = (cf?.weight as number) || 1.0; // Default 1kg
        const itemWeight = weightPerItem * quantity;
        
        // Get dimensions from custom fields or use defaults
        const length = (cf?.length as number) || 30; // Default 30cm
        const width = (cf?.width as number) || 20; // Default 20cm
        const height = (cf?.height as number) || 10; // Default 10cm
        
        // Calculate value
        const itemValue = line.proratedLinePrice;
        
        packages.push({
            goodsDescription: line.productVariant.name,
            packageType: determinePackageType(itemWeight, length, width, height),
            quantity: quantity,
            totalWeight: itemWeight,
            length,
            width,
            height,
            value: itemValue,
            currency: order.currencyCode,
        });
        
        totalWeight += itemWeight;
        totalValue += itemValue;
    }
    
    // If no packages created (shouldn't happen), create a default one
    if (packages.length === 0) {
        packages.push({
            goodsDescription: 'General Merchandise',
            packageType: 'CTN', // Carton - correct DSV type
            quantity: 1,
            totalWeight: 1.0,
            length: 30,
            width: 20,
            height: 10,
            value: order.totalWithTax,
            currency: order.currencyCode,
        });
        totalWeight = 1.0;
        totalValue = order.totalWithTax;
    }
    
    return {
        packages,
        totalWeight,
        totalValue,
    };
}

/**
 * Determine appropriate package type based on dimensions and weight
 * Returns correct DSV API package types
 */
function determinePackageType(
    weight: number,
    length: number,
    width: number,
    height: number
): DsvPackage['packageType'] {
    // If very light and small, it's a package
    if (weight < 0.5 && length < 35 && width < 25 && height < 2) {
        return 'PKG'; // Package
    }
    
    // If long and narrow, it's a roll
    if (length > 100 && width < 15 && height < 15) {
        return 'RLL'; // Roll
    }
    
    // If heavy or large, it's a pallet
    if (weight > 500 || length > 120 || width > 100 || height > 100) {
        return 'PLT'; // Pallet
    }
    
    // If very sturdy, it's a crate
    if (weight > 100) {
        return 'CRT'; // Crate
    }
    
    // Default to carton
    return 'CTN'; // Carton
}

/**
 * Convert Vendure OrderAddress to DSV Address
 */
export function convertAddress(address: any, mdm?: string): DsvAddress {
    if (!address) {
        throw new Error('Address is required');
    }
    
    return {
        name: address.fullName || address.company || 'Customer',
        country: address.countryCode || 'ZA', // Default to South Africa
        city: address.city || '',
        zipCode: address.postalCode || '',
        streetLine1: address.streetLine1 || '',
        streetLine2: address.streetLine2 || '',
        mdm,
    };
}

/**
 * Convert Vendure Customer to DSV Contact
 * Safe for undefined/null customer
 * 
 * VERSION: v0.4.4 - DIAGNOSTIC VERSION
 */
export function convertContact(customer: any): DsvContact {
    //console.info('[DSV Converter v0.4.4] convertContact called', {
        //hasCustomer: !!customer,
        //customerType: typeof customer,
    //});
    
    if (!customer) {
        //console.info('[DSV Converter v0.4.4] No customer - using fallback');
        return {
            email: 'noreply@example.com',
            firstName: 'Customer',
            lastName: 'User',
        };
    }
    
    const result = {
        email: customer?.emailAddress || 'noreply@example.com',
        firstName: customer?.firstName || 'Customer',
        lastName: customer?.lastName || 'User',
        phone: customer?.phoneNumber || undefined,
    };
    
    //console.info('[DSV Converter v0.4.4] Returning contact', result);
    
    return result;
}

/**
 * Validate that order has minimum required data for quoting
 */
export function validateOrderForQuote(order: Order): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!order.shippingAddress) {
        errors.push('Order must have a shipping address');
    }
    
    if (!order.lines || order.lines.length === 0) {
        errors.push('Order must have at least one line item');
    }
    
    if (!order.shippingAddress?.countryCode) {
        errors.push('Shipping address must have a country code');
    }
    
    if (!order.shippingAddress?.city) {
        errors.push('Shipping address must have a city');
    }
    
    return {
        valid: errors.length === 0,
        errors,
    };
}
