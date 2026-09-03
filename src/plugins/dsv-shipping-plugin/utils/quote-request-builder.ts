/**
 * DSV Quote Request Builder
 * 
 * Shared utility to build complete DSV Quote API v1 requests
 * Used by both eligibility checker and calculator
 */

export interface DsvQuoteRequestParams {
    order: any;
    totalWeight: number;
}

/**
 * Build complete DSV Quote API v1 request
 * 
 * @param order - Vendure Order object
 * @param totalWeight - Total weight in KG
 * @returns Complete quote request matching DSV API schema
 */
export function buildDsvQuoteRequest(params: DsvQuoteRequestParams): any {
    const { order, totalWeight } = params;
    
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const twoDaysOut = new Date(today);
    twoDaysOut.setDate(twoDaysOut.getDate() + 2);

    return {
        // Required: Who is requesting the quote
        requestedBy: {
            userId: 'system@vendure.io',
            name: 'Vendure System',
            firstName: 'Vendure',
            lastName: 'System',
            email: 'system@vendure.io',
            language: 'en',
            phone: '+27000000000',
        },
        
        // Required: When quote was requested
        requestDate: today.toISOString().split('T')[0],
        
        // Required: When shipment will be ready
        readyForBookDate: tomorrow.toISOString(),
        
        // Required: Who is paying for freight
        bookingParty: {
            mdm: '2838182313',
            mainMdm: '2838182313',
            name: 'Test Company',
            address1: 'Test Address',
            country: 'ZA',
            state: null,
            zipCode: '2000',
            city: 'Johannesburg',
        },
        
        // Required: Pickup type
        pickupType: 'DSV',
        
        // Required: From location (warehouse)
        from: {
            mdm: null,
            mainMdm: null,
            name: 'Test Pickup Location',
            address1: 'Warehouse Address Line 1',
            country: 'ZA',
            state: null,
            zipCode: '2000',
            city: 'Johannesburg',
        },
        
        // Required: To location (customer)
        to: {
            country: order.shippingAddress.countryCode,
            state: order.shippingAddress.province || null,
            zipCode: order.shippingAddress.postalCode || '0000',
            city: order.shippingAddress.city,
        },
        
        // Required: Pickup and delivery dates
        pickupDate: tomorrow.toISOString().split('T')[0],
        deliveryDate: twoDaysOut.toISOString().split('T')[0],
        
        // Optional: References
        references: [
            {
                name: 'Order Reference',
                type: 'Shipper',
                value: order.code || 'TEST-ORDER',
            }
        ],
        
        // Optional: Insurance
        insurance: null,
        
        // Required: Cargo type
        cargoType: 'LCL',
        
        // Required: Packages array with ALL required fields
        packages: [{
            goodsDescription: `Order ${order.code || 'items'}`,
            packageType: 'CTN',
            quantity: order.lines.reduce((sum: number, line: any) => sum + line.quantity, 0),
            length: 30,
            width: 20,
            height: 20,
            totalWeight: totalWeight,
            totalVolume: 0.012,
            stackable: 'Stackable',
            palletSpace: null,
            loadMeters: 0,
            temperatureControlled: {
                minTemperature: 0,
                maxTemperature: 0,
            },
            dangerousGoods: [],
        }],
        
        // Required: Units of measurement
        unitsOfMeasurement: {
            dimension: 'CM',
            weight: 'KG',
            volume: 'M3',
            temperature: 'C',
        },
        
        // Required: Total weight
        totalWeight: totalWeight,
        
        // Required: Source
        source: 'Public',
        
        // Optional: Air transport details
        air: {
            originAirport: 'GBLHR',
            destinationAirport: 'BEBRU',
            batteries: 'None',
            incoterms: {
                code: 'EXW',
                location: 'Warehouse',
            },
            serviceLevel: 'Standard',
            notes: 'Test notes',
        },
        
        // Optional: Sea transport details
        sea: {
            originPort: 'GBLGP',
            destinationPort: 'BEZEE',
            incoterms: {
                code: 'EXW',
                location: 'Warehouse',
            },
            serviceLevel: 'Standard',
            notes: 'Test notes',
        },
        
        // Required for Road: Road-specific details
        road: {
            incoterms: {
                code: 'EXW',
                location: 'Warehouse',
            },
            serviceAndSurchargeIds: [
                '3fa85f64-5717-4562-b3fc-2c963f66afa6'
            ],
            serviceLevel: 'Standard',
            notes: 'Test road shipping',
        },
        
        // Required: Financial owners
        financialOwners: [
            {
                modeOfTransport: 'Road',
                country: 'ZA',
                includedInRwf: true,
            }
        ],
    };
}
