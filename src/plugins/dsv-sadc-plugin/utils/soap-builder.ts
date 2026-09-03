import { DsvSadcPluginOptions, DsvSadcShipmentData, DsvSadcAddress } from '../types/plugin-options.types';

const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const SHIPMENT_NS = 'http://tms-lsp.blujaysolutions.net/api/shipment';
const STATUS_NS = 'http://tms-lsp.blujaysolutions.net/api/status';
const TEMPURI_NS = 'http://tempuri.org/';

function esc(value: string | undefined | null): string {
    if (!value) return '';
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function isoDateTime(): string {
    const d = new Date();
    const offset = -d.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const absOffset = Math.abs(offset);
    const hh = String(Math.floor(absOffset / 60)).padStart(2, '0');
    const mm = String(absOffset % 60).padStart(2, '0');
    return d.toISOString().slice(0, 19) + `${sign}${hh}:${mm}`;
}

function buildAddressBlock(addr: DsvSadcAddress, addressType: number): string {
    // DSV's own sample requests (docs/XML Request *.xml, docs/Request Single Parcel
    // Cross Border.xml) ALWAYS emit searchName/addressLine2/addressLine3/cityName2 as
    // empty tags when unused — e.g. `<ship:addressLine3></ship:addressLine3>` — on
    // every address, including delivery. They are NEVER omitted. Omitting the element
    // entirely (as this used to do) makes DSV's WCF deserializer default the field to
    // the literal string "UNKNOWN" on the printed label instead of leaving it blank —
    // the cause of a persistent "UNKNOWN" line on labels regardless of what address
    // data was actually submitted.
    const searchName = `<searchName>${esc(addr.searchName)}</searchName>`;
    const addrLine2 = `<addressLine2>${esc(addr.addressLine2)}</addressLine2>`;
    const addrLine3 = `<addressLine3>${esc(addr.addressLine3)}</addressLine3>`;
    const cityName2 = `<cityName2>${esc(addr.cityName2)}</cityName2>`;
    const contactPerson = addr.contactPerson ? `<contactPerson>${esc(addr.contactPerson)}</contactPerson>` : '';
    const email = addr.email ? `<e-mailAddress>${esc(addr.email)}</e-mailAddress>` : '';
    const coords = (addr.xCoordinate && addr.yCoordinate)
        ? `<coordinates type="tag"><xCoordinate>${esc(addr.xCoordinate)}</xCoordinate><yCoordinate>${esc(addr.yCoordinate)}</yCoordinate></coordinates>`
        : '';

    return `<address type="tag">
          <addressType>${addressType}</addressType>
          ${searchName}
          <addressDetails>
            <nameLine1>${esc(addr.nameLine1)}</nameLine1>
            <addressLine1>${esc(addr.addressLine1)}</addressLine1>
            ${addrLine2}
            ${addrLine3}
            <cityName>${esc(addr.cityName)}</cityName>
            ${cityName2}
            <postalCode>${esc(addr.postalCode)}</postalCode>
            <countryCode>${esc(addr.countryCode)}</countryCode>
          </addressDetails>
          <contactInformation>
            <languageCode>02</languageCode>
            ${email}
            ${contactPerson}
            <telephoneNumber>${esc(addr.telephoneNumber)}</telephoneNumber>
          </contactInformation>
          ${coords}
        </address>`;
}

export function buildSubmitShipmentXml(opts: DsvSadcPluginOptions, data: DsvSadcShipmentData): string {
    const crossBorder = data.destinationCountry !== 'ZA';
    const ediParm2 = crossBorder ? 'x' : 's';
    const ediReference = `${opts.shipperPrefix}-${data.orderRef}-${data.counter}`;
    const dateTimeZone = isoDateTime();
    const deliveryPostalCode = crossBorder && !data.deliveryAddress.postalCode ? '0000' : data.deliveryAddress.postalCode;

    const billingAddress = `<address type="tag"><addressType>0</addressType><relationNumber>${esc(opts.relationNumber)}</relationNumber></address>`;

    const loadingAddr = { ...data.loadingAddress, searchName: opts.warehouseSearchName };
    const loadingAddress = buildAddressBlock(loadingAddr, 1);

    const deliveryAddrObj = { ...data.deliveryAddress, postalCode: deliveryPostalCode };
    const unloadingAddress = buildAddressBlock(deliveryAddrObj, 3);
    const consigneeAddress = buildAddressBlock(deliveryAddrObj, 4);

    const extraRefs: string[] = [];
    extraRefs.push(`<extraReference type="tag"><referenceCode>1</referenceCode><referenceText>Order ${esc(data.orderRef)}</referenceText></extraReference>`);
    if (data.customerPhone) {
        extraRefs.push(`<extraReference type="tag"><referenceCode>5</referenceCode><referenceText>${esc(data.customerPhone)}</referenceText></extraReference>`);
    }
    if (data.customerEmail) {
        extraRefs.push(`<extraReference type="tag"><referenceCode>6</referenceCode><referenceText>${esc(data.customerEmail)}</referenceText></extraReference>`);
    }

    const instructions = data.deliveryInstructions
        ? `<transportInstruction type="tag"><carriageCondition>0</carriageCondition><description>${esc(data.deliveryInstructions)}</description></transportInstruction>`
        : '';

    // Insurance flags are independent (per DSV field spec):
    //   parameterYn15 — specific insurance   → amount1
    //   parameterYn16 — incidental liability → amount2
    //   parameterYn17 — apply DSV default insurance
    let yn15 = 'false', yn16 = 'false', yn17 = 'false';
    const amountLines: string[] = [];
    if (data.declaredInsuranceValue != null && data.declaredInsuranceValue > 0) {
        yn15 = 'true';
        amountLines.push(`<amount1>${data.declaredInsuranceValue}</amount1>`);
    }
    if (data.declaredIncidentalValue != null && data.declaredIncidentalValue > 0) {
        yn16 = 'true';
        amountLines.push(`<amount2>${data.declaredIncidentalValue}</amount2>`);
    }
    if (data.includeDefaultInsurance) {
        yn17 = 'true';
    }
    const amounts = amountLines.length ? `<amounts>${amountLines.join('')}</amounts>` : '';

    const goodsLines = data.parcels.map(p => `<goodsLine type="tag">
          <primaryReference>${esc(p.parcelRef)}</primaryReference>
          <quantity>1</quantity>
          <packageCode>pc</packageCode>
          <grossWeight>${p.weightKg.toFixed(3)}</grossWeight>
          <cubicMeters>${p.cubicM.toFixed(3)}</cubicMeters>
          <quantityOfShippingUnits>1</quantityOfShippingUnits>
          <packageCodeOfShippingUnits>pc</packageCodeOfShippingUnits>
          <shippingUnit type="tag">
            <externalUnit>${esc(p.parcelRef)}</externalUnit>
            <dimension>
              <length>${p.lengthM.toFixed(3)}</length>
              <width>${p.widthM.toFixed(3)}</width>
              <height>${p.heightM.toFixed(3)}</height>
            </dimension>
            <shippingUnitDetails type="tag">
              <quantity>1</quantity>
              <packageCode>pc</packageCode>
              <grossWeight>${p.weightKg.toFixed(3)}</grossWeight>
              <cubicMeters>${p.cubicM.toFixed(3)}</cubicMeters>
            </shippingUnitDetails>
          </shippingUnit>
        </goodsLine>`).join('\n        ');

    return `<soapenv:Envelope xmlns:soapenv="${SOAP_NS}" xmlns:tem="${TEMPURI_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:SubmitShipmentTMS>
    <tem:shipment xmlns="${SHIPMENT_NS}" type="tag">
      <ediCustomerNumber>${esc(opts.ediCustomerNumber)}</ediCustomerNumber>
      <ediCustomerDepartment>${esc(opts.ediCustomerDepartment)}</ediCustomerDepartment>
      <ediParm1>4</ediParm1>
      <ediParm2>${ediParm2}</ediParm2>
      <transmitter>CU</transmitter>
      <receiver>BPPZA</receiver>
      <ediReference>${esc(ediReference)}</ediReference>
      <referenceIndication>0</referenceIndication>
      <ediFunction1>9</ediFunction1>
      <ediCustomerSearchName>${esc(opts.relationNumber)}</ediCustomerSearchName>
      <dateTimeZone>${dateTimeZone}</dateTimeZone>
      <file type="tag">
        <loadingDate>${esc(data.loadingDate)}</loadingDate>
        <loadingTime>${esc(data.loadingTime)}</loadingTime>
        <primaryReference>${esc(data.orderRef)}</primaryReference>
        <serviceLevel>${esc(data.serviceLevel)}</serviceLevel>
        <customItems>
          <countryOfOrigin>ZA</countryOfOrigin>
          <countryOfDespatch>ZA</countryOfDespatch>
          <countryOfDestination>${esc(data.destinationCountry)}</countryOfDestination>
        </customItems>
        ${amounts}
        <parameters>
          <parameterYn09>false</parameterYn09>
          <parameterYn10>false</parameterYn10>
        </parameters>
        <extraParameters>
          <parameterYn12>false</parameterYn12>
          <parameterYn13>false</parameterYn13>
          <parameterYn14>false</parameterYn14>
          <parameterYn15>${yn15}</parameterYn15>
          <parameterYn16>${yn16}</parameterYn16>
          <parameterYn17>${yn17}</parameterYn17>
        </extraParameters>
        ${billingAddress}
        ${loadingAddress}
        ${unloadingAddress}
        ${consigneeAddress}
        ${extraRefs.join('\n        ')}
        ${instructions}
        ${goodsLines}
      </file>
    </tem:shipment>
    </tem:SubmitShipmentTMS>
  </soapenv:Body>
</soapenv:Envelope>`;
}

export function buildCancelXml(opts: DsvSadcPluginOptions, ediReference: string): string {
    const dateTimeZone = isoDateTime();
    return `<soapenv:Envelope xmlns:soapenv="${SOAP_NS}" xmlns:tem="${TEMPURI_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:SubmitCancelTMS>
    <tem:cancel xmlns="${STATUS_NS}" type="tag">
      <ediCustomerNumber>${esc(opts.ediCustomerNumber)}</ediCustomerNumber>
      <ediCustomerDepartment>${esc(opts.ediCustomerDepartment)}</ediCustomerDepartment>
      <ediParm1>4</ediParm1>
      <transmitter>CZ</transmitter>
      <receiver>BPPZA</receiver>
      <ediReference>${esc(ediReference)}</ediReference>
      <referenceIndication>0</referenceIndication>
      <ediFunction1>2</ediFunction1>
      <ediCustomerSearchName>${esc(opts.relationNumber)}</ediCustomerSearchName>
      <dateTimeZone>${dateTimeZone}</dateTimeZone>
      <fileHeader type="tag">
        <trackingAndTracing type="tag">
          <dateTimeZone>${dateTimeZone}</dateTimeZone>
          <code>SCANCEL</code>
        </trackingAndTracing>
      </fileHeader>
    </tem:cancel>
    </tem:SubmitCancelTMS>
  </soapenv:Body>
</soapenv:Envelope>`;
}

export function buildRetrieveLabelsXml(shipmentId: string, labelType: string = 'Parcel Label PDF'): string {
    return `<soapenv:Envelope xmlns:soapenv="${SOAP_NS}" xmlns:tem="${TEMPURI_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:RetrieveShipmentLabelsTMS>
      <tem:labelRequest>
        <tem:Shipment>${esc(shipmentId)}</tem:Shipment>
        <tem:LabelType>${esc(labelType)}</tem:LabelType>
      </tem:labelRequest>
    </tem:RetrieveShipmentLabelsTMS>
  </soapenv:Body>
</soapenv:Envelope>`;
}

export function buildRetrieveLabelsByRefXml(primaryReference: string, relationNumber: string, labelType: string = 'Parcel Label PDF'): string {
    return `<soapenv:Envelope xmlns:soapenv="${SOAP_NS}" xmlns:tem="${TEMPURI_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:RetrieveShipmentLabelsTMS>
      <tem:labelRequest>
        <tem:PrimaryReference>${esc(primaryReference)}</tem:PrimaryReference>
        <tem:RelationNumber>${esc(relationNumber)}</tem:RelationNumber>
        <tem:LabelType>${esc(labelType)}</tem:LabelType>
      </tem:labelRequest>
    </tem:RetrieveShipmentLabelsTMS>
  </soapenv:Body>
</soapenv:Envelope>`;
}

export function buildValidateAddressXml(countryCode: string, town: string, suburb: string, postalCode: string, noOfResults: number = 3): string {
    return `<soapenv:Envelope xmlns:soapenv="${SOAP_NS}" xmlns:tem="${TEMPURI_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:ValidateAddress>
      <tem:validateAddressRequest>
        <tem:CountryCode>${esc(countryCode)}</tem:CountryCode>
        <tem:Town>${esc(town)}</tem:Town>
        <tem:Suburb>${esc(suburb)}</tem:Suburb>
        <tem:PostalCode>${esc(postalCode)}</tem:PostalCode>
        <tem:NoOfReturnAddresses>${noOfResults}</tem:NoOfReturnAddresses>
      </tem:validateAddressRequest>
    </tem:ValidateAddress>
  </soapenv:Body>
</soapenv:Envelope>`;
}
