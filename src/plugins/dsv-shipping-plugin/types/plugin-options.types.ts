/**
 * DSV Shipping Plugin - Type Definitions
 * 
 * Complete type definitions for plugin configuration, API requests/responses,
 * and internal data structures.
 */

/**
 * OAuth Configuration
 * Used for DSV API authentication
 */
export interface DsvAuthConfig {
    /** Email address from DSV subscription */
    clientEmail: string;
    
    /** Password from DSV subscription */
    clientPassword: string;
    
    /** Access Token API subscription key */
    accessTokenKey: string;
    
    /** DSV API base URL (e.g., https://api.dsv.com) */
    apiBaseUrl: string;
    
    /** OAuth token endpoint path (e.g., /my-demo/oauth/v1/token) */
    tokenEndpoint: string;
}

/**
 * DSV API Subscription Keys
 * Each API operation requires its own subscription key
 */
export interface DsvSubscriptionKeys {
    /** Quote API subscription key (Phase 1) */
    quote: string;
    
    /** Booking API subscription key (Phase 2) */
    booking?: string;
    
    /** Tracking API subscription key (Phase 3) */
    tracking?: string;
    
    /** Webhook API subscription key (Phase 4) */
    webhook?: string;
    
    /** Label API subscription key (Phase 5 - optional) */
    label?: string;
}

/**
 * DSV API Endpoints
 * Configure API endpoint paths (change for test vs production)
 */
export interface DsvApiEndpoints {
    /** Quote API endpoint (e.g., /qs-demo/quote/v1/quotes) - OPTIONAL (Phase 5) */
    quote?: string;
    
    /** Booking API endpoint (e.g., /my-demo/booking/v2) - REQUIRED (Phase 2) */
    booking: string;
    
    /** Tracking API endpoint (Phase 3) */
    tracking?: string;
}

/**
 * Feature Flags
 * Enable/disable plugin features progressively
 */
export interface DsvFeatureFlags {
    /** Enable quote/rate calculation (Phase 1) */
    quote: boolean;
    
    /** Enable booking creation (Phase 2) */
    booking: boolean;
    
    /** Enable tracking (Phase 3) */
    tracking: boolean;
    
    /** Enable webhooks (Phase 4) */
    webhooks: boolean;
    
    /** Enable label printing (Phase 5) */
    labels: boolean;
}

/**
 * Webhook Configuration
 */
export interface DsvWebhookConfig {
    /** Secret for webhook signature verification */
    secret: string;
    
    /** Public endpoint path for webhooks */
    endpointPath: string;
}

/**
 * Booking Defaults Configuration
 * Default values for creating DSV bookings
 */
export interface DsvBookingDefaults {
    /** Default transport mode */
    product: 'Road' | 'Air' | 'Sea' | 'Rail';
    
    /** Default package type */
    packageType: DsvPackageType;
    
    /** Default stackable value */
    stackable: 'STACKABLE' | 'NO';
    
    /** Default incoterms */
    incoterms: {
        code: string;
        location: string;
    };
    
    /** Default pickup time window */
    pickupTime: {
        start: string;  // HH:mm:ss
        end: string;    // HH:mm:ss
        daysFromNow: number;  // Days to add to current date
    };
    
    /** Default delivery time window */
    deliveryTime: {
        start: string;  // HH:mm:ss
        end: string;    // HH:mm:ss
        daysFromNow: number;  // Days to add to current date
    };
    
    /** Default units of measurement */
    units: DsvBookingUnits;
    
    /** Insurance configuration */
    insurance?: {
        enabled: boolean;
        category: string;  // STD, etc.
        currency: string;  // ZAR, USD, etc.
    };
}

/**
 * Complete Plugin Options
 * Main configuration object for DSV Shipping Plugin
 */
export interface DsvShippingPluginOptions {
    /** OAuth authentication configuration */
    auth: DsvAuthConfig;
    
    /** API subscription keys for different operations */
    subscriptionKeys: DsvSubscriptionKeys;
    
    /** API endpoint paths */
    apiEndpoints: DsvApiEndpoints;
    
    /** Test MDM account number from DSV */
    testMdmAccount: string;
    
    /** Booking defaults configuration */
    bookingDefaults: DsvBookingDefaults;
    
    /** Feature flags for progressive enablement */
    features: DsvFeatureFlags;
    
    /** Quote cache TTL in seconds (default: 300) */
    quoteCacheTTL?: number;
    
    /** Webhook configuration (required if webhooks enabled) */
    webhook?: DsvWebhookConfig;
    
    /** Enable debug logging */
    debugMode?: boolean;
}

// ============================================
// DSV API Request/Response Types
// ============================================

/**
 * Transport modes supported by DSV
 */
export type DsvTransportMode = 'Air' | 'Sea' | 'Road' | 'Rail';

/**
 * Service levels vary by transport mode
 */
export type DsvServiceLevel = 'Express' | 'Standard' | 'Economy';

/**
 * Package types supported by DSV (actual enum from DSV API)
 */
