import { LanguageCode } from '@vendure/core';

export const PIM_SYNC_OPTIONS = Symbol('PIM_SYNC_OPTIONS');
export const loggerCtx = 'PimSyncPlugin';
export const SYNC_QUEUE_NAME = 'pim-full-sync';

// Fallback Vendure StockLocation NAME used to receive PIM-sourced stock quantities
// ONLY when a channel has more than one StockLocation assigned and needs disambiguation.
// AtroPIM has no concept of stock locations, so all synced stock is written to one
// location per channel. StockLocation is channel-aware (Vendure core), so when a channel
// has exactly one StockLocation assigned, that location is used directly regardless of
// name — no hardcoded name required. This constant is only consulted as a tie-breaker
// for channels with multiple locations, and is overridable per-deployment via the
// `stockLocationName` plugin option / PIM_STOCK_LOCATION_NAME env var.
export const DEFAULT_STOCK_LOCATION_NAME = 'ZL10';

// Max images synced per product/variant from the ProductFile junction (main image
// first, then remaining files by their `sorting` order). Overridable via the
// maxProductImages plugin option. Vendure stores these as the entity's assetIds,
// with the main image as featuredAsset.
export const DEFAULT_MAX_PRODUCT_IMAGES = 5;

/**
 * Normalises a PIM locale code to a Vendure LanguageCode (ISO 639-1).
 * AtroPIM uses locale codes such as "en_ZA", "en_US", "af_ZA" whereas Vendure
 * uses plain ISO 639-1 codes ("en", "af", "de").  Strip the country suffix and
 * lowercase the language tag.  If the result is not a recognised Vendure code
 * the cast will still produce a usable string — callers should log a warning.
 */
export function normalizeLocaleToLanguageCode(locale: string): LanguageCode {
    return locale.split(/[_-]/)[0].toLowerCase() as LanguageCode;
}

// Suffix → "Online Option" value (uppercased to match Vendure option lookup).
// This is the single option group the sync assigns (reuses the `part-standards` group).
// Option values in Vendure: OEM | PREMIUM | ECONOMY | STANDARD | AFTERMARKET
// The former `indication` group has been dropped — within one MPN group, suffixes that
// share an Online Option collapse to the same variant option combination, so the
// pre-flight dedup keeps the first and skips later duplicates (by design).
export const SUFFIX_TO_PART_STANDARD: Record<string, string> = {
    '':    'OEM',   // no suffix ("Straight")
    'OEM': 'OEM',
    'O':   'OEM',
    'K':   'OEM',
    'A':   'PREMIUM',
    'AB':  'PREMIUM',
    'C':   'PREMIUM',
    'CA':  'PREMIUM',
    'M':   'PREMIUM',
    'OE':  'PREMIUM',
    'ET':  'PREMIUM',
    'E':   'ECONOMY',
    'I':   'ECONOMY',
    'L':   'STANDARD',
    'LB':  'STANDARD',
    'LP':  'STANDARD',
    'LL':  'STANDARD',
    'R':   'STANDARD',
    'P':   'AFTERMARKET',
};
