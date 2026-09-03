import { OrderProcess } from '@vendure/core';

/**
 * The quote workflow does NOT introduce any new `OrderState`. A quote is a real Order
 * that spends its entire negotiation life in Vendure's own `Draft` state — the phase
 * within that negotiation (requested / sent / accepted / rejected / expired) is tracked
 * by the `customFields.quoteStatus` field instead (see `types.ts`), not by `order.state`.
 *
 * Why: Vendure's `assertAddingItemsState()` guard — used internally by every line-editing
 * mutation (`addItemToOrder`, `adjustOrderLine`, `removeOrderLine`, `setShippingMethod`,
 * `updateOrderCurrency`, …) — only ever accepts `order.state === 'AddingItems' | 'Draft'`.
 * A quote parked in any custom state outside that pair permanently loses the ability to
 * use those mutations; `OrderModifier.modifyOrder` doesn't help either, since it hardcodes
 * `state !== 'Modifying'` (only reachable post-payment). Staying in `Draft` for the whole
 * negotiation keeps a quote editable via Vendure's own generic order-editing surface, for
 * as many rounds of negotiation as needed, using code we didn't have to write.
 *
 * The only transitions this process adds are `AddingItems <-> Draft`, both merged onto
 * the default process's own transitions (never replacing them):
 *  - `AddingItems -> Draft`  : a customer/admin turns an active cart into a quote request.
 *  - `Draft -> AddingItems`  : withdrawing a quote request hands the order back to the
 *    customer as an ordinary cart (see `QuoteService.withdrawQuoteRequest`).
 *
 * `Draft -> ArrangingPayment` (accepting a quote and proceeding to payment) and
 * `Created -> Draft` (admin-authored draft orders) are already permitted by
 * `defaultOrderProcess` — nothing to add there. The expiry/"has this actually been sent"
 * checks live in `QuoteService.acceptQuote`, checked before the transition is even
 * attempted — but `onTransitionStart` below is a second, state-machine-level backstop:
 * `Draft -> ArrangingPayment` is a *default* transition, reachable directly via the
 * generic `transitionOrderToState` admin mutation, completely bypassing `acceptQuote` (and
 * its status/expiry checks) if nothing here stops it. Only orders that ARE quotes
 * (`quoteReference != null`) are constrained — an ordinary staff-created draft/phone order
 * must transition freely, exactly as it always has.
 */
export const quoteOrderProcess: OrderProcess<never> = {
    transitions: {
        AddingItems: { to: ['Draft'], mergeStrategy: 'merge' },
        Draft: { to: ['AddingItems'], mergeStrategy: 'merge' },
    },
    onTransitionStart(fromState, toState, { order }) {
        if (fromState === 'Draft' && toState === 'ArrangingPayment' && order.customFields.quoteReference != null) {
            if (order.customFields.quoteStatus !== 'accepted') {
                return (
                    `Quote ${order.customFields.quoteReference} cannot proceed to payment while its ` +
                    `status is "${order.customFields.quoteStatus}" — use the acceptQuote mutation, ` +
                    `which validates the quote was sent and is not expired before setting this status.`
                );
            }
        }
    },
};
