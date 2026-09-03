import {
    FulfillmentHandler, LanguageCode, Injector, TransactionalConnection, OrderLine, Logger,
    OrderService, RequestContext, Order, Fulfillment,
} from '@vendure/core';
import { In } from 'typeorm';
import { loggerCtx } from '../constants';
import { DsvSadcShipmentData } from '../types/plugin-options.types';
import { DsvSadcShipmentService } from '../services/dsv-shipment.service';
import { DsvSadcCancelService } from '../services/dsv-cancel.service';
import { DsvSadcAddressService } from '../services/dsv-address.service';
import { DsvSadcPluginOptions } from '../types/plugin-options.types';
import { DSV_SADC_PLUGIN_OPTIONS } from '../constants';
import {
    vendureAddressToDsv,
    mmToMetres,
    gToKg,
    buildParcelRef,
    addBusinessDays,
    toDsvCountryCode,
} from '../utils/address-converter';

const HANDLER_CODE = 'dsv-sadc-fulfillment';

let shipmentService: DsvSadcShipmentService;
let cancelService: DsvSadcCancelService;
let addressService: DsvSadcAddressService;
let orderService: OrderService;
let connection: TransactionalConnection;
let pluginOptions: DsvSadcPluginOptions;

/**
 * DSV fulfillments for an order (created by THIS handler), oldest first (by id).
 * Includes cancelled and failed ones — the ediReference counter must advance for every
 * submission occurrence, per the DSV spec.
 */
async function dsvFulfillmentsForOrder(ctx: RequestContext, order: Order): Promise<Fulfillment[]> {
    const all = await orderService.getOrderFulfillments(ctx, order);
    return all
        .filter(f => f.handlerCode === HANDLER_CODE)
        .sort((a, b) => Number(a.id) - Number(b.id));
}

