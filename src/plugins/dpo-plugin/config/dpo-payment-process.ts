import { PaymentProcess } from '@vendure/core';

/**
 * The stock Vendure payment state machine has no Authorized -> Declined transition
 * (Authorized only goes to Settled/Error/Cancelled — see @vendure/core's
 * default-payment-process.js). DPO's hosted-checkout flow requires createPayment to
 * return Authorized immediately (see dpo-payment-handler.ts), with the real pass/fail
 * outcome only discovered later, out-of-band, by verifyAndSettle. A decline discovered
 * at that point has nowhere to go without this extra transition.
 *
 * 'Declined' is already a valid PaymentState (declared via defaultPaymentProcess's own
 * module augmentation of PaymentStates) — this only adds the missing edge, it does not
 * introduce a new custom state.
 *
 * Parameterized as PaymentProcess<'Authorized'> (not <'Declined'>) because the
 * `Transitions<State, ...>` half of PaymentProcess's type requires every key of its type
 * parameter to be present in `transitions` — 'Authorized' is the (pre-existing) state
 * whose outgoing edges are being extended, so that's the mandatory key here, not
 * 'Declined' (which needs no new outgoing edges of its own).
 *
 * IMPORTANT: this must be merged into config.paymentOptions.process by *appending* to the
 * existing array, never by replacing it — see dpo-pay.plugin.ts's configuration hook.
 * Replacing the array silently drops defaultPaymentProcess, which is what actually drives
 * order-level PaymentSettled/PaymentAuthorized transitions for every payment method in
 * the store, not just this one.
 */
export const dpoPaymentProcessExtension: PaymentProcess<'Authorized'> = {
  transitions: {
    Authorized: { to: ['Declined'] },
  },
};
