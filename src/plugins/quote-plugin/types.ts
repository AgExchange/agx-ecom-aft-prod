/**
 * Plugin options for {@link QuotePlugin}, supplied via `QuotePlugin.init()`.
 */
export interface QuotePluginOptions {
    /**
     * Number of days a quote remains valid, used as the default when a quote is
     * created without an explicit `validUntil`.
     */
    defaultQuoteValidityDays: number;
    /**
     * Prefix used for generated human-readable quote references, e.g. `Q` → `Q-2026-00042`.
     * Defaults to `Q`.
     */
    quoteReferencePrefix?: string;
}

/**
 * The phase of a quote's negotiation. Tracked here — NOT via `order.state`, which stays
 * `Draft` for the entire negotiation (see `config/quote-order-process.ts`). Values:
 *
 *  - `requested` : a customer or admin has turned an order into a quote request. Fully
 *    editable (lines, shipping, customer) via the standard order-editing mutations.
 *  - `sent`      : the team has sent priced terms to the customer. Still editable; editing
 *    and re-sending bumps `quoteRevision` rather than resetting the status.
 *  - `accepted`  : the customer accepted; the order has moved on to `ArrangingPayment`.
 *  - `rejected`  : the customer rejected (terminal).
 *  - `expired`   : `quoteValidUntil` passed while still `requested`/`sent` (terminal, set
 *    by the scheduled expiry sweep).
 *  - `withdrawn` : the request was withdrawn, handing the order back to the customer as an
 *    ordinary cart (`order.state` returns to `AddingItems`) (terminal for the quote itself;
 *    the underlying order lives on as a normal cart).
 */
export type QuoteStatus = 'requested' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'withdrawn';

/**
 * Declaration-merge the quote custom fields onto the Order entity's `customFields`
 * so they are strongly typed throughout the plugin (service, order process, etc.).
 * The fields themselves are registered in `QuotePlugin`'s `configuration` function.
 */
declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomOrderFields {
        quoteValidUntil?: Date | null;
        quoteReference?: string | null;
        quoteNotes?: string | null;
        quoteAcceptedAt?: Date | null;
        quoteStatus?: QuoteStatus | null;
        quoteRequestedAt?: Date | null;
        quoteSentAt?: Date | null;
        quoteRevision?: number | null;
    }
}
