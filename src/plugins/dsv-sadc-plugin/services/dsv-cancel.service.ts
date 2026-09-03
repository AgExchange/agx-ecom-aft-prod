import { Inject, Injectable, Logger } from '@nestjs/common';
import { DSV_SADC_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { DsvSadcPluginOptions, DsvSadcCancelResult } from '../types/plugin-options.types';
import { DsvSoapService } from './dsv-soap.service';
import { buildCancelXml } from '../utils/soap-builder';
import { parseCancelResponse } from '../utils/soap-parser';

@Injectable()
export class DsvSadcCancelService {
    private readonly logger = new Logger(loggerCtx);

    constructor(
        @Inject(DSV_SADC_PLUGIN_OPTIONS) private readonly options: DsvSadcPluginOptions,
        private readonly soapService: DsvSoapService,
    ) {}

    /**
     * ediReference must match what was sent in SubmitShipmentTMS (e.g. "LAND-<orderCode>-02").
     * It is NOT persisted on the fulfillment — the caller reconstructs it as
     * `${shipperPrefix}-${order.code}-<counter>`, where the counter is the fulfillment's
     * position among the order's DSV fulfillments (see dsvSadcFulfillmentHandler).
     */
    async cancel(ediReference: string): Promise<DsvSadcCancelResult> {
        if (!this.options.features.cancel) {
            return { ok: false, errorMessage: 'Cancel feature is disabled in plugin options' };
        }
        const xml = buildCancelXml(this.options, ediReference);
        let rawResponse: string;
        try {
            rawResponse = await this.soapService.post('SubmitCancelTMS', xml);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`SubmitCancelTMS failed for ${ediReference}: ${msg}`);
            return { ok: false, errorMessage: msg };
        }
        const result = parseCancelResponse(rawResponse);
        if (!result.ok) {
            this.logger.warn(`SubmitCancelTMS rejected ${ediReference}: ${result.errorMessage}`);
        } else {
            this.logger.log(`SubmitCancelTMS accepted ${ediReference}`);
        }
        return result;
    }
}
