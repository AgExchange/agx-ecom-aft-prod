import { Inject, Injectable } from '@nestjs/common';
import { DSV_SADC_PLUGIN_OPTIONS } from '../constants';
import { DsvSadcPluginOptions } from '../types/plugin-options.types';
import { extractFaultMessage } from '../utils/soap-parser';

export const SOAP_ACTIONS = {
    SubmitShipmentTMS: 'http://tempuri.org/ShipmentWCFService.IDSV_Road_TMS/SubmitShipmentTMS',
    SubmitCancelTMS: 'http://tempuri.org/ShipmentWCFService.IDSV_Road_TMS/SubmitCancelTMS',
    RetrieveShipmentLabelsTMS: 'http://tempuri.org/ShipmentWCFService.IDSV_Road_TMS/RetrieveShipmentLabelsTMS',
    ValidateAddress: 'http://tempuri.org/ShipmentWCFService.IDSV_Road_TMS/ValidateAddress',
} as const;

export type SoapOperation = keyof typeof SOAP_ACTIONS;

@Injectable()
export class DsvSoapService {
    constructor(@Inject(DSV_SADC_PLUGIN_OPTIONS) private readonly options: DsvSadcPluginOptions) {}

    async post(operation: SoapOperation, body: string): Promise<string> {
        const url = this.options.apiUrl;
        const soapAction = SOAP_ACTIONS[operation];

        const headers: Record<string, string> = {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': `"${soapAction}"`,
        };
        // HTTP Basic auth for the DSV HCP API gateway. Omitted for the direct
        // (no-auth) SOAP endpoint when username/password are not configured.
        if (this.options.username && this.options.password) {
            const token = Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64');
            headers['Authorization'] = `Basic ${token}`;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body,
        });

        const text = await response.text();

        if (!response.ok) {
            const fault = extractFaultMessage(text);
            throw new Error(`DSV SADC SOAP ${operation} HTTP ${response.status}: ${fault || text.slice(0, 200)}`);
        }

        const fault = extractFaultMessage(text);
        if (fault) {
            throw new Error(`DSV SADC SOAP fault on ${operation}: ${fault}`);
        }

        return text;
    }
}
