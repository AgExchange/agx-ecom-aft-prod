/**
 * Pure, dependency-free helpers for the Quote plugin. Kept free of any Vendure or DB
 * coupling so they can be unit-tested in isolation (see `quote.helpers.spec.ts`).
 */

/**
 * Formats a human-readable quote reference, e.g. `formatQuoteReference('Q', 2026, 42)`
 * → `Q-2026-00042`. The sequence is zero-padded to 5 digits.
 */
export function formatQuoteReference(prefix: string, year: number, seq: number): string {
    return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
}

/**
 * Returns true when `validUntil` is strictly in the past relative to `now`. A null /
 * undefined `validUntil` is treated as "never expires" (false). The boundary instant
 * (validUntil === now) is considered NOT expired.
 */
export function isQuoteExpired(
    validUntil: Date | string | null | undefined,
    now: Date = new Date(),
): boolean {
    if (validUntil == null) {
        return false;
    }
    const expiry = validUntil instanceof Date ? validUntil : new Date(validUntil);
    return expiry.getTime() < now.getTime();
}

/**
 * Returns a new Date `days` days after `date`, without mutating the input.
 */
export function addDays(date: Date, days: number): Date {
    const result = new Date(date.getTime());
    result.setDate(result.getDate() + days);
    return result;
}
