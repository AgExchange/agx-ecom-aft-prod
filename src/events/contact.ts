import { RequestContext, VendureEvent } from '@vendure/core';

/**
 * Contact form submission.
 *
 * Declared here rather than inside the contact plugin because the event crosses
 * a boundary: the plugin's controller publishes it, and an EmailEventListener in
 * `vendure-config.ts` consumes it. Neither owns it, so it lives alongside the
 * other cross-cutting definitions in `src/custom-fields/`.
 *
 * In agx-stores both of these were declared inline in `vendure-config.ts`, which
 * forced the plugin to import from `../../vendure-config` — a circular-ish
 * dependency on the very file that registers it.
 */
export interface ContactInput {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    message: string;
    submittedAt: Date;
    /**
     * Resolved by the controller before publishing: the channel's `infoEmail`
     * custom field, falling back to CONTACT_ADMIN_EMAIL. Carried on the event so
     * the email handler does not have to re-resolve it.
     */
    recipientEmail: string;
}

export class ContactUsEvent extends VendureEvent {
    constructor(public ctx: RequestContext, public contact: ContactInput) {
        super();
    }
}
