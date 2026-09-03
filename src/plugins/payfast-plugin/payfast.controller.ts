import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Allow, Logger, Permission } from '@vendure/core';

import { loggerCtx } from './constants';
import { PayFastService } from './payfast.service';
import { PayFastITNPayload } from './types';

const VALID_PAYFAST_HOSTS = new Set([
    'www.payfast.co.za',
    'sandbox.payfast.co.za',
    'w1w.payfast.co.za',
    'w2w.payfast.co.za',
]);

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

@Controller('payments/payfast')
export class PayFastController {
    constructor(private payFastService: PayFastService) {}

    /**
     * Renders a same-origin auto-submitting HTML form that POSTs the signed checkout
     * fields to PayFast's `/eng/process` endpoint — PayFast's documented checkout
     * initiation flow requires POST; a plain GET is only tolerated informally and does
     * not reliably apply checkout-page behaviour like the `payment_method` restriction.
     *
     * Reached via `window.location.href` from the storefront, exactly like a direct
     * PayFast link would be — the browser is simply bounced through our own server first
     * so it can issue a real POST. `__payfastUrl` selects live vs sandbox and is
     * allowlisted against `VALID_PAYFAST_HOSTS` to prevent this public endpoint being
     * used as an open redirect.
     */
    @Get('redirect')
    @Allow(Permission.Public)
    async handleRedirect(@Req() req: Request, @Res() res: Response): Promise<void> {
        const query = req.query as Record<string, string>;
        const { __payfastUrl: payfastUrl, ...fields } = query;

        let payfastHost: string;
        try {
            payfastHost = new URL(String(payfastUrl ?? '')).hostname;
        } catch {
            payfastHost = '';
        }
        if (!payfastUrl || !VALID_PAYFAST_HOSTS.has(payfastHost)) {
            Logger.error(`[redirect] Invalid or missing __payfastUrl host: "${payfastHost}"`, loggerCtx);
            res.status(400).send('Bad Request');
            return;
        }

        const inputs = Object.entries(fields)
            .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value))}">`)
            .join('\n    ');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Redirecting to PayFast…</title>
</head>
<body>
    <p>Redirecting to PayFast, please wait…</p>
    <form id="payfast-form" method="POST" action="${escapeHtml(payfastUrl)}">
    ${inputs}
        <noscript><button type="submit">Continue to PayFast</button></noscript>
    </form>
    <script>document.getElementById('payfast-form').submit();</script>
</body>
</html>`;

        res.status(200).type('html').send(html);
    }

    /**
     * PayFast return URL — called when the customer is redirected back after payment.
     *
     * PayFast sends the ITN before redirecting, so the order should already be
     * settled. We verify the order state (with retries) and redirect the customer
     * to the storefront with either ?orderCode= (success) or ?paymentFailed=1.
     *
     * All frontends receive a definitive result without any polling logic.
     */
    @Get('return')
    @Allow(Permission.Public)
    async handleReturn(
        @Query('orderCode') orderCode: string,
        @Query('redirectUrl') redirectUrl: string,
        @Res() res: Response,
    ): Promise<void> {
        Logger.info(`[return] orderCode: ${orderCode}, redirectUrl: ${redirectUrl}`, loggerCtx);

        if (!orderCode || !redirectUrl) {
            Logger.error('[return] Missing orderCode or redirectUrl query params', loggerCtx);
            res.status(400).send('Bad Request');
            return;
        }

        const base = decodeURIComponent(redirectUrl);
        const result = await this.payFastService.resolveReturnRedirect(orderCode);

        if (result === 'settled') {
            const successUrl = `${base}${base.includes('?') ? '&' : '?'}orderCode=${orderCode}`;
            Logger.info(`[return] Payment settled — redirecting to ${successUrl}`, loggerCtx);
            res.redirect(successUrl);
        } else {
            const failUrl = `${base}${base.includes('?') ? '&' : '?'}paymentFailed=1&orderCode=${orderCode}`;
            Logger.warn(`[return] Payment not settled — redirecting to ${failUrl}`, loggerCtx);
            res.redirect(failUrl);
        }
    }

    /**
     * PayFast may send a GET to validate the notify URL is reachable.
     */
    @Get('notify')
    @HttpCode(200)
    @Allow(Permission.Public)
    async validateNotifyUrl(): Promise<string> {
        Logger.info('[ITN] GET /payments/payfast/notify — URL validation ping', loggerCtx);
        return 'OK';
    }

    /**
     * PayFast ITN (Instant Transaction Notification) — server-to-server POST.
     * PayFast sends application/x-www-form-urlencoded data.
     * Must respond with HTTP 200 within a few seconds.
     */
    @Post('notify')
    @HttpCode(200)
    @Allow(Permission.Public)
    async handleITN(@Body() body: PayFastITNPayload, @Req() req: Request): Promise<string> {
        const referer = req.headers['referer'] ?? req.headers['referrer'] ?? '';
        Logger.info(`[ITN] POST /payments/payfast/notify — Referer: ${referer}`, loggerCtx);
        Logger.info(`[ITN] Raw body keys: ${Object.keys(body).join(', ')}`, loggerCtx);

        let refererHost: string;
        try {
            refererHost = new URL(String(referer)).hostname;
        } catch {
            refererHost = '';
        }

        if (!VALID_PAYFAST_HOSTS.has(refererHost)) {
            Logger.error(`[ITN] Domain validation FAILED — referer host "${refererHost}" is not a valid PayFast domain`, loggerCtx);
            return 'ERROR';
        }
        Logger.info(`[ITN] Domain validation OK — ${refererHost}`, loggerCtx);

        try {
            await this.payFastService.handleITN(body);
            Logger.info('[ITN] Processing complete — responding OK', loggerCtx);
            return 'OK';
        } catch (e: any) {
            // Return 200 even on errors to prevent PayFast from retrying indefinitely.
            Logger.error(`[ITN] Processing error: ${e.message}`, loggerCtx);
            Logger.error(`[ITN] Stack: ${e.stack}`, loggerCtx);
            return 'ERROR';
        }
    }
}
