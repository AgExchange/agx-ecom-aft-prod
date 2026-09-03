import {
    DsvSadcSubmitResult,
    DsvSadcCancelResult,
    DsvSadcLabelResult,
    DsvSadcValidAddress,
} from '../types/plugin-options.types';

// The `(?=[\\s/>])` lookahead pins the tag name to a word boundary so that e.g.
// extractTag('Label') does not match <LabelType>/<LabelCreated>, and
// extractTag('Shipment') does not match <ShipmentServiceResultTMS>.
function extractTag(xml: string, tag: string): string | undefined {
    const re = new RegExp(`<(?:[^:>]+:)?${tag}(?=[\\s/>])[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'i');
    const m = xml.match(re);
    return m ? m[1].trim() : undefined;
}

function extractAllTags(xml: string, tag: string): string[] {
    const re = new RegExp(`<(?:[^:>]+:)?${tag}(?=[\\s/>])[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'gi');
    const results: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        results.push(m[1].trim());
    }
    return results;
}

function parseBool(val: string | undefined): boolean {
    return val?.toLowerCase() === 'true';
}

/** Decode the five predefined XML entities. `&amp;` is decoded last so that an
 *  escaped entity like `&amp;lt;` resolves to `&lt;` rather than `<`. */
function decodeXmlEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/** Returns the <errorDescription> of the first <logging> block whose <errorCode> matches. */
function loggingDescriptionForCode(xml: string, code: string): string | undefined {
    for (const block of extractAllTags(xml, 'logging')) {
        if (extractTag(block, 'errorCode') === code) {
            return extractTag(block, 'errorDescription');
        }
    }
    return undefined;
}

/**
 * Parse a SubmitShipmentTMS response.
 *
 * IMPORTANT: the top-level <Status> is `true` for BOTH successful AND refused
 * (duplicate) shipments, so it cannot be used to decide success. DSV signals the
 * real outcome through the <logging><errorCode> sequence:
 *   - a technical error returns a <ServiceMessage>/<ErrorText> with no <TMSResponse>;
 *   - code 84 anywhere  → refused (duplicate) — shipment NOT created;
 *   - final code 0      → "message rightly processed" (created);
 *   - code 9410 present → accepted without warnings; 9460 → accepted with warnings.
 * The ClientZone ShipmentId is <internalNumber>; parcel IDs are <shippingUnitNumber>.
 */
export function parseSubmitResponse(xml: string): DsvSadcSubmitResult {
    const hasTmsResponse = /<[^>]*TMSResponse[\s>]/i.test(xml);

    // Response Definition 2 — technical error (ServiceMessage, no TMSResponse).
    if (!hasTmsResponse) {
        const errorDescription =
            extractTag(xml, 'ErrorText') ||
            extractTag(xml, 'ErrorMessage') ||
            extractTag(xml, 'errorDescription') ||
            'DSV SADC submit failed (technical error)';
        return { ok: false, parcelIds: [], errorDescription };
    }

    const loggingCodes = extractAllTags(xml, 'errorCode');

    // Refused / duplicate — code 84 present. Shipment not created.
    if (loggingCodes.includes('84')) {
        const errorDescription =
            loggingDescriptionForCode(xml, '84') || 'Duplicate shipment — already exists (refused)';
        return { ok: false, parcelIds: [], errorDescription };
    }

    const shipmentId = extractTag(xml, 'internalNumber') || extractTag(xml, 'ShipmentId');
    const lastCode = loggingCodes.length ? loggingCodes[loggingCodes.length - 1] : undefined;

    if (shipmentId && lastCode === '0') {
        const parcelIds = extractAllTags(xml, 'shippingUnitNumber');
        const acceptedWithWarnings = loggingCodes.includes('9460');
        const warnings = acceptedWithWarnings
            ? extractAllTags(xml, 'logging')
                  .filter(b => {
                      const c = extractTag(b, 'errorCode');
                      return c && c !== '0' && c !== '9410' && c !== '9460';
                  })
                  .map(b => extractTag(b, 'errorDescription') ?? '')
                  .filter(Boolean)
            : undefined;
        return { ok: true, shipmentId, parcelIds, acceptedWithWarnings, warnings };
    }

    // Anything else — surface the last logging description as the failure reason.
    const errorDescription =
        extractTag(xml, 'ErrorMessage') ||
        (lastCode ? loggingDescriptionForCode(xml, lastCode) : undefined) ||
        `Unexpected DSV response (logging codes: ${loggingCodes.join(',') || 'none'})`;
    return { ok: false, parcelIds: [], errorDescription };
}

export function parseCancelResponse(xml: string): DsvSadcCancelResult {
    const ok = parseBool(extractTag(xml, 'Status'));
    if (!ok) {
        const errorMessage = extractTag(xml, 'errorDescription') || extractTag(xml, 'ErrorDescription');
        return { ok: false, errorMessage };
    }
    return { ok: true };
}

export function parseLabelResponse(xml: string): DsvSadcLabelResult {
    const responseCode = extractTag(xml, 'ResponseCode') ?? '-1';
    const responseMessage = extractTag(xml, 'ResponseMessage');

    // The <Label> element carries an inner <CZ_DocumentMessage>. For PDF/ZPL the
    // printable payload is the <Binary> element inside it; for "Parcel Label Data"
    // the whole message IS the label data.
    //
    // DSV's HCP gateway does NOT wrap the inner message in CDATA — it XML-escapes
    // it, so <Binary> arrives on the wire as `&lt;Binary&gt;…&lt;/Binary&gt;`.
    // We therefore strip a CDATA wrapper IF present (older/direct endpoints) AND
    // decode XML entities, so the subsequent <Binary> extraction works for both
    // shapes. Without the un-escape the extraction falls through to the whole
    // CZ_DocumentMessage, and base64-decoding that yields a corrupt (unopenable)
    // PDF — the label-won't-open bug.
    let labelData = extractTag(xml, 'Label');
    if (labelData) {
        labelData = labelData
            .replace(/^<!\[CDATA\[/, '')
            .replace(/\]\]>$/, '')
            .trim();
        labelData = decodeXmlEntities(labelData);
    }
    const binaryLabel =
        extractTag(xml, 'BinaryLabel') ||
        (labelData ? extractTag(labelData, 'Binary') ?? labelData : undefined);

    return { responseCode, responseMessage, binaryLabel };
}

export function parseValidateAddressResponse(xml: string): DsvSadcValidAddress[] {
    const addressBlocks = extractAllTags(xml, 'ValidAddress');
    if (!addressBlocks.length) {
        const resultBlock = extractTag(xml, 'ValidateAddressResult');
        if (!resultBlock) return [];
        addressBlocks.push(resultBlock);
    }
    return addressBlocks.map(block => ({
        country: extractTag(block, 'Country'),
        countryCode: extractTag(block, 'CountryCode'),
        province: extractTag(block, 'Province'),
        town: extractTag(block, 'Town'),
        suburb: extractTag(block, 'Suburb'),
        postalCode: extractTag(block, 'PostalCode'),
        latitude: extractTag(block, 'Latitude'),
        longitude: extractTag(block, 'Longitude'),
    }));
}

export function extractFaultMessage(xml: string): string | undefined {
    return extractTag(xml, 'faultstring') || extractTag(xml, 'Fault');
}
