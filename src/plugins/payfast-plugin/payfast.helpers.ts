import * as crypto from 'crypto';

/**
 * Generates the MD5 signature for PayFast REST API calls (refunds, etc.).
 *
 * Per official PayFast API docs (developers.payfast.co.za/api):
 *  "MD5 hash of the alphabetised submitted header and body variables,
 *   as well as the passphrase. Characters must be in lower case."
 *
 * Pass ALL headers being sent (merchant-id, version, timestamp) + ALL body params
 * as a flat object. They will be sorted alphabetically before hashing.
 */
export function generatePayFastApiSignature(
    params: Record<string, string>,
    passphrase?: string,
): string {
    // Passphrase is added BEFORE sorting (matches PayFast PHP SDK Auth::generateApiSignature).
    // ksort includes 'passphrase' alphabetically: merchant-id → passphrase → timestamp → version
    const allParams: Record<string, string> = passphrase
        ? { ...params, passphrase }
        : { ...params };

    const sorted = Object.entries(allParams).sort(([a], [b]) => a.localeCompare(b));

    const paramString = sorted
        .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, '+')}`)
        .join('&');

    return crypto.createHash('md5').update(paramString).digest('hex');
}

/**
 * Generates the MD5 signature required by PayFast.
 *
 * Algorithm:
 *  1. Take fields in insertion order (caller controls order).
 *     By default, skip empty/null/undefined values; pass includeEmpty=true to keep them.
 *  2. URL-encode each value (space → +, @ → %40, etc.).
 *  3. Join as key=value pairs separated by &.
 *  4. Append &passphrase=<passphrase> if configured.
 *  5. MD5-hash the resulting string.
 *
 * OUTGOING form (buildFormData): documented PayFast field order, empty fields excluded.
 * INCOMING ITN verification: ITN-received field order, empty fields INCLUDED (includeEmpty=true).
 */
export function generatePayFastSignature(
    data: Record<string, string | undefined | null>,
    passphrase?: string,
    includeEmpty = false,
): string {
    const pairs = Object.entries(data)
        .filter(([key, val]) => {
            if (key === 'signature') return false;
            if (!includeEmpty && (val === undefined || val === null || val === '')) return false;
            return true;
        });

    let paramString = pairs
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v ?? '').trim()).replace(/%20/g, '+')}`)
        .join('&');

    if (passphrase) {
        paramString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
    }

    return crypto.createHash('md5').update(paramString).digest('hex');
}
