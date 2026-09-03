import { HistoryEntry, useLocalFormat } from '@vendure/dashboard';
import { Truck } from 'lucide-react';

/**
 * Renders a `DSV_SADC_TRACKING` order-history entry.
 *
 * The DSV event instant is stored as canonical UTC in `entry.data.eventDateTime`
 * (ISO-8601, `…Z`). Here we localise it to the *viewer's* timezone via
 * `useLocalFormat().formatDate`, exactly as Vendure renders the entry's own
 * `createdAt`. This is the display-layer conversion that replaces the previous
 * approach of baking a fixed-timezone timestamp into the note text.
 *
 * The `data` shape mirrors `DsvSadcTrackingData` in the
 * `@agxchange/vendure-plugin-dsv-sadc` backend package. We intentionally do NOT
 * import from that package: it is server-side (CommonJS, depends on
 * `@vendure/core`) and must never be pulled into the browser bundle. The `type`
 * string below must stay in sync with its `DSV_SADC_TRACKING` constant.
 */
interface DsvSadcTrackingData {
    eventCode: string;
    message: string;
    eventDateTime?: string;
    eventDateTimeRaw?: string;
}

export function DsvSadcTrackingEntry({ entry }: { entry: { id: string; data: DsvSadcTrackingData } }) {
    const { formatDate } = useLocalFormat();
    const data = entry.data;

    const localTime = data.eventDateTime
        ? formatDate(data.eventDateTime, {
              year: 'numeric',
              month: 'short',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
          })
        : data.eventDateTimeRaw;

    return (
        <HistoryEntry
            entry={entry as any}
            title={data.message}
            actorName="DSV SADC"
            timelineIcon={<Truck />}
            timelineIconClassName="bg-primary text-primary-foreground"
        >
            {localTime ? <div className="text-xs text-muted-foreground">Event time: {localTime}</div> : null}
        </HistoryEntry>
    );
}