export type DsvPackageType = 
    | 'BAG'   // Bag
    | 'CTN'   // Carton (default for most goods)
    | 'PLT'   // Pallet
    | 'PKG'   // Package
    | 'CRT'   // Crate
    | 'DRM'   // Drum
    | 'CAN'   // Can
    | 'CAS'   // Case
    | 'LOT'   // Lot
    | 'CON'   // Container
    | 'LOAD'  // Load
    | 'EUR'   // Euro Pallet
    | 'CLL'   // Colli
    | 'HPL'   // Half Pallet
    | 'KPL'   // Quarter Pallet
    | 'IBC'   // IBC
    | 'PPL'   // Pallet
    | 'QPL'   // Quarter Pallet
    | 'PLL'   // Pallet
    | 'UPL'   // Unit Pallet
    | 'RLL'   // Roll
    | 'EUP'   // Euro Pallet
    | 'LOD'   // Load
    | 'IPL'   // Industrial Pallet
    | 'GIB'   // Gitterbox
    | 'JCN'   // Jerrycan
    | 'PXL';  // Pallet

/**
 * Cargo types
 */
export type DsvCargoType = 'LCL' | 'FCL';

/**
 * Units of measurement
 */
export interface DsvUnitsOfMeasurement {
    dimension: 'CM' | 'M' | 'IN' | 'FT';
    weight: 'KG' | 'G' | 'LB' | 'OZ';
    volume: 'M3' | 'L' | 'FT3';
}

/**
 * Address structure for DSV API
 */
export interface DsvAddress {
    name?: string;
    country: string;
    city: string;
    zipCode?: string;
    streetLine1?: string;
    streetLine2?: string;
    mdm?: string;  // DSV Master Data Management ID
}

/**
 * Contact person
 */
export interface DsvContact {
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
}

/**
 * Package details for quote/booking
 */
export interface DsvPackage {
    goodsDescription: string;
    packageType: DsvPackageType;
    quantity: number;
    totalWeight: number;  // in specified weight unit
    length: number;       // in specified dimension unit
    width: number;
    height: number;
    value?: number;       // for insurance
    currency?: string;
}

/**
 * Quote Request to DSV API
 */
export interface DsvQuoteRequest {
    requestedBy: DsvContact;
    bookingParty: DsvAddress;
    from: DsvAddress;
    to: DsvAddress;
    cargoType: DsvCargoType;
    packages: DsvPackage[];
    totalWeight: number;
    unitsOfMeasurement: DsvUnitsOfMeasurement;
    air?: {
        originAirport?: string;
        destinationAirport?: string;
        serviceLevel?: DsvServiceLevel;
    };
    sea?: {
        originPort?: string;
        destinationPort?: string;
        serviceLevel?: DsvServiceLevel;
    };
    road?: {
        serviceLevel?: DsvServiceLevel;
    };
    rail?: {
        serviceLevel?: DsvServiceLevel;
    };
}

/**
 * Price structure in quote response
 */
export interface DsvPrice {
    amount: number;
    currency: string;
}

/**
 * Quote option returned by DSV
 */
export interface DsvQuoteOption {
    id: string;
    quoteId: string;
    code: string;
    version?: string | null;
    quoteRequestId: string;
    quoteProvider: string;
    status: string;
    submissionDate: string;
    responseDate: string;
    validUntil: string;
    type: string;
    modeOfTransport: string;
    quoteProviderStatus: string;
    price: {
        value: number | null;
        currency: string | null;
    };
    serviceLevel?: string | null;
    transitTime?: number | null;
    notes?: string | null;
}

/**
 * Quote Response from DSV API
 */
export interface DsvQuoteResponse {
    quoteRequestId: string;
    status: string;
    quotes: DsvQuoteOption[];  // DSV returns "quotes" not "options"
    code?: string;
    createdDate?: string;
    validUntil?: string;
}

/**
 * OAuth Token Response
 */
export interface DsvTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;  // seconds
    scope?: string;
    refresh_token?: string;
    refresh_expires_in?: number;  // seconds
}

/**
 * Cached Token Info
 */
export interface CachedToken {
    token: string;
    expiresAt: Date;
    refreshToken?: string;
    refreshExpiresAt?: Date;
}

// ============================================
// Calculator Argument Types
// ============================================

/**
 * Arguments for DSV Rate Calculator
 * These appear in the Vendure Admin UI when configuring a shipping method
 */
export interface DsvRateCalculatorArgs {
    /** Transport mode to use */
    transportMode: DsvTransportMode;
    
    /** Service level within transport mode */
    serviceLevel: DsvServiceLevel;
    
    /** Include insurance in quote */
    includeInsurance: boolean;
    
    /** Tax rate percentage (e.g., 15 for 15%) */
    taxRate: number;
    
    /** Origin airport code (for Air freight) */
    originAirport?: string;
    
    /** Destination airport code (for Air freight) */
    destinationAirport?: string;
    
    /** Origin port code (for Sea freight) */
    originPort?: string;
    
    /** Destination port code (for Sea freight) */
    destinationPort?: string;
}

// ============================================
// Internal Types
// ============================================

