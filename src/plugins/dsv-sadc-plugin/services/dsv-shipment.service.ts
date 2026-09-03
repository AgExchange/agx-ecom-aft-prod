import { Inject, Injectable, Logger } from '@nestjs/common';
import { DSV_SADC_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import { DsvSadcPluginOptions, DsvSadcShipmentData, DsvSadcSubmitResult } from '../types/plugin-options.types';
import { DsvSoapService } from './dsv-soap.service';
import { buildSubmitShipmentXml } from '../utils/soap-builder';
import { parseSubmitResponse } from '../utils/soap-parser';

@Injectable()
export class DsvSadcShipmentService {
    private readonly logger = new Logger(loggerCtx);

    constructor(
        @Inject(DSV_SADC_PLUGIN_OPTIONS) private readonly options: DsvSadcPluginOptions,
        private readonly soapService: DsvSoapService,
    ) {}

    async submit(data: DsvSadcShipmentData): Promise<DsvSadcSubmitResult> {
        const xml = buildSubmitShipmentXml(this.options, data);
        let rawResponse: string;
        try {
            rawResponse = await this.soapService.post('SubmitShipmentTMS', xml);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`SubmitShipmentTMS failed for order ${data.orderRef}: ${msg}`);
            return { ok: false, parcelIds: [], errorDescription: msg };
        }
        const result = parseSubmitResponse(rawResponse);
        if (!result.ok) {
            this.logger.warn(`SubmitShipmentTMS rejected order ${data.orderRef}: ${result.errorDescription}`);
        } else {
            this.logger.log(`SubmitShipmentTMS accepted order ${data.orderRef} → ${result.shipmentId}`);
        }
        return result;
    }
}
