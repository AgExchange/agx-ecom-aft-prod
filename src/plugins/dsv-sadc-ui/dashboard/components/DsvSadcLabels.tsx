import { Download } from 'lucide-react';

/**
 * DsvSadcLabels — Order-detail page block.
 *
 * Renders a "Label PDF" download link for each DSV SADC fulfillment on the order.
 * The label is fetched on demand from the backend endpoint (in the
 * `@agxchange/vendure-plugin-dsv-sadc` package) by the fulfillment's `trackingCode`,
 * which is the DSV ClientZone ShipmentId:
 *
 *   GET /shipping/dsv-sadc/label/<trackingCode>?type=pdf
 *
 * The link opens in a new tab and relies on the admin session cookie for auth
 * (the endpoint requires the ReadOrder permission). Labels may not be ready
 * immediately after fulfillment — DSV routes the shipment first — in which case
 * the endpoint responds 502 "not ready, retry shortly".
 */
const DSV_METHOD = 'DSV SADC Road';

/**
 * Base URL for the DSV label endpoint. Defaults to same-origin (root-relative), which is
 * correct when the dashboard and the Vendure API share an origin. Override per deployment
 * — e.g. the API is on a different host or behind a different base path than the dashboard —
 * by setting `VITE_DSV_SADC_LABEL_BASE` in the dashboard build env (build:dashboard). A
 * trailing slash is stripped so the joined URL never doubles up.
 */
const LABEL_BASE = (((import.meta as any).env?.VITE_DSV_SADC_LABEL_BASE as string) ?? '').replace(/\/+$/, '');

interface FulfillmentLike {
    id: string;
    state: string;
    method?: string | null;
    trackingCode?: string | null;
}
interface OrderEntity {
    fulfillments?: FulfillmentLike[] | null;
}

export function DsvSadcLabels({ context }: { context: { entity: OrderEntity } }) {
    const fulfillments = (context.entity?.fulfillments ?? []).filter(
        f =>
            f.method === DSV_METHOD &&
            !!f.trackingCode &&
            !f.trackingCode.startsWith('DSV-ERROR') &&
            !f.trackingCode.startsWith('DSV-SADC-NOT'),
    );

    if (fulfillments.length === 0) {
        return <div className="text-muted-foreground text-sm">No DSV shipments on this order.</div>;
    }

    return (
        <div className="space-y-2">
            {fulfillments.map(f => (
                <div key={f.id} className="flex items-center justify-between gap-2">
                    <span className="text-sm">
                        {f.trackingCode}
                        <span className="text-muted-foreground"> · {f.state}</span>
                    </span>
                    <a
                        href={`${LABEL_BASE}/shipping/dsv-sadc/label/${encodeURIComponent(f.trackingCode as string)}?type=pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
                    >
                        <Download className="h-3.5 w-3.5" /> Label PDF
                    </a>
                </div>
            ))}
        </div>
    );
}
