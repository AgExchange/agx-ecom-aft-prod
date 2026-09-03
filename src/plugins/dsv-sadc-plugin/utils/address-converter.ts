import { Logger } from '@vendure/core';
import { OrderAddress } from '@vendure/common/lib/generated-shop-types';
import { DsvSadcAddress } from '../types/plugin-options.types';
import { DsvSadcAddressService } from '../services/dsv-address.service';
import { loggerCtx } from '../constants';

const SADC_COUNTRY_CODES = new Set(['ZA', 'BW', 'LS', 'NA', 'SZ']);

/** Formats a number of millimetres to metres with 3 decimal places. */
export function mmToMetres(mm: number | null | undefined): number {
    if (!mm || mm <= 0) return 0.001;
    return Math.round(mm) / 1000;
}

/** Formats grams to kilograms with 3 decimal places. */
export function gToKg(grams: number | null | undefined): number {
    if (!grams || grams <= 0) return 0.001;
    return Math.round(grams) / 1000;
}

/** Normalises a 2-letter ISO country code to one DSV SADC accepts.
 *  DSV SADC only handles ZA/BW/LS/NA/SZ — anything else returns null. */
export function toDsvCountryCode(isoCode: string | null | undefined): string | null {
    const code = (isoCode || '').toUpperCase().trim();
    return SADC_COUNTRY_CODES.has(code) ? code : null;
}

export function isSadcCountry(isoCode: string | null | undefined): boolean {
    return toDsvCountryCode(isoCode) !== null;
}

/** Formats a coordinate to 7 decimal places (~1cm precision — plenty for DSV's routing
 *  use, and avoids floating-point noise like `28.332137799999998` reaching the SOAP
 *  request verbatim, e.g. from a customFields float run through String()). */
function toCoordinateString(value: string | number | null | undefined): string | undefined {
    if (value == null) return undefined;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n.toFixed(7) : undefined;
}

/** Converts a Vendure OrderAddress to the DSV address shape.
 *  `crossBorder`: when true, postalCode defaults to "0000" if blank (BLNS requirement).
 *  `addressService`: when supplied, used as a fallback geo-coordinate lookup (DSV's own
 *  live ValidateAddress) when the address has no stored customFields coordinates — see
 *  below. Omit for the loading/depot address, which never needs it (already hardcoded). */
export async function vendureAddressToDsv(
    addr: OrderAddress,
    crossBorder: boolean = false,
    addressService?: DsvSadcAddressService,
): Promise<DsvSadcAddress> {
    const nameLine1 = addr.company || addr.fullName || 'Unknown';
    const telephoneNumber = addr.phoneNumber || '0000000000';
    const rawPostal = (addr.postalCode || '').trim();
    const postalCode = rawPostal || (crossBorder ? '0000' : '0000');
    const countryCode = toDsvCountryCode(addr.countryCode) || 'ZA';

    // Geo coordinates, priority order:
    //  1. Storefront-captured device GPS, stored on the Address `latitude`/`longitude`
    //     custom fields and copied through onto the Order's shippingAddress snapshot as
    //     `customFields` (untyped JSON on OrderAddress — see @vendure/common
    //     generated-shop-types). This is the only way the backend can ever have
    //     coordinates as precise as the customer's actual device location — nothing
    //     server-side can reconstruct that.
    //  2. Falls back to DSV's own live ValidateAddress lookup (suburb-level accuracy —
    //     see DsvSadcAddressService.lookupCoordinates) when (1) is absent, so delivery
    //     coordinates still get sent even before any storefront populates the fields.
    // DSV's <coordinates> tag is xCoordinate=longitude, yCoordinate=latitude (matches
    // the depot's loadingAddress convention in vendure-config.ts).
    const cf = (addr as { customFields?: { latitude?: number | null; longitude?: number | null } }).customFields;
    let xCoordinate = toCoordinateString(cf?.longitude);
    let yCoordinate = toCoordinateString(cf?.latitude);

    if ((!xCoordinate || !yCoordinate) && addressService) {
        try {
            const looked = await addressService.lookupCoordinates(
                countryCode, addr.city || '', addr.streetLine2 || '', postalCode,
            );
            if (looked) {
                xCoordinate = toCoordinateString(looked.xCoordinate);
                yCoordinate = toCoordinateString(looked.yCoordinate);
            }
        } catch (err) {
            // Never block fulfillment creation on a coordinate-lookup failure —
            // buildAddressBlock simply omits <coordinates> when either is undefined.
            const msg = err instanceof Error ? err.message : String(err);
            Logger.warn(
                `[dsv-sadc] coordinate fallback lookup failed for ${addr.city}/${addr.streetLine2}/${postalCode}: ${msg}`,
                loggerCtx,
            );
        }
    }

    return {
        nameLine1,
        addressLine1: addr.streetLine1 || '',
        // DSV's own SubmitShipment samples (docs/XML Request *.xml) always pair
        // cityName with a SUBURB in cityName2 — e.g. our own depot "Kempton Park" /
        // "Isando" — never a province; DSV has no province/state field at all.
        // streetLine2 is where SA storefronts collect the suburb, so it belongs in
        // cityName2. addressLine2 is left blank to match the samples (they use it
        // only for a genuine second street line, never to repeat the suburb).
        cityName: addr.city || '',
        cityName2: addr.streetLine2 || undefined,
        postalCode,
        countryCode,
        telephoneNumber,
        xCoordinate,
        yCoordinate,
    };
}

/** Builds a DSV parcel reference string: "orderRef-NNNN" (hyphen, 4-digit index),
 *  matching the DSV field spec (goodsLine primaryReference / externalUnit). */
export function buildParcelRef(orderRef: string, index: number): string {
    const pad = String(index).padStart(4, '0');
    return `${orderRef}-${pad}`;
}

/** Formats today + N business days as YYYY-MM-DD (skipping weekends). */
export function addBusinessDays(fromDate: Date, days: number): string {
    const d = new Date(fromDate);
    let added = 0;
    while (added < days) {
        d.setDate(d.getDate() + 1);
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) added++;
    }
    return d.toISOString().slice(0, 10);
}
