import { Order, RequestContext, VendureEvent } from '@vendure/core';

/**
 * Fired whenever a quote is (re-)sent to the customer. This is the integration point for
 * the `quote-sent-notification` email handler in `vendure-config.ts` — a dedicated event
 * rather than the generic `OrderEvent` that `updateCustomFields` already fires, since that
 * fires on every quote field write (validity change, notes edit, …), not just a send.
 */
export class QuoteSentEvent extends VendureEvent {
    constructor(public ctx: RequestContext, public order: Order, public revision: number) {
        super();
    }
}

/** Fired when a customer accepts a quote (`QuoteService.acceptQuote`). */
export class QuoteAcceptedEvent extends VendureEvent {
    constructor(public ctx: RequestContext, public order: Order) {
        super();
    }
}

/** Fired by the scheduled expiry sweep for each quote it marks `expired`. */
export class QuoteExpiredEvent extends VendureEvent {
    constructor(public ctx: RequestContext, public order: Order) {
        super();
    }
}

/**
 * Fired when a customer declines a quote (`QuoteService.rejectQuote`). Staff may have spent
 * real time building/pricing a quote — this is the notification that tells them it's no
 * longer needed, so they don't find out by accident days later.
 */
export class QuoteRejectedEvent extends VendureEvent {
    constructor(public ctx: RequestContext, public order: Order) {
        super();
    }
}

/**
 * Fired when a customer withdraws a quote request before it was ever sent
 * (`QuoteService.withdrawQuoteRequest`). Same rationale as `QuoteRejectedEvent`: staff
 * building the quote should hear about this before investing more time in it.
 */
export class QuoteWithdrawnEvent extends VendureEvent {
    constructor(public ctx: RequestContext, public order: Order) {
        super();
    }
}