/**
 * Cached quote entry
 */
export interface CachedQuote {
    quoteId: string;
    response: DsvQuoteResponse;
    cachedAt: Date;
}

/**
 * Package calculation result
 */
export interface CalculatedPackages {
    packages: DsvPackage[];
    totalWeight: number;
    totalValue: number;
}

// ============================================
// Booking API v2 Types (Correct Structure)
// ============================================

/**
 * Booking API v2 Address (DIFFERENT from Quote API!)
 */
export interface DsvBookingAddress {
    companyName?: string;
    addressId?: string;
    addressLine1: string;
    addressLine2?: string;
    addressLine3?: string | null;
    city: string;
    countryCode: string;
    state?: string | null;  // Allow explicit null
    zipCode: string;
    instructions?: string | null;
    mdm?: string | null;
}

/**
 * Booking API v2 Contact
 */
export interface DsvBookingContact {
    name: string;
    email: string;
    telephone: string;
}

/**
 * Booking API v2 Party (address + contact)
 */
export interface DsvBookingParty {
    address: DsvBookingAddress;
    contact: DsvBookingContact;
}

/**
 * Booking API v2 Parties Structure
 */
export interface DsvBookingParties {
    sender: DsvBookingParty;
    receiver: DsvBookingParty;
    delivery?: DsvBookingParty;
    pickup?: DsvBookingParty;
    freightPayer: {
        address: {
            mdm: string;
        };
    };
    bookingParty: {
        address: {
            mdm: string;
        };
    };
}

/**
 * Booking API v2 Product
 */
export interface DsvBookingProduct {
    name: 'Road' | 'Air' | 'Sea' | 'Rail';
    dropOff: boolean;
}

/**
 * Booking API v2 Time
 */
export interface DsvBookingTime {
    date: string;  // YYYY-MM-DD
    start: string; // HH:mm:ss
    end: string;   // HH:mm:ss
}

/**
 * Booking API v2 Incoterms
 */
export interface DsvBookingIncoterms {
    code: string;  // EXW, FOB, CIF, etc.
    location: string;
}

/**
 * Booking API v2 Insurance
 */
export interface DsvBookingInsurance {
    amount: {
        value: number;
        currency: string;
    };
    category: string;  // STD, etc.
}

/**
 * Booking API v2 Services
 */
export interface DsvBookingServices {
    insurance?: DsvBookingInsurance;
}

/**
 * Booking API v2 Package (DIFFERENT from Quote API!)
 */
export interface DsvBookingPackage {
    quantity: number;
    packageType: DsvPackageType;
    totalWeight: number;
    netWeight?: number;
    length: number;
    height: number;
    width: number;
    stackable: 'STACKABLE' | 'NO';
    totalVolume?: number;
    palletSpace?: number | null;  // Allow explicit null to match working example
    loadingMeters?: number;
    description: string;
    shippingMarks?: string;
}

/**
 * Booking API v2 Reference Types
 */
export type DsvBookingReferenceType = 
    | 'INVOICING_REFERENCE'
    | 'ORDER_NUMBER'
    | 'CONSIGNEE_REFERENCE'
    | 'SHIPPER_REFERENCE'
    | 'OTHER';

/**
 * Booking API v2 Reference
 */
export interface DsvBookingReference {
    value: string;
    type: DsvBookingReferenceType;
}

/**
 * Booking API v2 Units
 */
export interface DsvBookingUnits {
    dimension: 'CM' | 'M';
    weight: 'KG';
    volume: 'M3';
    loadingSpace: 'LM';
    temperature: 'C';
}

/**
 * Booking API v2 Request (Complete Structure)
 */
export interface DsvBookingRequest {
    autobook: boolean;
    product: DsvBookingProduct;
    services?: DsvBookingServices;
    incoterms?: DsvBookingIncoterms;
    pickupTime?: DsvBookingTime;
    deliveryTime?: DsvBookingTime;
    pickupInstructions?: string[];
    deliveryInstructions?: string[];
    parties: DsvBookingParties;
    packages: DsvBookingPackage[];
    references?: DsvBookingReference[];
    units: DsvBookingUnits;
}

/**
 * Booking Response from DSV API
 */
export interface DsvBookingResponse {
    bookingId: string;
    shipmentId?: string;
    status: string;
    transportMode?: string;
    carrier?: string;
    estimatedDelivery?: string;
    trackingUrl?: string;
    createdAt?: string;
}

/**
 * Arguments for DSV Fulfillment Handler
 */
export interface DsvFulfillmentHandlerArgs {
    /** Auto-book or create draft */
    autoBook: boolean;
    
    /** Transport mode */
    transportMode: DsvTransportMode;
    
    /** Service level */
    serviceLevel: DsvServiceLevel;
    
    /** Origin airport code (for Air) */
    originAirport?: string;
    
    /** Destination airport code (for Air) */
    destinationAirport?: string;
    
    /** Origin port code (for Sea) */
    originPort?: string;
    
    /** Destination port code (for Sea) */
    destinationPort?: string;
}
