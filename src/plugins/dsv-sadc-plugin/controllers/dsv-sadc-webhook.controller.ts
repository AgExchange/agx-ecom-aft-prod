import {
    Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post, Query, Res,
    ServiceUnavailableException,
} from '@nestjs/common';
import { Allow, Ctx, HistoryService, Logger, OrderService, Permission, RequestContext } from '@vendure/core';
import { Response } from 'express';
import { DsvSadcLabelService, LabelFormat } from '../services/dsv-label.service';
import { TrackingEventRequest } from '../types/plugin-options.types';
import { DSV_SADC_TRACKING, DsvSadcTrackingData } from '../types/history.types';
import { loggerCtx } from '../constants';

@Controller('shipping/dsv-sadc')
export class DsvSadcWebhookController {
    constructor(
        private readonly orderService: OrderService,
        private readonly labelService: DsvSadcLabelService,
        private readonly historyService: HistoryService,
    ) {}

    /**
     * On-demand label retrieval. Admin-only. Fetches the label live from DSV
     * (RetrieveShipmentLabelsTMS, with the service's built-in retry) by the ClientZone
     * ShipmentId — which is the fulfillment's `trackingCode`.
     *   GET /shipping/dsv-sadc/label/LANDS00000006          → PDF (inline)
     *   GET /shipping/dsv-sadc/label/LANDS00000006?type=zpl → ZPL
     *   GET /shipping/dsv-sadc/label/LANDS00000006?type=data → raw label XML
     */
    @Get('label/:shipmentId')
    @Allow(Permission.ReadOrder)
    async getLabel(
        @Param('shipmentId') shipmentId: string,
        @Query('type') type: string | undefined,
        @Res() res: Response,
    ): Promise<void> {
        const format = this.mapLabelFormat(type);
        const result = await this.labelService.getByShipmentId(shipmentId, format);

        if (result.responseCode !== '0' || !result.binaryLabel) {
            const msg =
                result.responseCode === '300'
                    ? `Label not ready for ${shipmentId} — the TMS is still routing the shipment. Try again shortly.`
                    : `Label unavailable for ${shipmentId} (code ${result.responseCode}): ${result.responseMessage ?? ''}`;
            Logger.warn(`[DSV SADC label] ${msg}`, loggerCtx);
            throw new HttpException(msg, HttpStatus.BAD_GATEWAY);
        }

        if (format === 'Parcel Label PDF') {
            // PDF <Binary> is base64-encoded.
            const buf = Buffer.from(result.binaryLabel, 'base64');
            res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${shipmentId}.pdf"` });
            res.send(buf);
        } else if (format === 'Parcel Label ZPL') {
            // ZPL is returned as-is (printer-ready). If DSV base64-encodes it, decode client-side.
            res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${shipmentId}.zpl"` });
            res.send(result.binaryLabel);
        } else {
            res.set({ 'Content-Type': 'application/xml; charset=utf-8' });
            res.send(result.binaryLabel);
        }
    }

    private mapLabelFormat(type: string | undefined): LabelFormat {
        switch ((type ?? 'pdf').toLowerCase()) {
            case 'zpl':
                return 'Parcel Label ZPL';
            case 'data':
                return 'Parcel Label Data';
            default:
                return 'Parcel Label PDF';
        }
    }

    @Post('webhook')
    @HttpCode(200)
    @Allow(Permission.Public)
    async handleTrackingEvent(
        @Ctx() ctx: RequestContext,
        @Body() body: TrackingEventRequest,
    ): Promise<string> {
        const eventCode = body?.eventCode ?? 'UNKNOWN';
        const primaryRef = body?.primaryReference;

        Logger.info(`[DSV SADC webhook] ${eventCode} — order ref: ${primaryRef}`, loggerCtx);

        if (!primaryRef) {
            Logger.warn('[DSV SADC webhook] Missing primaryReference — ignoring', loggerCtx);
            return 'OK';
        }

        let order: Awaited<ReturnType<OrderService['findOneByCode']>>;
        try {
            order = await this.orderService.findOneByCode(ctx, primaryRef);
        } catch {
            order = undefined;
        }

        if (!order) {
            Logger.warn(`[DSV SADC webhook] Order not found for ref "${primaryRef}" — returning 503 for retry`, loggerCtx);
            throw new ServiceUnavailableException('Order not found');
        }

        const message = this.buildMessage(body);
        const iso = this.toCanonicalIso(body.eventDateTime);
        const data: DsvSadcTrackingData = {
            eventCode: body.eventCode ?? 'UNKNOWN',
            message,
            ...(iso ? { eventDateTime: iso } : {}),
            ...(!iso && body.eventDateTime ? { eventDateTimeRaw: body.eventDateTime } : {}),
        };
        await this.historyService.createHistoryEntryForOrder(
            { orderId: order.id, ctx, type: DSV_SADC_TRACKING, data },
            false,
        );

        Logger.info(`[DSV SADC webhook] Recorded "${message}" on order ${order.code}`, loggerCtx);
        return 'OK';
    }

    /**
     * Human-readable summary of the DSV event, WITHOUT a timestamp. The event
     * instant is carried separately as canonical UTC in the history entry's
     * `data.eventDateTime` and localised at render time by the dashboard — so a
     * timestamp must never be baked into this text (that was the cause of order
     * notes showing UTC instead of the viewer's local time).
     */
    private buildMessage(event: TrackingEventRequest): string {
        switch (event.eventCode) {
            case 'PPICKUP':
            case 'DC0001':
                return 'Collected by DSV';
            case 'PDELLD':
            case 'DE0060':
                return 'Out for delivery';
            case 'PPOD':
            case 'DE0100':
            case 'DE0120':
            case 'PCOD': {
                const receiver = event.parcelReceiver ? ` — signed by ${event.parcelReceiver}` : '';
                return `Delivered${receiver}`;
            }
            case 'PCANCEL':
                return 'Shipment cancelled';
            case 'PDELFD':
            case 'DE0200':
            case 'DE0210': {
                const reason = event.failureReason ? ` — ${event.failureReason}` : '';
                return `Delivery failed${reason}`;
            }
            case 'PDIMSCH': {
                const dims = [event.length, event.width, event.height].map(v => v ?? '?').join('×');
                return `Dimension check — ${dims} m`;
            }
            case 'PWEIGHCH':
                return `Weight check — ${event.weight ?? '?'} kg`;
            case 'SPODI':
            case 'SOWNI':
            case 'SGRVI':
                return event.eventDescription ?? event.eventCode;
            default:
                return `${event.eventCode} — ${event.eventDescription ?? ''}`;
        }
    }

    /**
     * Normalise a DSV event timestamp to canonical UTC (ISO-8601, `…Z`) so it is
     * stored location-independently. DSV sends event times in UTC; when the
     * source string carries no explicit timezone offset it is treated as UTC.
     * Returns `undefined` if the value cannot be parsed as a date.
     */
    private toCanonicalIso(raw?: string): string | undefined {
        if (!raw) return undefined;
        const trimmed = raw.trim();
        const hasZone = /([zZ])|([+-]\d{2}:?\d{2})$/.test(trimmed);
        const date = new Date(hasZone ? trimmed : `${trimmed.replace(' ', 'T')}Z`);
        return isNaN(date.getTime()) ? undefined : date.toISOString();
    }
}
