import { Inject, Injectable } from '@nestjs/common';
import {
    ActiveOrderService,
    CustomerService,
    EntityNotFoundError,
    EventBus,
    ForbiddenError,
    HistoryService,
    ID,
    isGraphQlErrorResult,
    ListQueryBuilder,
    Logger,
    Order,
    OrderService,
    OrderStateTransitionError,
    PaginatedList,
    RelationPaths,
    RequestContext,
    SessionService,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { OrderListOptions } from '@vendure/common/lib/generated-types';
import { IsNull, Not } from 'typeorm';

import { QuoteExpiredError, QuoteNotFoundError, QuoteRequiresLoginError } from '../api/quote-errors';
import { QUOTE_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { QuoteAcceptedEvent, QuoteRejectedEvent, QuoteSentEvent, QuoteWithdrawnEvent } from '../events';
import { addDays, isQuoteExpired } from '../helpers/quote.helpers';
import { QUOTE_SENT } from '../history-types';
import { QuotePluginOptions, QuoteStatus } from '../types';
import { QuoteReferenceService } from './quote-reference.service';

const OPEN_QUOTE_STATUSES: QuoteStatus[] = ['requested', 'sent'];

/**
 * All quote business logic. A quote is an Order that stays in the native `Draft` state for
 * its entire negotiation (see `config/quote-order-process.ts`); `customFields.quoteStatus`
 * tracks the negotiation phase instead of `order.state`. Every write goes through
 * `OrderService` (state transitions, `updateCustomFields`), so Vendure's standard events
 * keep firing — the integration seam a later CRM plugin will hook into.
 */
@Injectable()
export class QuoteService {
    constructor(
        @Inject(QUOTE_PLUGIN_OPTIONS) private options: QuotePluginOptions,
        private activeOrderService: ActiveOrderService,
        private connection: TransactionalConnection,
        private customerService: CustomerService,
        private eventBus: EventBus,
        private historyService: HistoryService,
        private listQueryBuilder: ListQueryBuilder,
        private orderService: OrderService,
        private quoteReferenceService: QuoteReferenceService,
        private sessionService: SessionService,
    ) {
        Logger.info('QuoteService constructed', loggerCtx);
    }

    // ---------------------------------------------------------------------------
    // Shop API
    // ---------------------------------------------------------------------------

    /**
     * Turns the authenticated customer's active order into a quote request
     * (`AddingItems -> Draft`). Returns `QuoteRequiresLoginError` (without creating a
     * customer or transitioning anything) when the caller is not authenticated, so the
     * storefront can prompt for login and retry.
     */
    async requestQuote(ctx: RequestContext): Promise<Order | QuoteRequiresLoginError> {
        if (!ctx.activeUserId) {
            return new QuoteRequiresLoginError();
        }
        const activeOrder = await this.activeOrderService.getActiveOrder(ctx, undefined);
        if (!activeOrder) {
            throw new UserInputError('There is no active order to request a quote for.');
        }
        // `ActiveOrderService`'s underlying lookup does not select `lines` by default (it's
        // a bare `createQueryBuilder('order')...getOne()` when resolving an existing
        // session-attached order), so re-fetch with `lines` explicitly rather than trusting
        // `activeOrder.lines` to be populated.
        const order = await this.orderService.findOne(ctx, activeOrder.id, ['lines']);
        if (!order || order.lines.length === 0) {
            throw new UserInputError('Cannot request a quote for an empty cart.');
        }

        const reference = await this.quoteReferenceService.next(ctx, this.prefix());
        await this.orderService.updateCustomFields(ctx, order.id, {
            quoteReference: reference,
            quoteValidUntil: addDays(new Date(), this.options.defaultQuoteValidityDays),
            quoteStatus: 'requested' satisfies QuoteStatus,
            quoteRequestedAt: new Date(),
        });

        const transitioned = this.assertOrder(await this.orderService.transitionToState(ctx, order.id, 'Draft'));

        // Detach the quote from the live cart: it must no longer be the customer's
        // "active order", so further shopping starts a fresh cart. Mirrors the
        // behaviour of admin-created draft orders (`active = false`).
        await this.deactivateAndDetachFromSession(ctx, transitioned);

        Logger.info(`Quote ${reference} requested for order ${transitioned.code}`, loggerCtx);
        return transitioned;
    }

    /**
     * Withdraws a quote request that hasn't been sent yet, handing the order back to the
     * customer as an ordinary cart (`Draft -> AddingItems`) and reattaching it as their
     * active order so they can keep shopping in it immediately.
     *
     * Deliberately restricted to `quoteStatus === 'requested'` (not `'sent'`): once a quote
     * has been sent, "withdraw" and "reject" would otherwise be two mutations doing almost
     * the same thing (the customer backing out of a live quote). `rejectQuote` owns that
     * case for a sent quote.
     */
    async withdrawQuoteRequest(ctx: RequestContext, orderCode: string): Promise<Order | QuoteNotFoundError> {
        const order = await this.getOwnedQuoteByCode(ctx, orderCode);
        if (!order) {
            return new QuoteNotFoundError();
        }
        this.assertIsQuote(order);
        if (order.customFields.quoteStatus !== 'requested') {
            throw new UserInputError(
                `Quote ${order.customFields.quoteReference} has already been sent — use rejectQuote instead of withdrawing it.`,
            );
        }

        await this.orderService.updateCustomFields(ctx, order.id, {
            quoteStatus: 'withdrawn' satisfies QuoteStatus,
        });
        const withdrawn = this.assertOrder(
            await this.orderService.transitionToState(ctx, order.id, 'AddingItems'),
        );
        await this.activateAndAttachToSession(ctx, withdrawn);
        await this.eventBus.publish(new QuoteWithdrawnEvent(ctx, withdrawn));

        Logger.info(`Quote ${order.customFields.quoteReference} withdrawn (order ${order.code})`, loggerCtx);
        return withdrawn;
    }

    /**
     * Accepts a quote that has been sent: validates ownership, that it was actually sent,
     * and expiry, records `quoteAcceptedAt`, then moves the order forward into the normal
     * flow (`Draft -> ArrangingPayment`). No price recalculation happens —
     * `transitionToState` does not call `applyPriceAdjustments`, so the quoted lines,
     * adjustments and prices are preserved.
     *
     * Reattaches the order to the customer's session (`SessionService.setActiveOrder`)
     * after the transition: Vendure never does this automatically for an order that was
     * not already the session's active order, so without this an accepted quote could
     * never actually be paid through the normal session-bound Shop API checkout mutations.
     */
    async acceptQuote(
        ctx: RequestContext,
        orderCode: string,
    ): Promise<Order | QuoteExpiredError | QuoteNotFoundError> {
        const order = await this.getOwnedQuoteByCode(ctx, orderCode);
        if (!order) {
            return new QuoteNotFoundError();
        }
        if (order.customFields.quoteStatus !== 'sent') {
            throw new UserInputError('This quote has not been sent yet and cannot be accepted.');
        }
        if (isQuoteExpired(order.customFields.quoteValidUntil)) {
            return new QuoteExpiredError(
                `Quote ${order.customFields.quoteReference ?? order.code} has expired and can no longer be accepted.`,
            );
        }

        return this.finalizeAcceptance(ctx, order);
    }

    /**
     * Rejects an open quote (terminal): sets `quoteStatus: 'rejected'` and cancels the
     * order (`Draft -> Cancelled`, via `OrderService.cancelOrder` — a direct
     * `transitionToState(..., 'Cancelled')` would fail the default process's
     * `checkAllItemsBeforeCancel` guard, which requires every line to already be
     * zero-quantity for any `fromState` other than `AddingItems`/`ArrangingPayment`;
     * `cancelOrder` cancels the lines and only then transitions). A rejected quote is a
     * dead order — leaving it at `Draft` forever would leave it indistinguishable from a
     * genuinely in-progress staff draft/phone order in the plain order list.
     */
    async rejectQuote(ctx: RequestContext, orderCode: string): Promise<Order | QuoteNotFoundError> {
        const order = await this.getOwnedQuoteByCode(ctx, orderCode);
        if (!order) {
            return new QuoteNotFoundError();
        }
        this.assertOpenQuote(order);
        await this.orderService.updateCustomFields(ctx, order.id, {
            quoteStatus: 'rejected' satisfies QuoteStatus,
        });
        const cancelResult = await this.orderService.cancelOrder(ctx, {
            orderId: order.id,
            reason: 'Quote rejected by customer',
        });
        if (isGraphQlErrorResult(cancelResult)) {
            throw new UserInputError(cancelResult.message);
        }
        await this.eventBus.publish(new QuoteRejectedEvent(ctx, cancelResult));

        Logger.info(`Quote ${order.customFields.quoteReference} rejected (order ${order.code})`, loggerCtx);
        return cancelResult;
    }

    /**
     * Looks up a quote by its human-readable reference (e.g. `Q-2026-00042`) on behalf of
     * the authenticated customer who owns it.
     */
    async quoteByReference(ctx: RequestContext, reference: string): Promise<Order | undefined> {
        return this.getOwnedQuoteByReference(ctx, reference);
    }

    // ---------------------------------------------------------------------------
    // Admin API
    // ---------------------------------------------------------------------------

    /**
     * Converts an existing native Draft Order (created via the Admin UI's own "Create draft
     * order" flow — `createDraftOrder` / `addItemToDraftOrder` / `setCustomerForDraftOrder` /
     * `setDraftOrderShippingMethod`, all built into Vendure core) into a quote. Deliberately
     * thin: the draft order is already channel-scoped, has a customer, has lines — this only
     * layers quote tracking (`quoteReference`/`quoteStatus`) on top, exactly the way "a quote
     * is just another order state" implies. No order construction happens here; see
     * `docs/quote-plugin.md` for why this replaced an earlier version that duplicated
     * `addItemsToOrder`/`addCustomerToOrder`/`setShippingMethod` for no benefit.
     */
    async createQuote(ctx: RequestContext, orderId: ID): Promise<Order> {
        const order = await this.getQuoteOrThrow(ctx, orderId, ['customer', 'lines']);
        if (order.state !== 'Draft') {
            throw new UserInputError('Only a Draft order can be converted into a quote.');
        }
        if (order.customFields.quoteReference != null) {
            throw new UserInputError(
                `Order ${order.code} is already a quote (${order.customFields.quoteReference}).`,
            );
        }
        if (!order.customer) {
            throw new UserInputError('This order needs a customer assigned before it can become a quote.');
        }
        if (order.lines.length === 0) {
            throw new UserInputError('This order needs at least one line before it can become a quote.');
        }

        const reference = await this.quoteReferenceService.next(ctx, this.prefix());
        await this.orderService.updateCustomFields(ctx, order.id, {
            quoteReference: reference,
            quoteValidUntil: addDays(new Date(), this.options.defaultQuoteValidityDays),
            quoteStatus: 'requested' satisfies QuoteStatus,
            quoteRequestedAt: new Date(),
        });

        const quote = await this.getQuoteOrThrow(ctx, order.id);
        Logger.info(`Quote ${reference} created from draft order ${quote.code}`, loggerCtx);
        return quote;
    }

    /**
     * Accepts a sent quote on the customer's behalf (e.g. after a phone/email confirmation).
     * Payment — via the storefront or a staff-recorded manual payment reference
     * (`addManualPaymentToOrder`) — is the real control point, not which persona clicked
     * accept; this mirrors the Shop API's `acceptQuote` (same preconditions, same
     * `finalizeAcceptance` tail) but throws rather than returning a typed union, matching
     * every other admin method here.
     */
    async acceptQuoteAsStaff(ctx: RequestContext, orderId: ID): Promise<Order> {
        const order = await this.getQuoteOrThrow(ctx, orderId);
        if (order.customFields.quoteStatus !== 'sent') {
            throw new UserInputError('This quote has not been sent yet and cannot be accepted.');
        }
        if (isQuoteExpired(order.customFields.quoteValidUntil)) {
            throw new UserInputError(
                `Quote ${order.customFields.quoteReference ?? order.code} has expired and can no longer be accepted.`,
            );
        }
        return this.finalizeAcceptance(ctx, order);
    }

    /**
     * Sends (or re-sends) a quote to the customer. A customer and a shipping method are
     * mandatory before sending, which guarantees the later `Draft -> ArrangingPayment`
     * default-process guards will pass on acceptance.
     *
     * The order never leaves `Draft`, so a sent quote stays fully editable: editing it and
     * calling `sendQuote` again bumps `quoteRevision` and logs a history entry rather than
     * requiring any state change.
     */
    async sendQuote(ctx: RequestContext, orderId: ID): Promise<Order> {
        const order = await this.getQuoteOrThrow(ctx, orderId, ['customer', 'shippingLines']);
        this.assertOpenQuote(order);
        if (!order.customer) {
            throw new UserInputError('A quote must have a customer assigned before it can be sent.');
        }
        if (!order.shippingLines || order.shippingLines.length === 0) {
            throw new UserInputError(
                'A quote must have a shipping method assigned before it can be sent.',
            );
        }

        const isResend = order.customFields.quoteStatus === 'sent';
        const revision = (order.customFields.quoteRevision ?? 0) + 1;
        await this.orderService.updateCustomFields(ctx, order.id, {
            quoteStatus: 'sent' satisfies QuoteStatus,
            quoteSentAt: new Date(),
            quoteRevision: revision,
        });
        await this.historyService.createHistoryEntryForOrder({
            ctx,
            orderId: order.id,
            type: QUOTE_SENT,
            data: {
                reference: order.customFields.quoteReference ?? order.code,
                revision,
                resend: isResend,
            },
        });

        const sent = await this.getQuoteOrThrow(ctx, order.id, ['customer']);
        await this.eventBus.publish(new QuoteSentEvent(ctx, sent, revision));

        Logger.info(`Quote ${sent.customFields.quoteReference} sent to customer (revision ${revision})`, loggerCtx);
        return sent;
    }

    /**
     * Sets or extends the validity date of a quote.
     */
    async setQuoteValidity(ctx: RequestContext, orderId: ID, validUntil: Date): Promise<Order> {
        const order = await this.getQuoteOrThrow(ctx, orderId);
        this.assertIsQuote(order);
        await this.orderService.updateCustomFields(ctx, orderId, { quoteValidUntil: validUntil });
        return this.getQuoteOrThrow(ctx, orderId);
    }

    /**
     * Edits the customer-facing notes on a quote.
     */
    async updateQuoteNotes(ctx: RequestContext, orderId: ID, notes: string): Promise<Order> {
        const order = await this.getQuoteOrThrow(ctx, orderId);
        this.assertIsQuote(order);
        await this.orderService.updateCustomFields(ctx, orderId, { quoteNotes: notes });
        return this.getQuoteOrThrow(ctx, orderId);
    }

    /**
     * Lists every order that has ever been a quote (`quoteReference` is set), newest first
     * unless overridden by `options`. Backs the Admin API `quotes` query; the dashboard's
     * Quotes list route uses it instead of the generic `orders` query so it never has to
     * duplicate the "what counts as a quote" filter.
     */
    async findQuotes(ctx: RequestContext, options?: OrderListOptions): Promise<PaginatedList<Order>> {
        const qb = this.listQueryBuilder.build(Order, options, {
            ctx,
            relations: ['customer', 'lines', 'channels'],
            channelId: ctx.channelId,
            where: { customFields: { quoteReference: Not(IsNull()) } },
            orderBy: options?.sort ? undefined : { updatedAt: 'DESC' },
        });
        const [items, totalItems] = await qb.getManyAndCount();
        return { items, totalItems };
    }

    // ---------------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------------

    private prefix(): string {
        return this.options.quoteReferencePrefix ?? 'Q';
    }

    /**
     * Shared tail of quote acceptance, called once ownership/sent-status/expiry have already
     * been validated by whichever caller (Shop `acceptQuote` or Admin `acceptQuoteAsStaff`).
     * Moves the order forward into the normal flow (`Draft -> ArrangingPayment`) and
     * reattaches it to the session as the active order so it becomes payable through the
     * normal session-bound Shop API checkout mutations regardless of who accepted it — the
     * customer via the storefront, or staff on their behalf after a phone/email
     * confirmation. No price recalculation happens: `transitionToState` does not call
     * `applyPriceAdjustments`, so the quoted lines, adjustments and prices are preserved.
     */
    private async finalizeAcceptance(ctx: RequestContext, order: Order): Promise<Order> {
        await this.orderService.updateCustomFields(ctx, order.id, {
            quoteAcceptedAt: new Date(),
            quoteStatus: 'accepted' satisfies QuoteStatus,
        });
        const arranging = this.assertOrder(
            await this.orderService.transitionToState(ctx, order.id, 'ArrangingPayment'),
        );
        await this.activateAndAttachToSession(ctx, arranging);
        await this.eventBus.publish(new QuoteAcceptedEvent(ctx, arranging));

        Logger.info(`Quote ${order.customFields.quoteReference} accepted and moved to ArrangingPayment`, loggerCtx);
        return arranging;
    }

    /**
     * Deactivates an order and, if it is the session's active order, unsets it — used when
     * a quote request is made so the customer's next add-to-cart starts a fresh order.
     */
    private async deactivateAndDetachFromSession(ctx: RequestContext, order: Order): Promise<void> {
        order.active = false;
        await this.connection.getRepository(ctx, Order).save(order, { reload: false });
        if (ctx.session && ctx.session.activeOrderId === order.id) {
            await this.sessionService.unsetActiveOrder(ctx, ctx.session);
        }
    }

    /**
     * Activates an order and, for a Shop API caller, attaches it to the current session as
     * the active order. `ActiveOrderService`/`SessionService` never do this automatically for
     * an order that wasn't already the session's active order, so both `acceptQuote` (order
     * must become payable via the normal session-bound checkout mutations) and
     * `withdrawQuoteRequest` (order must become usable as an ordinary cart again) need to do
     * it explicitly.
     *
     * The `ctx.apiType === 'shop'` guard is deliberate and load-bearing: for the Admin API
     * path (`acceptQuoteAsStaff`), `ctx.session` is the ADMINISTRATOR's own authenticated
     * session, not the customer's — calling `setActiveOrder` there would silently hijack the
     * staff member's session, pointing it at a customer's order (confirmed by tracing a real
     * sql.js `NOT NULL constraint failed: order.code` crash in a later, unrelated request
     * back to this exact call during e2e development). Setting `order.active = true` on the
     * order itself is sufficient for the staff path: once the customer later logs in on their
     * own (Shop API) session, `OrderService.getActiveOrderForUser`'s fallback picks up this
     * order as their active one without any session attachment having to happen here.
     */
    private async activateAndAttachToSession(ctx: RequestContext, order: Order): Promise<void> {
        order.active = true;
        await this.connection.getRepository(ctx, Order).save(order, { reload: false });
        if (ctx.session && ctx.apiType === 'shop') {
            await this.sessionService.setActiveOrder(ctx, ctx.session, order);
        }
    }

    /** Throws unless the order is currently an open (requested/sent) quote. */
    private assertOpenQuote(order: Order): void {
        this.assertIsQuote(order);
        if (!OPEN_QUOTE_STATUSES.includes(order.customFields.quoteStatus as QuoteStatus)) {
            throw new UserInputError(
                `Quote ${order.customFields.quoteReference ?? order.code} is "${order.customFields.quoteStatus}" and can no longer be acted on.`,
            );
        }
    }

    /** Throws unless the order is (or was) a quote at all. */
    private assertIsQuote(order: Order): void {
        if (order.customFields.quoteReference == null) {
            throw new UserInputError(`Order ${order.code} is not a quote.`);
        }
    }

    /**
     * Loads a quote by code and asserts the caller is the authenticated customer who owns
     * it. Throws `ForbiddenError` for unauthenticated callers or ownership mismatch;
     * returns `undefined` when no order exists for the code.
     */
    private async getOwnedQuoteByCode(ctx: RequestContext, orderCode: string): Promise<Order | undefined> {
        const order = await this.orderService.findOneByCode(ctx, orderCode, ['customer']);
        return this.assertOwnership(ctx, order);
    }

    /** As {@link getOwnedQuoteByCode}, but keyed by the human-readable `quoteReference`. */
    private async getOwnedQuoteByReference(ctx: RequestContext, reference: string): Promise<Order | undefined> {
        const match = await this.connection.getRepository(ctx, Order).findOne({
            where: { customFields: { quoteReference: reference } },
        });
        // Re-fetch through `OrderService.findOne`, which channel-scopes the result — the
        // lookup above is unscoped, since `customFields.quoteReference` isn't indexed per
        // channel the way `code` conceptually is.
        const order = match ? await this.orderService.findOne(ctx, match.id, ['customer']) : undefined;
        return this.assertOwnership(ctx, order);
    }

    private async assertOwnership(ctx: RequestContext, order: Order | undefined): Promise<Order | undefined> {
        if (!ctx.activeUserId) {
            throw new ForbiddenError();
        }
        if (!order) {
            return undefined;
        }
        const customer = await this.customerService.findOneByUserId(ctx, ctx.activeUserId);
        if (!customer || !order.customer || !idsEqual(order.customer.id, customer.id)) {
            throw new ForbiddenError();
        }
        return order;
    }

    private async getQuoteOrThrow(
        ctx: RequestContext,
        orderId: ID,
        relations: RelationPaths<Order> = [],
    ): Promise<Order> {
        const order = await this.orderService.findOne(ctx, orderId, relations);
        if (!order) {
            throw new EntityNotFoundError('Order', orderId);
        }
        return order;
    }

    /**
     * Unwraps the result of `transitionToState`, throwing a clear error if the transition
     * was blocked by a state-machine guard.
     *
     * Deliberately uses `isGraphQlErrorResult` (duck-typed on `errorCode`/`message`/
     * `__typename`) rather than `result instanceof OrderStateTransitionError`: an
     * `instanceof` check against a class imported from `@vendure/core` is only reliable if
     * there is exactly one resolved instance of that package in the dependency tree. Found
     * via a real crash — an illegal transition's `OrderStateTransitionError` silently passed
     * this check as if it were a valid `Order` (all fields `undefined`), which was then
     * handed to `Order`-typed persistence code, producing an opaque
     * `NOT NULL constraint failed: order.code` deep inside TypeORM instead of the intended
     * `UserInputError`. `isGraphQlErrorResult` is the same helper already used elsewhere in
     * this file (`rejectQuote`) and is what Vendure's own docs recommend for this exact
     * check.
     */
    private assertOrder(result: Order | OrderStateTransitionError): Order {
        if (isGraphQlErrorResult(result)) {
            throw new UserInputError(result.transitionError ?? result.message);
        }
        return result;
    }
}

function idsEqual(a: ID, b: ID): boolean {
    return String(a) === String(b);
}
