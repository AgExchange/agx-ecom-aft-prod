import { Inject, Injectable, Logger } from '@nestjs/common';
import { DSV_SADC_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { DsvSadcPluginOptions, DsvSadcValidAddress } from '../types/plugin-options.types';
import { DsvSoapService } from './dsv-soap.service';
import { buildValidateAddressXml } from '../utils/soap-builder';
import { parseValidateAddressResponse } from '../utils/soap-parser';

@Injectable()
export class DsvSadcAddressService {
    private readonly logger = new Logger(loggerCtx);

    constructor(
        @Inject(DSV_SADC_PLUGIN_OPTIONS) private readonly options: DsvSadcPluginOptions,
        private readonly soapService: DsvSoapService,
    ) {}

    async validate(
        countryCode: string,
        town: string,
        suburb: string,
        postalCode: string,
        noOfResults: number = 3,
    ): Promise<DsvSadcValidAddress[]> {
        const xml = buildValidateAddressXml(countryCode, town, suburb, postalCode, noOfResults);
        let rawResponse: string;
        try {
            rawResponse = await this.soapService.post('ValidateAddress', xml);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`ValidateAddress failed for ${town}/${suburb}/${postalCode}: ${msg}`);
            return [];
        }
        return parseValidateAddressResponse(rawResponse);
    }

    async bestMatch(
        countryCode: string,
        town: string,
        suburb: string,
        postalCode: string,
    ): Promise<DsvSadcValidAddress | null> {
        const results = await this.validate(countryCode, town, suburb, postalCode, 1);
        return results[0] ?? null;
    }

    /** Fallback geo-coordinate source for a delivery address that has no storefront-
     *  captured GPS: DSV's own ValidateAddress already geo-resolves town/suburb/postal
     *  to its nearest known location (confirmed by production behaviour — DSV prints
     *  the resolved suburb, not necessarily what we sent, on the shipping label), so
     *  its top match's lat/long is trusted as-is with no extra client-side scoring. */
    async lookupCoordinates(
        countryCode: string,
        town: string,
        suburb: string,
        postalCode: string,
    ): Promise<{ xCoordinate: string; yCoordinate: string } | null> {
        const match = await this.bestMatch(countryCode, town, suburb, postalCode);
        if (!match?.longitude || !match?.latitude) return null;
        return { xCoordinate: match.longitude, yCoordinate: match.latitude };
    }
}
