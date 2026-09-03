import { Inject, Injectable } from '@nestjs/common';
import {
    ActiveOrderService,
    EntityHydrator,
    ErrorResult,
    InternalServerError,
    LanguageCode,
    Logger,
    Order,
    OrderService,
    OrderStateTransitionError,
    Payment,
    PaymentMethod,
    PaymentMethodService,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';

import { PAYFAST_HANDLER_CODE, PAYFAST_PLUGIN_OPTIONS, loggerCtx } from './constants';
import { generatePayFastApiSignature, generatePayFastSignature } from './payfast.helpers';
import {
    ALL_PAYFAST_METHODS,
    PayFastCredentials,
    PayFastFormData,
    PayFastITNPayload,
    PayFastPaymentMethod,
    PayFastPluginOptions,
} from './types';

class PaymentIntentError implements ErrorResult {
    readonly __typename = 'PayfastPaymentIntentError';
    readonly errorCode = 'ORDER_PAYMENT_STATE_ERROR' as const;
    constructor(public readonly message: string) {}
}

@Injectable()
export class PayFastService {
    constructor(
        @Inject(PAYFAST_PLUGIN_OPTIONS) private options: PayFastPluginOptions,
        private activeOrderService: ActiveOrderService,
        private connection: TransactionalConnection,
        private entityHydrator: EntityHydrator,
        private orderService: OrderService,
        private paymentMethodService: PaymentMethodService,
        private requestContextService: RequestContextService,
    ) {
        Logger.info('PayFastService constructed', loggerCtx);
    }

    getPayFastUrl(sandbox: boolean): string {
        return sandbox
            ? 'https://sandbox.payfast.co.za/eng/process'
            : 'https://www.payfast.co.za/eng/process';
    }

    /**
     * Finds the PayFast-handler PaymentMethod assigned to the current channel.
     * Multiple PaymentMethods can share the `payfast` handler code with different
     * credentials (e.g. "PayFast Live" / "PayFast Test") — this resolves whichever
     * one is actually enabled + assigned to `ctx.channel`.
     */
    private async findChannelPayfastMethod(ctx: RequestContext): Promise<PaymentMethod | undefined> {
        const methods = await this.paymentMethodService.getActivePaymentMethods(ctx);
        return methods.find(m => m.handler.code === PAYFAST_HANDLER_CODE);
    }

    private getCredentialsFromMethod(method: PaymentMethod): PayFastCredentials {
        const get = (name: string) => method.handler.args.find(a => a.name === name)?.value;
        return {
            merchantId: get('merchantId') ?? '',
            merchantKey: get('merchantKey') ?? '',
            passphrase: get('passphrase') || undefined,
            sandbox: get('sandbox') === 'true',
        };
    }

    /**
     * Called by GET /payments/payfast/return after PayFast redirects the customer back.
     *
     * PayFast sends the ITN *before* redirecting the customer, so the order should
     * already be settled. A short retry loop handles any processing lag.
     *
     * Returns 'settled' if the order reached a paid state, 'failed' otherwise.
     */
    async resolveReturnRedirect(orderCode: string): Promise<'settled' | 'failed'> {
        const settledStates = new Set([
            'PaymentSettled', 'PaymentAuthorized',
            'PartiallyShipped', 'Shipped',
            'PartiallyDelivered', 'Delivered',
        ]);

        const ctx = await this.requestContextService.create({
            apiType: 'admin',
            languageCode: LanguageCode.en,
        });

        const MAX_ATTEMPTS = 5;
        const DELAY_MS = 1_000;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const order = await this.orderService.findOneByCode(ctx, orderCode);
            if (order && settledStates.has(order.state)) {
                Logger.info(
                    `[resolveReturnRedirect] Order ${orderCode} is ${order.state} (attempt ${attempt}) — settled`,
                    loggerCtx,
                );
                return 'settled';
            }
            Logger.info(
                `[resolveReturnRedirect] Order ${orderCode} state: ${order?.state ?? 'not found'} — attempt ${attempt}/${MAX_ATTEMPTS}`,
                loggerCtx,
            );
            if (attempt < MAX_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, DELAY_MS));
            }
        }

        Logger.warn(
            `[resolveReturnRedirect] Order ${orderCode} did not reach a settled state after ${MAX_ATTEMPTS} attempts`,
            loggerCtx,
        );
        return 'failed';
    }

    private getValidationUrl(sandbox: boolean): string {
        return sandbox
            ? 'https://sandbox.payfast.co.za/eng/query/validate'
            : 'https://www.payfast.co.za/eng/query/validate';
    }

    /**
     * Confirms ITN data with the PayFast server.
     * Posts the raw ITN payload back to PayFast's validation endpoint.
     * PayFast responds with plain text "VALID" or "INVALID".
     */
    private async validateWithPayFast(payload: PayFastITNPayload, sandbox: boolean): Promise<boolean> {
        const url = this.getValidationUrl(sandbox);

        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(payload)) {
            if (value !== undefined) params.set(key, value);
        }

        Logger.info(`[validateWithPayFast] POST ${url}`, loggerCtx);

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        });

        const text = (await response.text()).trim();
        Logger.info(`[validateWithPayFast] Response ${response.status}: "${text}"`, loggerCtx);

        return text === 'VALID';
    }

    /**
     * Flow B — headless mutation pattern (createPayfastPaymentIntent).
     * Accepts a single callbackUrl matching the Paystack pattern.
     * Uses callbackUrl as return_url and callbackUrl?cancelled=1 as cancel_url.
     * The channelToken is stored in custom_str1 so the ITN can route to the right channel.
     */
    async initializeTransaction(
        ctx: RequestContext,
        redirectUrl: string,
        paymentMethod?: PayFastPaymentMethod,
    ): Promise<{ __typename: 'PayfastPaymentIntent'; url: string } | PaymentIntentError> {
        Logger.info(`[initializeTransaction] Starting — channel: ${ctx.channel.token}, redirectUrl: ${redirectUrl}`, loggerCtx);

        const sessionOrder = await this.activeOrderService.getActiveOrder(ctx, undefined);
        if (!sessionOrder) {
            Logger.warn('[initializeTransaction] No active order found for session', loggerCtx);
            throw new UserInputError('No active order found for session');
        }
        Logger.info(`[initializeTransaction] Active order: ${sessionOrder.code}, state: ${sessionOrder.state}`, loggerCtx);

        const order = await this.orderService.findOne(ctx, sessionOrder.id, ['customer']);
        if (!order) {
            Logger.error(`[initializeTransaction] Order ${sessionOrder.id} not found after findOne`, loggerCtx);
            throw new InternalServerError('Order not found');
        }

        if (!order.customer) {
            Logger.error(`[initializeTransaction] Order ${order.code} has no customer attached`, loggerCtx);
            throw new UserInputError('No customer found for active order. Please ensure customer is set before payment.');
        }

        Logger.info(
            `[initializeTransaction] Order ${order.code} — total: ${order.totalWithTax}, customer: ${order.customer.emailAddress}`,
            loggerCtx,
        );

        const payFastMethod = await this.findChannelPayfastMethod(ctx);
        if (!payFastMethod) {
            Logger.error(`[initializeTransaction] No PayFast payment method assigned to channel "${ctx.channel.token}"`, loggerCtx);
            throw new UserInputError(`No PayFast payment method is assigned to channel "${ctx.channel.token}"`);
        }
        // createPayfastPaymentIntent is a custom mutation that builds the redirect directly —
        // it never goes through addPaymentToOrder/PaymentService.createPayment, which is the
        // only place Vendure normally invokes a PaymentMethod's eligibility checker. Without this
        // explicit check, a PaymentMethodEligibilityChecker attached to the PayFast method (e.g.
        // payfast-minimum-payment.checker.ts) would silently never run for this flow.
        const eligibleMethods = await this.paymentMethodService.getEligiblePaymentMethods(ctx, order);
        const eligibility = eligibleMethods.find(m => String(m.id) === String(payFastMethod.id));
        if (eligibility && !eligibility.isEligible) {
            Logger.warn(
                `[initializeTransaction] Order ${order.code} is not eligible for PayFast: ${eligibility.eligibilityMessage ?? '(no message)'}`,
                loggerCtx,
            );
            return new PaymentIntentError(eligibility.eligibilityMessage ?? 'This order is not eligible for PayFast.');
        }

        const credentials = this.getCredentialsFromMethod(payFastMethod);
        Logger.info(
            `[initializeTransaction] Using PaymentMethod "${payFastMethod.code}" — ` +
            `merchant_id: ${credentials.merchantId}, sandbox: ${credentials.sandbox}`,
            loggerCtx,
        );

        // Route the PayFast return through the Vendure backend so it can verify
        // the order is actually settled before forwarding the customer to the
        // storefront. This protects every frontend regardless of implementation.
        const returnUrl =
            `${this.options.vendureHost}/payments/payfast/return` +
            `?orderCode=${order.code}` +
            `&redirectUrl=${encodeURIComponent(redirectUrl)}`;

        // Cancel URL goes straight to the storefront — no settlement needed.
        const cancelUrl = redirectUrl.includes('?')
            ? `${redirectUrl}&cancelled=1`
            : `${redirectUrl}?cancelled=1`;

        const formData = this.buildFormData(
            order.code,
            order.totalWithTax,
            order.customer,
            ctx.channel.token,
            { returnUrl, cancelUrl },
            credentials,
            paymentMethod,
        );
        const payfastUrl = this.getPayFastUrl(credentials.sandbox);

        Logger.info(`[initializeTransaction] PayFast URL: ${payfastUrl}`, loggerCtx);
        Logger.info(`[initializeTransaction] notify_url: ${formData.notify_url}`, loggerCtx);
        Logger.info(`[initializeTransaction] return_url: ${formData.return_url}`, loggerCtx);
        Logger.info(`[initializeTransaction] cancel_url: ${formData.cancel_url}`, loggerCtx);
        Logger.info(`[initializeTransaction] amount: ${formData.amount}, m_payment_id: ${formData.m_payment_id}`, loggerCtx);
        Logger.info(`[initializeTransaction] custom_str1 (channelToken): ${formData.custom_str1}`, loggerCtx);
        Logger.info(`[initializeTransaction] payment_method (in signed formData): ${formData.payment_method ?? '(none — all account-enabled methods will be offered)'}`, loggerCtx);

        const url = this.buildRedirectUrl(formData, payfastUrl);

        Logger.info(`[initializeTransaction] POST-redirect URL built for order ${order.code}`, loggerCtx);
        return { __typename: 'PayfastPaymentIntent' as const, url };
    }

    /**
     * PayFast's documented checkout-initiation flow requires the transaction fields to be
     * submitted as a POST'd HTML form — a plain GET to /eng/process is only tolerated
     * informally for the core fields (merchant_id/amount/signature all still validate and
     * the payment settles), but does not reliably honour finer checkout-page behaviour like
     * the payment_method restriction.
     *
     * To keep this transparent to every storefront (no frontend change required — the
     * mutation still just returns a `url` to `window.location.href` to), this returns a
     * same-origin URL on our own server. `PayFastController.handleRedirect` renders a tiny
     * auto-submitting HTML page with a real `method="POST"` form to PayFast, carrying every
     * field (including the signature) as a hidden input.
     */
    buildRedirectUrl(formData: PayFastFormData, payfastUrl: string): string {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(formData)) {
            if (value !== undefined) params.set(key, value);
        }
        params.set('__payfastUrl', payfastUrl);
        return `${this.options.vendureHost}/payments/payfast/redirect?${params.toString()}`;
    }

    /**
     * Builds the PayFast form data.
     * returnUrl and cancelUrl come from the caller (storefront or mutation input).
     * channelToken is stored in custom_str1 for multi-channel ITN processing.
     */
    buildFormData(
        orderCode: string,
        totalWithTax: number,
        customer: { firstName?: string; lastName?: string; emailAddress?: string } | undefined,
        channelToken: string,
        input: { returnUrl: string; cancelUrl: string },
        credentials: PayFastCredentials,
        paymentMethod?: PayFastPaymentMethod,
    ): PayFastFormData {
        const notifyUrl = `${this.options.vendureHost}/payments/payfast/notify`;

        // Fields in PayFast documented order (insertion order preserved — no sort in signature helper)
        const data: Record<string, string> = {
            merchant_id: credentials.merchantId,
            merchant_key: credentials.merchantKey,
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
            notify_url: notifyUrl,
        };

        if (customer?.firstName) data.name_first = customer.firstName;
        if (customer?.lastName) data.name_last = customer.lastName;
        if (customer?.emailAddress) data.email_address = customer.emailAddress;

        data.m_payment_id = orderCode;
        data.amount = (totalWithTax / 100).toFixed(2);
        data.item_name = `Order ${orderCode}`;
        data.custom_str1 = channelToken;
        // payment_method must come after custom_str/custom_int fields per PayFast docs
        if (paymentMethod) data.payment_method = paymentMethod;

        data.signature = generatePayFastSignature(data, credentials.passphrase);

        return data as PayFastFormData;
    }

    /**
     * Handles a PayFast ITN (Instant Transaction Notification).
     *
     * Detects which flow was used:
     * - Flow A (addPaymentToOrder): an Authorized payment already exists → settle it.
     * - Flow B (createPayFastPaymentIntent): no payment yet → addPaymentToOrder (admin ctx).
     */
    async handleITN(payload: PayFastITNPayload): Promise<void> {
        Logger.info(
            `[handleITN] Received — m_payment_id: ${payload.m_payment_id}, pf_payment_id: ${payload.pf_payment_id}, status: ${payload.payment_status}`,
            loggerCtx,
        );
        Logger.info(`[handleITN] Raw payload: ${JSON.stringify(payload)}`, loggerCtx);

        // 1. Channel token from custom_str1 for multi-channel support — resolved first because
        // credentials (and therefore signature/validation/merchant checks below) are now
        // per-channel, not global (multiple PaymentMethods can share the `payfast` handler
        // code with different merchant accounts, e.g. "PayFast Live" / "PayFast Test").
        const channelToken = payload.custom_str1;
        Logger.info(`[handleITN] channelToken from custom_str1: "${channelToken}"`, loggerCtx);

        const outerCtx = await this.requestContextService.create({
            apiType: 'admin',
            channelOrToken: channelToken || undefined,
            languageCode: LanguageCode.en,
        });
        Logger.info(`[handleITN] Admin context created for channel: ${outerCtx.channel.token}`, loggerCtx);

        // 2. Resolve which PayFast PaymentMethod (and therefore which credentials) is assigned
        // to this channel.
        const payFastMethod = await this.findChannelPayfastMethod(outerCtx);
        if (!payFastMethod) {
            Logger.error(`[handleITN] No PayFast payment method assigned to channel "${outerCtx.channel.token}"`, loggerCtx);
            throw new Error('No PayFast payment method assigned to this channel');
        }
        const credentials = this.getCredentialsFromMethod(payFastMethod);
        Logger.info(`[handleITN] Using PayFast payment method: ${payFastMethod.code}`, loggerCtx);

        // 3. Verify signature — ITN: insertion order, empty fields included, passphrase appended
        const { signature, ...rest } = payload;
        const expectedSig = generatePayFastSignature(rest, credentials.passphrase, true);
        Logger.info(`[handleITN] Signature check — received: ${signature}, expected: ${expectedSig}`, loggerCtx);
        if (signature !== expectedSig) {
            Logger.error('[handleITN] Signature verification FAILED', loggerCtx);
            throw new Error('Invalid signature');
        }
        Logger.info('[handleITN] Signature OK', loggerCtx);

        // 4. Confirm data with PayFast server
        const isValid = await this.validateWithPayFast(payload, credentials.sandbox);
        if (!isValid) {
            Logger.error('[handleITN] PayFast server validation FAILED — payload rejected', loggerCtx);
            throw new Error('PayFast server validation failed');
        }
        Logger.info('[handleITN] PayFast server validation OK', loggerCtx);

        // 5. Verify merchant account
        if (payload.merchant_id !== credentials.merchantId) {
            Logger.error(
                `[handleITN] merchant_id mismatch — received: ${payload.merchant_id}, expected: ${credentials.merchantId}`,
                loggerCtx,
            );
            throw new Error('Invalid merchant ID');
        }
        Logger.info('[handleITN] Merchant ID OK', loggerCtx);

        // 6. Only process COMPLETE payments
        if (payload.payment_status !== 'COMPLETE') {
            Logger.warn(`[handleITN] Ignoring status "${payload.payment_status}" for order ${payload.m_payment_id}`, loggerCtx);
            return;
        }

        await this.connection.withTransaction(outerCtx, async (ctx) => {
            // 7. Load order
            Logger.info(`[handleITN] Looking up order by code: ${payload.m_payment_id}`, loggerCtx);
            const order = await this.orderService.findOneByCode(ctx, payload.m_payment_id, ['payments']);
            if (!order) {
                Logger.error(`[handleITN] Order not found — code: ${payload.m_payment_id}`, loggerCtx);
                throw new Error('Order not found');
            }
            Logger.info(`[handleITN] Order found — id: ${order.id}, state: ${order.state}, payments: ${order.payments?.length ?? 0}`, loggerCtx);

            // 8. Verify amount (fraud prevention)
            const expectedAmount = (order.totalWithTax / 100).toFixed(2);
            Logger.info(`[handleITN] Amount check — expected: ${expectedAmount}, received: ${payload.amount_gross}`, loggerCtx);
            if (payload.amount_gross !== expectedAmount) {
                Logger.error(
                    `[handleITN] Amount mismatch — expected: ${expectedAmount}, received: ${payload.amount_gross}`,
                    loggerCtx,
                );
                throw new Error('Amount mismatch');
            }
            Logger.info('[handleITN] Amount OK', loggerCtx);

            // 9. Hydrate payments
            await this.entityHydrator.hydrate(ctx, order, { relations: ['payments'] });

            // 10. Idempotency — skip if already settled for this pf_payment_id
            const alreadySettled = order.payments?.find(
                (p) => p.transactionId === payload.pf_payment_id && p.state === 'Settled',
            );
            if (alreadySettled) {
                Logger.info(`[handleITN] Already settled (pf_payment_id: ${payload.pf_payment_id}) — skipping`, loggerCtx);
                return;
            }

            // 11. Detect flow
            const authorizedPayment = order.payments?.find(
                (p) => p.transactionId === payload.m_payment_id && p.state === 'Authorized',
            );

            if (authorizedPayment) {
                // ── Flow A: addPaymentToOrder was already called, payment is Authorized ──
                Logger.info(
                    `[handleITN] Flow A — found Authorized payment id: ${authorizedPayment.id}, settling via transitionPaymentToState`,
                    loggerCtx,
                );

                // Enrich metadata with ITN details before settling
                await this.connection.getRepository(ctx, Payment).save({
                    id: authorizedPayment.id,
                    metadata: {
                        ...authorizedPayment.metadata,
                        pfPaymentId: payload.pf_payment_id,
                        amountGross: payload.amount_gross,
                        amountFee: payload.amount_fee,
                        amountNet: payload.amount_net,
                        public: {
                            ...authorizedPayment.metadata?.public,
                            pfPaymentId: payload.pf_payment_id,
                            amountGross: payload.amount_gross,
                        },
                    },
                });

                const settleResult = await this.orderService.transitionPaymentToState(ctx, authorizedPayment.id, 'Settled');
                if (settleResult instanceof Object && 'message' in settleResult) {
                    Logger.error(
                        `[handleITN] transitionPaymentToState failed: ${(settleResult as any).message}`,
                        loggerCtx,
                    );
                    throw new Error(`Failed to settle payment: ${(settleResult as any).message}`);
                }
                Logger.info(`[handleITN] Flow A — payment settled for order ${order.code}`, loggerCtx);

            } else {
                // ── Flow B: createPayFastPaymentIntent was used, no payment record yet ──
                Logger.info(`[handleITN] Flow B — no Authorized payment found, using addPaymentToOrder`, loggerCtx);

                // Transition to ArrangingPayment if needed
                Logger.info(`[handleITN] Current order state: ${order.state}`, loggerCtx);
                if (order.state !== 'ArrangingPayment') {
                    Logger.info(`[handleITN] Transitioning order ${order.code} → ArrangingPayment`, loggerCtx);
                    const transitionResult = await this.orderService.transitionToState(ctx, order.id, 'ArrangingPayment');
                    if (transitionResult instanceof OrderStateTransitionError) {
                        Logger.error(
                            `[handleITN] State transition failed: ${transitionResult.message}`,
                            loggerCtx,
                        );
                        throw new Error(`State transition failed: ${transitionResult.message}`);
                    }
                    Logger.info(`[handleITN] Order ${order.code} now in ArrangingPayment`, loggerCtx);
                }

                // payFastMethod was already resolved for this channel before the signature/
                // validation checks above — reuse its code rather than re-querying.
                const addPaymentResult = await this.orderService.addPaymentToOrder(ctx, order.id, {
                    method: payFastMethod.code,
                    metadata: {
                        pfPaymentId: payload.pf_payment_id,
                        amountGross: payload.amount_gross,
                        amountFee: payload.amount_fee,
                        amountNet: payload.amount_net,
                        paymentStatus: payload.payment_status,
                        ...(payload.name_first && { nameFirst: payload.name_first }),
                        ...(payload.name_last && { nameLast: payload.name_last }),
                        ...(payload.email_address && { emailAddress: payload.email_address }),
                        public: {
                            pfPaymentId: payload.pf_payment_id,
                            amountGross: payload.amount_gross,
                        },
                    },
                });

                if (addPaymentResult instanceof Order) {
                    Logger.info(
                        `[handleITN] Flow B — payment settled, order ${order.code} now in state: ${addPaymentResult.state}`,
                        loggerCtx,
                    );
                } else {
                    const errResult = addPaymentResult as any;
                    Logger.error(
                        `[handleITN] addPaymentToOrder error — errorCode: ${errResult?.errorCode}, message: ${errResult?.message}`,
                        loggerCtx,
                    );
                    throw new Error(`Failed to add payment: ${errResult?.message}`);
                }
            }
        });
    }

    // ─── Payment Method Options ─────────────────────────────────────────────────

    /**
     * Returns the PayFast payment method options available for the current channel.
     *
     * Each method is a separate boolean handler arg (e.g. `ef`, `cc`, `gp`).
     * An arg value of 'true' (default) means the method is enabled.
     */
    async getAvailablePaymentMethods(
        ctx: RequestContext,
    ): Promise<Array<{ code: string; label: string; description: string }>> {
        const payFastMethod = await this.findChannelPayfastMethod(ctx);

        if (!payFastMethod) {
            return ALL_PAYFAST_METHODS;
        }

        const args = payFastMethod.handler.args;

        // Filter methods where the arg is not explicitly set to 'false'.
        // Unrecognised / missing args default to enabled (true).
        return ALL_PAYFAST_METHODS.filter(m => {
            const arg = args.find(a => a.name === m.code);
            return arg ? arg.value !== 'false' : true;
        });
    }

    // ─── Refund API ────────────────────────────────────────────────────────────

    /**
     * Builds headers for every PayFast REST API call.
     * Signature = MD5 of alphabetical sort of all header vars + body vars + passphrase.
     * Per official docs: developers.payfast.co.za/api#refunds
     */
    private buildApiHeaders(
        bodyParams: Record<string, string>,
        credentials: Pick<PayFastCredentials, 'merchantId' | 'passphrase'>,
    ): Record<string, string> {
        const pad = (n: number) => String(n).padStart(2, '0');
        // South Africa is always UTC+2 (no DST). Add 2 h offset so UTC getters give SA time.
        const sa = new Date(Date.now() + 2 * 60 * 60 * 1000);
        const timestamp =
            `${sa.getUTCFullYear()}-${pad(sa.getUTCMonth() + 1)}-${pad(sa.getUTCDate())}` +
            `T${pad(sa.getUTCHours())}:${pad(sa.getUTCMinutes())}:${pad(sa.getUTCSeconds())}+02:00`;

        const headerVars: Record<string, string> = {
            'merchant-id': credentials.merchantId,
            'timestamp': timestamp,
            'version': 'v1',
        };

        const signature = generatePayFastApiSignature(
            { ...headerVars, ...bodyParams },
            credentials.passphrase,
        );

        return { ...headerVars, 'signature': signature, 'Content-Type': 'application/json' };
    }

    private apiUrl(path: string, sandbox: boolean): string {
        const base = `https://api.payfast.co.za${path}`;
        return sandbox ? `${base}?testing=true` : base;
    }

    /**
     * Queries a PayFast payment to check refund eligibility before attempting a refund.
     * Endpoint: GET /refunds/query/:pf_payment_id
     */
    async queryRefund(pfPaymentId: string, credentials: PayFastCredentials): Promise<{
        status: string;
        amountAvailable: number;
        fullMethod: string;
        partialMethod: string;
        raw: Record<string, unknown>;
    }> {
        const headers = this.buildApiHeaders({}, credentials);
        const url = this.apiUrl(`/refunds/query/${pfPaymentId}`, credentials.sandbox);
        Logger.info(`[queryRefund] GET ${url}`, loggerCtx);

        const response = await fetch(url, { method: 'GET', headers });
        const text = await response.text();
        Logger.info(`[queryRefund] Response ${response.status}: ${text}`, loggerCtx);

        if (!response.ok) throw new Error(`PayFast query failed ${response.status}: ${text}`);

        const data = JSON.parse(text);
        return {
            status: data.status,
            amountAvailable: data.amount_available_for_refund,
            fullMethod: data.refund_full?.method ?? 'NOT_AVAILABLE',
            partialMethod: data.refund_partial?.method ?? 'NOT_AVAILABLE',
            raw: data,
        };
    }

    /**
     * Creates a refund via the PayFast Refunds API.
     *
     * Flow:
     *  1. Query the payment — check REFUNDABLE status and refund method.
     *  2. PAYMENT_SOURCE → auto-refund to original card/wallet (returns success).
     *     BANK_PAYOUT → bank details needed; returns requiresBankDetails=true
     *                   so the handler records Pending for manual admin action.
     *
     * Amount is in cents (Vendure's format) — passed directly, no conversion.
     * Reason is required by PayFast (3-255 chars).
     */
    async processRefund(
        pfPaymentId: string,
        amount: number,
        reason: string,
        credentials: PayFastCredentials,
    ): Promise<{ success: boolean; requiresBankDetails?: boolean; error?: string; metadata?: Record<string, unknown> }> {
        // Step 1 — query
        let query: Awaited<ReturnType<typeof this.queryRefund>>;
        try {
            query = await this.queryRefund(pfPaymentId, credentials);
        } catch (e: any) {
            return { success: false, error: `Query failed: ${e.message}` };
        }

        Logger.info(
            `[processRefund] status: ${query.status}, available: ${query.amountAvailable} cents, ` +
            `fullMethod: ${query.fullMethod}, partialMethod: ${query.partialMethod}`,
            loggerCtx,
        );

        if (query.status !== 'REFUNDABLE') {
            return { success: false, error: `Payment not refundable (status: ${query.status})` };
        }
        if (amount > query.amountAvailable) {
            return { success: false, error: `Amount ${amount} exceeds available ${query.amountAvailable} cents` };
        }

        const method = amount === query.amountAvailable ? query.fullMethod : query.partialMethod;

        if (method === 'NOT_AVAILABLE') {
            return { success: false, error: 'Refund method is NOT_AVAILABLE for this payment' };
        }
        if (method === 'BANK_PAYOUT') {
            Logger.warn(
                `[processRefund] BANK_PAYOUT required for pf_payment_id ${pfPaymentId} — ` +
                `process manually in PayFast dashboard`,
                loggerCtx,
            );
            return { success: false, requiresBankDetails: true, metadata: query.raw };
        }

        // Step 2 — POST refund (PAYMENT_SOURCE)
        const safeReason = (reason || 'Refund').slice(0, 255).padEnd(3, '.');
        const bodyParams: Record<string, string> = {
            amount: String(amount),
            notify_buyer: '1',
            reason: safeReason,
        };
        const headers = this.buildApiHeaders(bodyParams, credentials);
        const url = this.apiUrl(`/refunds/${pfPaymentId}`, credentials.sandbox);

        Logger.info(`[processRefund] POST ${url} — amount: ${amount} cents, reason: "${safeReason}"`, loggerCtx);

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ amount, notify_buyer: 1, reason: safeReason }),
        });

        const text = await response.text();
        Logger.info(`[processRefund] Response ${response.status}: ${text}`, loggerCtx);

        if (!response.ok) {
            return { success: false, error: `PayFast API ${response.status}: ${text}` };
        }

        const data = JSON.parse(text);
        return data?.data?.response === true
            ? { success: true, metadata: data }
            : { success: false, error: data?.data?.message ?? 'Unknown error from PayFast' };
    }
}
