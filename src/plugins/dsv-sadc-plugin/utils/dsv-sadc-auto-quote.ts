import { Order } from '@vendure/core';

export interface DsvSadcAutoQuoteResult {
    eligible: boolean;
    chargeableKg: number;
    reason?: 'cross-border' | 'over-weight' | 'missing-province';
}

/** Order-level (consignment) chargeable weight — max of actual vs volumetric across all
 *  lines, not per-line — matches how DSV actually invoices a shipment (total actual vs
 *  total volumetric, not item-by-item). Volumetric = L×W×H(cm)/4000, DSV's road-freight
 *  divisor, computed fresh from raw dimensions (not the generically-stored
 *  dimensionVolumetricWeightG field, which has no producer in this repo to verify its
 *  formula/divisor matches DSV's convention). */
function calculateChargeableKg(order: Order): number {
    let actualKg = 0;
    let volumetricKg = 0;
    for (const line of order.lines) {
        const cf = (line as any).productVariant?.customFields ?? {};
        actualKg += line.quantity * ((cf.dimensionWeightG ?? 0) / 1000);
        const lengthCm = (cf.dimensionLengthMm ?? 0) / 10;
        const widthCm = (cf.dimensionWidthMm ?? 0) / 10;
        const heightCm = (cf.dimensionHeightMm ?? 0) / 10;
        volumetricKg += line.quantity * ((lengthCm * widthCm * heightCm) / 4000);
    }
    return Math.max(actualKg, volumetricKg);
}

/** Single source of truth for whether an order can be auto-priced by the DSV SADC flat
 *  rate card (dsv-sadc-rate.calculator.ts), or must fall back to the "DSV SADC — Quote on
 *  Request" companion ShippingMethod (dsv-sadc-poa-eligibility.checker.ts). Both call this
 *  so the two methods can never drift out of sync — one is exactly the inverse of the
 *  other. Never guess a price: cross-border, over-weight, and missing-province all POA. */
export function resolveDsvSadcAutoQuote(order: Order, maxAutoQuoteKg: number): DsvSadcAutoQuoteResult {
    const chargeableKg = calculateChargeableKg(order);

    if (order.shippingAddress?.countryCode !== 'ZA') {
        return { eligible: false, chargeableKg, reason: 'cross-border' };
    }
    if (chargeableKg >= maxAutoQuoteKg) {
        return { eligible: false, chargeableKg, reason: 'over-weight' };
    }
    if (!order.shippingAddress?.province) {
        return { eligible: false, chargeableKg, reason: 'missing-province' };
    }
    return { eligible: true, chargeableKg };
}
