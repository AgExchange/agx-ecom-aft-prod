import { Inject, Injectable, Logger } from '@nestjs/common';
import { DSV_SADC_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { DsvSadcPluginOptions, DsvSadcLabelResult } from '../types/plugin-options.types';
import { DsvSoapService } from './dsv-soap.service';
import { buildRetrieveLabelsXml, buildRetrieveLabelsByRefXml } from '../utils/soap-builder';
import { parseLabelResponse } from '../utils/soap-parser';

export type LabelFormat = 'Parcel Label PDF' | 'Parcel Label ZPL' | 'Parcel Label Data';

@Injectable()
export class DsvSadcLabelService {
    private readonly logger = new Logger(loggerCtx);

    constructor(
        @Inject(DSV_SADC_PLUGIN_OPTIONS) private readonly options: DsvSadcPluginOptions,
        private readonly soapService: DsvSoapService,
    ) {}

    async getByShipmentId(shipmentId: string, format: LabelFormat = 'Parcel Label PDF'): Promise<DsvSadcLabelResult> {
        if (!this.options.features.labels) {
            return { responseCode: '-1', responseMessage: 'Label feature is disabled in plugin options' };
        }
        const xml = buildRetrieveLabelsXml(shipmentId, format);
        return this.fetch(xml, shipmentId);
    }

    async getByPrimaryReference(primaryReference: string, format: LabelFormat = 'Parcel Label PDF'): Promise<DsvSadcLabelResult> {
        if (!this.options.features.labels) {
            return { responseCode: '-1', responseMessage: 'Label feature is disabled in plugin options' };
        }
        const xml = buildRetrieveLabelsByRefXml(primaryReference, this.options.relationNumber, format);
        return this.fetch(xml, primaryReference);
    }

    private async fetch(xml: string, ref: string): Promise<DsvSadcLabelResult> {
        // ResponseCode 300 = "No Labels found" — the TMS routes the shipment before
        // label data becomes available, so DSV advises retrying. Retry policy is
        // configurable and OFF by default (see labelRetry in plugin options).
        const retries = this.options.labelRetry?.retries ?? 0;
        const delayMs = this.options.labelRetry?.delayMs ?? 30 * 60 * 1000;

        for (let attempt = 0; ; attempt++) {
            let rawResponse: string;
            try {
                rawResponse = await this.soapService.post('RetrieveShipmentLabelsTMS', xml);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.error(`RetrieveShipmentLabelsTMS failed for ${ref}: ${msg}`);
                return { responseCode: '-1', responseMessage: msg };
            }
            const result = parseLabelResponse(rawResponse);
            if (result.responseCode !== '300' || attempt >= retries) {
                if (result.responseCode === '300') {
                    this.logger.warn(`Labels not ready for ${ref} (code 300) after ${attempt + 1} attempt(s)`);
                }
                return result;
            }
            this.logger.log(`Labels not ready for ${ref} (code 300) — retry ${attempt + 1}/${retries} in ${delayMs}ms`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}
