import { OrderHistoryEntryData } from '@vendure/core';

/**
 * Custom Order history-entry type for DSV SADC tracking events.
 *
 * We store the DSV event as a *structured* history entry rather than baking a
 * formatted timestamp into note text. The canonical instant is kept in UTC
 * (`eventDateTime`, ISO-8601 with `Z`) so it is location-independent; the
 * dashboard converts it to the viewer's local timezone at render time (see the
 * `dsv-sadc-ui` dashboard extension). This mirrors how Vendure already handles
 * every entry's own `createdAt`: store universal, display local.
 *
 * The matching GraphQL enum member is added in `api/history-api-extensions.ts`,
 * and the render component is registered by the `DsvSadcUiPlugin`.
 */
export const DSV_SADC_TRACKING = 'DSV_SADC_TRACKING';

export interface DsvSadcTrackingData {
    /** Raw DSV event code, e.g. `PPOD`, `DE0100`. */
    eventCode: string;
    /** Human-readable summary with no timestamp, e.g. `Delivered — signed by J. Smith`. */
    message: string;
    /**
     * The DSV event instant, normalised to canonical UTC (ISO-8601, `…Z`).
     * Omitted when the source value could not be parsed as a date.
     */
    eventDateTime?: string;
    /**
     * The original, unparsed DSV timestamp string. Only set when `eventDateTime`
     * could not be derived, so no information is ever lost.
     */
    eventDateTimeRaw?: string;
}

declare module '@vendure/core' {
    interface OrderHistoryEntryData {
        [DSV_SADC_TRACKING]: DsvSadcTrackingData;
    }
}