export const dsvSadcFulfillmentHandler = new FulfillmentHandler({
    code: HANDLER_CODE,
    description: [
        { languageCode: LanguageCode.en, value: 'Create DSV ClientZone SADC shipment via SOAP/XML' },
    ],

    args: {
        // `required: false` is essential: the create-fulfillment dialog's confirm button
        // is disabled unless every handler arg validates, and an unset `required` treats a
        // string arg as required — so the empty `serviceLevel` default would block the
        // button. The core manualFulfillmentHandler sets `required: false` for the same reason.
        serviceLevel: {
            type: 'string',
            required: false,
            defaultValue: '',
            label: [{ languageCode: LanguageCode.en, value: 'Service level override' }],
            description: [{ languageCode: LanguageCode.en, value: 'Leave blank to use plugin default (eco). Options: eco, exp, sdy, ret' }],
        },
        includeDefaultInsurance: {
            type: 'string',
            required: false,
            defaultValue: 'false',
            label: [{ languageCode: LanguageCode.en, value: 'Include default DSV insurance' }],
            description: [{ languageCode: LanguageCode.en, value: '"true" = parameterYn17=true (DSV default insurance, chargeable). Landboupart default is "false".' }],
        },
    },

    init(injector: Injector) {
        shipmentService = injector.get(DsvSadcShipmentService);
        cancelService = injector.get(DsvSadcCancelService);
        addressService = injector.get(DsvSadcAddressService);
        orderService = injector.get(OrderService);
        connection = injector.get(TransactionalConnection);
        pluginOptions = injector.get<DsvSadcPluginOptions>(DSV_SADC_PLUGIN_OPTIONS as any);
        // TEMP DIAGNOSTIC — confirms the handler is wired at bootstrap
        Logger.info(`[fulfillment] handler init — configured=${!!pluginOptions}`, loggerCtx);
    },

    createFulfillment: async (ctx, orders, lines, args) => {
        // TEMP DIAGNOSTIC — remove after commissioning. If you never see this line when
        // clicking "Fulfill", the handler is not being invoked (the disabled button is a
        // dashboard/order-state condition, upstream of this code).
        Logger.info(
            `[fulfillment] createFulfillment CALLED — orders=[${orders.map(o => `${o.code}:${o.state}`).join(',')}] ` +
            `lines=${lines.length} args=${JSON.stringify(args)} configured=${!!pluginOptions}`,
            loggerCtx,
        );
        if (!pluginOptions) {
            Logger.warn('[fulfillment] pluginOptions missing — returning NOT-CONFIGURED', loggerCtx);
            return { trackingCode: 'DSV-SADC-NOT-CONFIGURED', method: 'DSV SADC Road' };
        }

        const order = orders[0];
        const shippingAddr = order.shippingAddress;
        const destCountry = toDsvCountryCode(shippingAddr?.countryCode) ?? 'ZA';
        const crossBorder = destCountry !== 'ZA';

        const deliveryAddress = await vendureAddressToDsv(shippingAddr, crossBorder, addressService);
        // DSV requires the full physical loading address on the type-1 block, not
        // just the searchName. Prefer the configured depot address; fall back to a
        // minimal block keyed on the searchName if none is configured.
        const loadingAddress = {
            ...(pluginOptions.loadingAddress ?? {
                nameLine1: pluginOptions.warehouseSearchName,
                addressLine1: '',
                cityName: '',
                postalCode: '',
                countryCode: 'ZA',
                telephoneNumber: '0000000000',
            }),
            searchName: pluginOptions.warehouseSearchName,
        };

        // Load order lines with variant details
        const orderLineIds = lines.map(l => l.orderLineId);
        const orderLines = await connection.getRepository(ctx, OrderLine).find({
            // `as any`: FindOperator brand clash between the plugin's `typeorm` copy
            // and the one bundled in `@vendure/core` (OrderLine). Runtime is unaffected.
            where: { id: In(orderLineIds) as any },
            relations: { productVariant: true },
        });

        const lineQuantityMap = new Map(lines.map(l => [String(l.orderLineId), l.quantity]));

        let index = 1;
        const parcels = orderLines.map(ol => {
            const qty = lineQuantityMap.get(String(ol.id)) ?? 1;
            const cf = (ol as any).productVariant?.customFields ?? {};
            const billableWeightG = Math.max(cf.dimensionWeightG ?? 0, cf.dimensionVolumetricWeightG ?? 0);
            const lengthM = mmToMetres(cf.dimensionLengthMm);
            const widthM = mmToMetres(cf.dimensionWidthMm);
            const heightM = mmToMetres(cf.dimensionHeightMm);
            // cubicMeters is a REQUIRED DSV field. Prefer the geometric volume; if
            // dimensions are absent, derive from the pre-calculated volumetric weight
            // (g / 200,000 = m³, the inverse of the volumetric-weight formula).
            let cubicM = lengthM * widthM * heightM;
            if (cubicM <= 0 && (cf.dimensionVolumetricWeightG ?? 0) > 0) {
                cubicM = cf.dimensionVolumetricWeightG / 200000;
            }
            if (cubicM <= 0) cubicM = 0.001;
            const parcel = {
                parcelRef: buildParcelRef(order.code, index),
                weightKg: gToKg(billableWeightG) * qty,
                lengthM,
                widthM,
                heightM,
                cubicM,
            };
            index++;
            return parcel;
        });

        const serviceLevel = (args.serviceLevel?.trim() || pluginOptions.defaults.serviceLevel) as any;
        const includeDefaultInsurance = args.includeDefaultInsurance !== 'false';
        const loadingDate = addBusinessDays(new Date(), pluginOptions.defaults.loadingDaysFromNow ?? 1);
        const loadingTime = pluginOptions.defaults.loadingTime ?? '08:00:00';

        const customer = order.customer;
        const customerPhone = customer?.phoneNumber || shippingAddr?.phoneNumber || undefined;
        const customerEmail = customer?.emailAddress || undefined;

        // Sequence the ediReference counter: DSV rejects a re-used reference
        // ("Message reference […-01] already exists"), so each submission for the same order
        // must advance (…-01, …-02, …). Count existing DSV fulfillments (incl. cancelled and
        // failed attempts) on this order and use count+1 — the new fulfillment isn't persisted
        // yet, so it is not included here.
        const priorDsv = await dsvFulfillmentsForOrder(ctx, order);
        const counter = String(priorDsv.length + 1).padStart(2, '0');
        Logger.info(`[fulfillment] ediReference counter=${counter} (prior DSV fulfillments=${priorDsv.length}) for order ${order.code}`, loggerCtx);

        const data: DsvSadcShipmentData = {
            orderRef: order.code,
            counter,
            serviceLevel,
            loadingDate,
            loadingTime,
            loadingAddress,
            deliveryAddress,
            parcels,
            destinationCountry: destCountry,
            customerPhone,
            customerEmail,
            includeDefaultInsurance,
        };

        // TEMP DIAGNOSTIC
        Logger.info(
            `[fulfillment] submitting — order=${order.code} dest=${destCountry} serviceLevel=${serviceLevel} ` +
            `parcels=${parcels.length} totalKg=${parcels.reduce((s, p) => s + p.weightKg, 0).toFixed(3)}`,
            loggerCtx,
        );
        const result = await shipmentService.submit(data);
        Logger.info(`[fulfillment] submit result — ok=${result.ok} shipmentId=${result.shipmentId ?? ''} err=${result.errorDescription ?? ''}`, loggerCtx);

        if (!result.ok) {
            return {
                trackingCode: `DSV-ERROR-${result.errorDescription?.slice(0, 30) ?? 'UNKNOWN'}`,
                method: 'DSV SADC Road',
            };
        }

        // The ClientZone ShipmentId is the fulfillment's tracking reference (matches the
        // DSV Europe plugin — no Fulfillment custom fields). The ediReference used here is
        // `${shipperPrefix}-${order.code}-${counter}` and is reconstructed at cancel time from
        // the fulfillment's position among the order's DSV fulfillments, so it needs no persisting.
        return {
            trackingCode: result.shipmentId ?? '',
            method: 'DSV SADC Road',
        };
    },

    // Fires ONLY for fulfillments this handler created. When the admin cancels the
    // fulfillment, relay the cancellation to DSV (SubmitCancelTMS). Returning a string
    // aborts the Vendure state transition — so if DSV refuses the cancel (e.g. the
    // shipment was already collected), the Vendure fulfillment stays uncancelled and the
    // admin sees why.
    onFulfillmentTransition: async (fromState, toState, { ctx, orders, fulfillment }) => {
        // TEMP DIAGNOSTIC — logs EVERY transition of a DSV fulfillment (fires only for
        // DSV-created fulfillments). Useful to watch cancel/ship/deliver during e2e.
        Logger.info(
            `[fulfillment-transition] order=${orders[0]?.code ?? '?'} fulfillment=${fulfillment.id} ` +
            `${fromState} → ${toState} trackingCode=${fulfillment.trackingCode ?? ''}`,
            loggerCtx,
        );

        if (toState !== 'Cancelled' || fromState === 'Cancelled') return;
        if (!pluginOptions?.features.cancel) return; // cancel integration off → don't block

        // Skip if no real DSV shipment was registered (submit failed → placeholder code).
        const tracking = fulfillment.trackingCode ?? '';
        if (!tracking || tracking.startsWith('DSV-ERROR') || tracking.startsWith('DSV-SADC-NOT')) {
            Logger.info(`[fulfillment] cancel — no DSV shipment to cancel (trackingCode="${tracking}")`, loggerCtx);
            return;
        }

        const order = orders[0];
        if (!order) return;
        // Reconstruct the SAME ediReference this fulfillment was submitted with: its counter is
        // its 1-based position among the order's DSV fulfillments (ordered by id), matching the
        // count-based counter used at submission time.
        const dsvFuls = await dsvFulfillmentsForOrder(ctx, order);
        const idx = dsvFuls.findIndex(f => String(f.id) === String(fulfillment.id));
        const counter = String((idx >= 0 ? idx : 0) + 1).padStart(2, '0');
        const ediRef = `${pluginOptions.shipperPrefix}-${order.code}-${counter}`;
        const result = await cancelService.cancel(ediRef);
        if (!result.ok) {
            const msg = `DSV SADC cancel refused for ${ediRef}: ${result.errorMessage ?? 'unknown error'}`;
            Logger.warn(`[fulfillment] ${msg}`, loggerCtx);
            return msg; // abort the Vendure cancel
        }
        Logger.info(`[fulfillment] DSV shipment cancelled — ${ediRef} (shipment ${tracking})`, loggerCtx);
    },
});
