import { OrderHistoryEntryData } from '@vendure/core';

/**
 * Custom Order history-entry type logged when a quote is (re-)sent. Structured rather than
 * a formatted note string, mirroring the `dsv-sadc-plugin`'s `DSV_SADC_TRACKING` pattern.
 * The matching GraphQL enum member is added in `api/api-extensions.ts`.
 */
export const QUOTE_SENT = 'QUOTE_SENT';

export interface QuoteSentData {
    /** The quote's human-readable reference, e.g. `Q-2026-00042`. */
    reference: string;
    /** The `quoteRevision` value this send corresponds to. */
    revision: number;
    /** True when this is a re-send of an already-sent quote (edited and sent again). */
    resend: boolean;
}

declare module '@vendure/core' {
    interface OrderHistoryEntryData {
        [QUOTE_SENT]: QuoteSentData;
    }
}
