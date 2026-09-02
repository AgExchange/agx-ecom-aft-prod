/**
 * OrderLineMetadataBlock
 *
 * Reads OrderLine customFields directly from context.entity.lines[].customFields.
 * No separate query needed — the order-detail page already calls:
 *   addCustomFields(orderDetailDocument, { includeNestedFragments: ['OrderLine'] })
 * which populates all OrderLine custom fields automatically.
 *
 * Vendure source reference:
 *   packages/dashboard/src/app/routes/_authenticated/_orders/components/order-detail-shared.tsx:80
 */

interface LineCustomFields {
    metadataCategory: string | null;
    machineBrand: string | null;
    machineModel: string | null;
    serialNumber: string | null;
    serialNumberPhotoAssetId: string | null;
    engineApplication: string | null;
    engineNumber: string | null;
    filterAirInner: boolean;
    filterAirOuter: boolean;
    filterFuel: boolean;
    filterHydraulic: boolean;
    filterOil: boolean;
    filterSteering: boolean;
    filterTransmission: boolean;
}

interface OrderLine {
    id: string;
    quantity: number;
    productVariant?: { name?: string; sku?: string };
    customFields?: LineCustomFields;
}

interface OrderEntity {
    lines?: OrderLine[];
}

const FILTER_LABELS: Record<string, string> = {
    filterAirInner:     'Air Inner',
    filterAirOuter:     'Air Outer',
    filterFuel:         'Fuel',
    filterHydraulic:    'Hydraulic',
    filterOil:          'Oil',
    filterSteering:     'Steering',
    filterTransmission: 'Transmission',
};

function getFilterType(cf: LineCustomFields): string {
    for (const [key, label] of Object.entries(FILTER_LABELS)) {
        if (cf[key as keyof LineCustomFields] === true) return label;
    }
    return '—';
}

const CATEGORY_STYLES: Record<string, React.CSSProperties> = {
    axle:   { backgroundColor: '#dbeafe', color: '#1e40af' },
    engine: { backgroundColor: '#fef9c3', color: '#854d0e' },
    filter: { backgroundColor: '#dcfce7', color: '#166534' },
};

function CategoryBadge({ category }: { category: string }) {
    const colourStyle = CATEGORY_STYLES[category] ?? { backgroundColor: '#f3f4f6', color: '#374151' };
    return (
        <span style={{
            display: 'inline-block',
            padding: '1px 7px',
            borderRadius: '9999px',
            fontSize: '10px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            ...colourStyle,
        }}>
            {category}
        </span>
    );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
    if (!value) return null;
    return (
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '4px', marginRight: '16px' }}>
            <span style={{ fontSize: '11px', color: '#9ca3af', whiteSpace: 'nowrap' }}>{label}</span>
            <span style={{ fontSize: '12px', color: '#111827', fontWeight: 600 }}>{value}</span>
        </span>
    );
}

function LineMetadataPanel({ line }: { line: OrderLine }) {
    const cf = line.customFields;
    if (!cf?.metadataCategory) return null;
    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            alignItems: 'start',
            gap: '0 12px',
            padding: '7px 12px',
            borderBottom: '1px solid #f3f4f6',
        }}>
            <div style={{ paddingTop: '2px' }}>
                <CategoryBadge category={cf.metadataCategory} />
            </div>
            <div>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#111827', marginRight: '8px' }}>
                    {line.productVariant?.name ?? ''}
                </span>
                <span style={{ fontSize: '11px', color: '#9ca3af' }}>
                    {line.productVariant?.sku ?? ''}
                </span>
                <div style={{ marginTop: '3px', flexWrap: 'wrap', display: 'flex' }}>
                    <Field label="Brand" value={cf.machineBrand} />
                    <Field label="Model" value={cf.machineModel} />
                    {cf.metadataCategory === 'axle' && (
                        <>
                            <Field label="S/N" value={cf.serialNumber} />
                            <Field label="Photo" value={cf.serialNumberPhotoAssetId
                                ? `Asset:${cf.serialNumberPhotoAssetId}` : null} />
                        </>
                    )}
                    {cf.metadataCategory === 'engine' && (
                        <>
                            <Field label="Application" value={cf.engineApplication} />
                            <Field label="Engine №" value={cf.engineNumber} />
                        </>
                    )}
                    {cf.metadataCategory === 'filter' && (
                        <Field label="Filter" value={getFilterType(cf)} />
                    )}
                </div>
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af', whiteSpace: 'nowrap', paddingTop: '2px' }}>
                ×{line.quantity}
            </div>
        </div>
    );
}

export function OrderLineMetadataBlock({ context }: { context: { entity: OrderEntity } }) {
    const lines = context?.entity?.lines ?? [];
    const metadataLines = lines.filter(l => l.customFields?.metadataCategory);

    if (metadataLines.length === 0) {
        return (
            <div style={{ padding: '8px 12px', color: '#9ca3af', fontSize: '12px' }}>
                No part metadata for this order.
            </div>
        );
    }

    return (
        <div style={{ borderRadius: '6px', overflow: 'hidden', border: '1px solid #e5e7eb' }}>
            {metadataLines.map(line => (
                <LineMetadataPanel key={line.id} line={line} />
            ))}
        </div>
    );
}
