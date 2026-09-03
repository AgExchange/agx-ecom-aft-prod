export type DsvSadcServiceLevel = 'eco' | 'exp' | 'sdy' | 'ret';

export interface DsvSadcPluginOptions {
    /** SOAP endpoint URL — HCP API gateway (UAT/prod) or direct .svc/soap URL */
    apiUrl: string;
    /** HTTP Basic auth username for the DSV HCP API gateway (optional). */
    username?: string;
    /** HTTP Basic auth password for the DSV HCP API gateway (optional). */
    password?: string;
    /** Physical collection (loading) address — sent on the type-1 address block.
     *  searchName is taken from `warehouseSearchName`. */
    loadingAddress?: DsvSadcAddress;
    /** EDI numeric customer number e.g. "99999998" — goes in <ediCustomerNumber> */
    ediCustomerNumber: string;
    /** EDI department code e.g. "101s" — goes in <ediCustomerDepartment> */
    ediCustomerDepartment: string;
    /** 4-character shipper prefix for ediReference (e.g. "XXXX") */
    shipperPrefix: string;
    /** SAP/relation account number — goes in <ediCustomerSearchName> and billing address <relationNumber> */
    relationNumber: string;
    /** Pre-registered loading/warehouse SearchName at DSV (ALL CAPS, max 20 chars) */
    warehouseSearchName: string;
    defaults: {
        serviceLevel: DsvSadcServiceLevel;
        /** Pickup time in HH:MM:SS format, e.g. "08:00:00" */
        loadingTime: string;
        /** Number of business days from today for collection */
        loadingDaysFromNow: number;
    };
    features: {
        labels: boolean;
        cancel: boolean;
        webhooks: boolean;
    };
    /** Retry policy for label retrieval when DSV returns ResponseCode 300
     *  ("labels not ready" — the TMS routes the shipment before labels exist).
     *  Spec guidance is ≥3 attempts 30 min apart. Defaults to no retry (0) so a
     *  synchronous caller never blocks; production should drive this from a
     *  delayed job rather than a blocking loop. */
    labelRetry?: {
        retries: number;
        delayMs: number;
    };
    webhook?: {
        /** HTTP path for DSV to POST tracking events (default: /shipping/dsv-sadc/webhook) */
        path?: string;
    };
    debugMode?: boolean;
}

// ─── SOAP request data shapes ─────────────────────────────────────────────────

export interface DsvSadcAddress {
    nameLine1: string;
    addressLine1: string;
    addressLine2?: string;
    addressLine3?: string;
    cityName: string;
    cityName2?: string;
    postalCode: string;
    countryCode: string;
    contactPerson?: string;
    email?: string;
    telephoneNumber: string;
    xCoordinate?: string;
    yCoordinate?: string;
    /** SearchName for fixed addresses (loading address); omit for B2C delivery */
    searchName?: string;
}

export interface DsvSadcParcel {
    /** Unique ref per parcel: {orderRef}-{NNNN} e.g. "401193112-0001" */
    parcelRef: string;
    weightKg: number;
    /** Dimensions in metres (already converted from mm) */
    lengthM: number;
    widthM: number;
    heightM: number;
    /** Volume in cubic metres — REQUIRED by DSV (goodsLine + shippingUnitDetails). */
    cubicM: number;
}

export interface DsvSadcShipmentData {
    /** Order reference — used as primaryReference and in ediReference */
    orderRef: string;
    /** Counter for ediReference uniqueness (starts at "01") */
    counter: string;
    serviceLevel: DsvSadcServiceLevel;
    /** ISO date YYYY-MM-DD */
    loadingDate: string;
    /** HH:MM:SS */
    loadingTime: string;
    loadingAddress: DsvSadcAddress;
    deliveryAddress: DsvSadcAddress;
    parcels: DsvSadcParcel[];
    /** Destination country code (NA, BW, LS, SZ = cross-border; ZA = domestic) */
    destinationCountry: string;
    customerPhone?: string;
    customerEmail?: string;
    deliveryInstructions?: string;
    /** parameterYn17 — apply DSV's default insurance value to the shipment. */
    includeDefaultInsurance: boolean;
    /** parameterYn15 + amount1 — specific (non-default) declared insurance value. */
    declaredInsuranceValue?: number;
    /** parameterYn16 + amount2 — incidental liability declared value. */
    declaredIncidentalValue?: number;
}

// ─── SOAP response shapes ─────────────────────────────────────────────────────

export interface DsvSadcSubmitResult {
    ok: boolean;
    /** ClientZone ShipmentId, e.g. "LANDS00004752" or a numeric TMS number. */
    shipmentId?: string;
    parcelIds: string[];
    errorDescription?: string;
    /** true when created but DSV returned warnings (logging code 9460). */
    acceptedWithWarnings?: boolean;
    /** Human-readable warning descriptions (non-zero, non-terminal logging codes). */
    warnings?: string[];
}

export interface DsvSadcCancelResult {
    ok: boolean;
    errorMessage?: string;
}

export interface DsvSadcLabelResult {
    responseCode: string;
    responseMessage?: string;
    binaryLabel?: string;
}

export interface DsvSadcValidAddress {
    country?: string;
    countryCode?: string;
    province?: string;
    town?: string;
    suburb?: string;
    postalCode?: string;
    latitude?: string;
    longitude?: string;
}

// ─── Webhook payload ──────────────────────────────────────────────────────────

export interface TrackingEventRequest {
    eventCode: string;
    eventDescription: string;
    eventDateTime: string;
    primaryReference?: string;
    additionalReference1?: string;
    failureReason?: string;
    parcelReceiver?: string;
    dsvShipmentNumber?: string;
    clientZoneShipmentId?: string;
    dsvTrackingNumber?: string;
    parcelReference?: string;
    clientZoneParcelId?: string;
    dsvBranch?: string;
    deliveryCompany?: string;
    deliveryAddressLine1?: string;
    deliveryAddressLine2?: string;
    deliveryAddressLine3?: string;
    deliverySuburb?: string;
    deliveryTown?: string;
    deliveryPostalCode?: string;
    deliveryCountryCode?: string;
    scanLongitude?: string;
    scanLatitude?: string;
    width?: number | null;
    length?: number | null;
    height?: number | null;
    weight?: number | null;
    image?: string;
}
