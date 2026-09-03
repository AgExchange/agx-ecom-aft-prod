import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { DpoPluginOptions } from '../config/dpo-plugin-options';
import { formatServiceDate } from './dpo-date';
import { DpoApiEnvelope, normalizeEnvelope } from './dpo-envelope';
import {
  DpoCreateTokenResponse,
  DpoRefundTokenResponse,
  DpoSimpleResponse,
  DpoVerifyTokenV7Response,
} from './dpo-xml-types';

const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8"?>\n';
const DEFAULT_API_URL_V6 = 'https://secure.3gdirectpay.com/API/v6/';
const DEFAULT_API_URL_V7 = 'https://secure.3gdirectpay.com/API/v7/';
const DEFAULT_HOSTED_PAYMENT_BASE_URL = 'https://secure.3gdirectpay.com/payv3.php';

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value);
  return s.length > 0 ? s : undefined;
}

function num(value: unknown): number | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  const n = parseFloat(s);
  return Number.isNaN(n) ? undefined : n;
}

export interface CreateTokenInput {
  amount: number;
  currency: string;
  /** Vendure order code, possibly retry-suffixed. */
  companyRef: string;
  companyRefUnique?: boolean;
  customerEmail?: string;
  customerFirstName?: string;
  customerLastName?: string;
  customerPhone?: string;
  customerCity?: string;
  customerCountry?: string;
  serviceDescription?: string;
}

export interface DpoXmlResult<T> {
  response: T;
  requestXml: string;
  responseXml: string;
}

/**
 * DPO Pay by Network ("API3G") client. XML-in/XML-out over HTTPS — no JSON option.
 * v6 (createToken/refundToken/cancelToken/updateToken) and v7 (verifyToken, always;
 * verifyRefund) hit different base URLs — see doc §1 / §4.1.1 for the full rationale.
 * Every method returns the raw request/response XML alongside the parsed result, since
 * the service layer needs the raw XML for the dpo_transaction_event audit log
 * (with <CompanyToken> redacted before it's written — see service/redact.ts).
 */
export class DpoClient {
  private readonly builder = new XMLBuilder({});
  // parseTagValue: false — numeric-looking values (order codes, amounts) must not be
  // silently coerced to JS numbers by the parser; numeric fields are parsed explicitly
  // below via `num()` where DPO's own type calls for a number.
  private readonly parser = new XMLParser({ parseTagValue: false, trimValues: true });

  constructor(private readonly options: DpoPluginOptions) {}

  private get apiUrlV6(): string {
    return this.options.apiUrlV6 ?? DEFAULT_API_URL_V6;
  }

  private get apiUrlV7(): string {
    return this.options.apiUrlV7 ?? DEFAULT_API_URL_V7;
  }

  private async post(
    baseUrl: string,
    body: Record<string, unknown>,
  ): Promise<{ requestXml: string; responseXml: string; parsed: Record<string, unknown> }> {
    const requestXml = XML_DECLARATION + this.builder.build({ API3G: body });
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        Accept: 'application/xml',
        // DPO's endpoint sits behind CloudFront, which returns a 403 (blocked, non-XML
        // HTML body) for requests with no/blank User-Agent — confirmed empirically
        // against the live sandbox. Node's default fetch doesn't send one, so this must
        // be set explicitly or every request in production fails identically.
        'User-Agent': 'agx-stores-dpo-plugin/1.0',
      },
      body: requestXml,
    });
    const responseXml = await res.text();
    const parsedRoot = this.parser.parse(responseXml) as Record<string, unknown>;
    const parsed = (parsedRoot?.API3G as Record<string, unknown>) ?? {};
    return { requestXml, responseXml, parsed };
  }

  async createToken(input: CreateTokenInput): Promise<DpoXmlResult<DpoCreateTokenResponse>> {
    const body = {
      CompanyToken: this.options.companyToken,
      Request: 'createToken',
      Transaction: {
        PaymentAmount: input.amount.toFixed(2),
        PaymentCurrency: input.currency,
        CompanyRef: input.companyRef,
        CompanyRefUnique: input.companyRefUnique ? 1 : 0,
        RedirectURL: this.options.redirectUrl,
        BackURL: this.options.backUrl,
        PTL: this.options.ptl ?? 5,
        PTLtype: this.options.ptlType ?? 'hours',
        ...(input.customerFirstName ? { customerFirstName: input.customerFirstName } : {}),
        ...(input.customerLastName ? { customerLastName: input.customerLastName } : {}),
        ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
        ...(input.customerPhone ? { customerPhone: input.customerPhone } : {}),
        ...(input.customerCity ? { customerCity: input.customerCity } : {}),
        ...(input.customerCountry ? { customerCountry: input.customerCountry } : {}),
      },
      Services: {
        Service: {
          ServiceType: this.options.serviceType,
          ServiceDescription: input.serviceDescription ?? this.options.serviceDescription ?? 'Order payment',
          ServiceDate: formatServiceDate(new Date()),
        },
      },
    };
    const { requestXml, responseXml, parsed } = await this.post(this.apiUrlV6, body);
    const response: DpoCreateTokenResponse = {
      result: str(parsed.Result) ?? '',
      resultExplanation: str(parsed.ResultExplanation) ?? '',
      transToken: str(parsed.TransToken),
      transRef: str(parsed.TransRef),
    };
    return { response, requestXml, responseXml };
  }

  /**
   * v7, always — see doc §4.1.1: this is the only operation with no v6 fallback,
   * because only v7 returns TransactionPaymentDate with full datetime granularity.
   * Uses normalizeEnvelope() since v7 errors return <Code>/<Explanation>, not
   * <Result>/<ResultExplanation> — the #1 place a naive v6-style port would break.
   */
  async verifyToken(input: {
    transToken?: string;
    companyRef?: string;
    verifyTransaction?: boolean;
  }): Promise<{ envelope: DpoApiEnvelope; response: DpoVerifyTokenV7Response; requestXml: string; responseXml: string }> {
    const body = {
      Request: 'verifyToken',
      CompanyToken: this.options.companyToken,
      ...(input.transToken ? { TransactionToken: input.transToken } : {}),
      ...(input.companyRef ? { CompanyRef: input.companyRef } : {}),
      VerifyTransaction: input.verifyTransaction === false ? 0 : 1,
    };
    const { requestXml, responseXml, parsed } = await this.post(this.apiUrlV7, body);
    const envelope = normalizeEnvelope({
      result: str(parsed.Result),
      resultExplanation: str(parsed.ResultExplanation),
      code: str(parsed.Code),
      explanation: str(parsed.Explanation),
    });
    const response: DpoVerifyTokenV7Response = {
      transactionPaymentDate: str(parsed.TransactionPaymentDate),
      transactionCreatedDate: str(parsed.TransactionCreatedDate),
      transactionExpiryDate: str(parsed.TransactionExpiryDate),
      transactionSettlementDate: str(parsed.TransactionSettlementDate),
      customerName: str(parsed.CustomerName),
      customerPhone: str(parsed.CustomerPhone),
      customerEmail: str(parsed.CustomerEmail),
      customerCountry: str(parsed.CustomerCountry),
      customerCity: str(parsed.CustomerCity),
      cardType: str(parsed.CardType),
      cardLastFour: str(parsed.CardLastFour),
      cardFirstSix: str(parsed.CardFirstSix),
      approvalNumber: str(parsed.ApprovalNumber),
      transactionAmount: num(parsed.TransactionAmount),
      transactionCurrency: str(parsed.TransactionCurrency),
      transactionFinalAmount: num(parsed.TransactionFinalAmount),
      transactionFinalCurrency: str(parsed.TransactionFinalCurrency),
      partPaymentRef: str(parsed.PartPaymentRef),
      companyRef: str(parsed.CompanyRef),
      transactionRef: str(parsed.TransactionRef),
      transactionFraudAlert: str(parsed.TransactionFraudAlert),
      transactionFraudExplanation: str(parsed.TransactionFraudExplanation),
    };
    return { envelope, response, requestXml, responseXml };
  }

  async refundToken(input: {
    transToken: string;
    refundAmount: number;
    refundDetails: string;
  }): Promise<DpoXmlResult<DpoRefundTokenResponse>> {
    const body = {
      CompanyToken: this.options.companyToken,
      Request: 'refundToken',
      TransactionToken: input.transToken,
      refundAmount: input.refundAmount.toFixed(2),
      refundDetails: input.refundDetails,
    };
    const { requestXml, responseXml, parsed } = await this.post(this.apiUrlV6, body);
    const response: DpoRefundTokenResponse = {
      result: str(parsed.Result) ?? '',
      resultExplanation: str(parsed.ResultExplanation) ?? '',
    };
    return { response, requestXml, responseXml };
  }

  /**
   * v7. Field spec unconfirmed per doc §3.5/§4.1.1 — deliberately not modelled beyond
   * the normalized envelope. Extend once DPO's verifyRefund-v7 Confluence page is read.
   */
  async verifyRefund(
    transToken: string,
  ): Promise<{ envelope: DpoApiEnvelope; requestXml: string; responseXml: string }> {
    const body = {
      Request: 'verifyRefund',
      CompanyToken: this.options.companyToken,
      TransactionToken: transToken,
    };
    const { requestXml, responseXml, parsed } = await this.post(this.apiUrlV7, body);
    const envelope = normalizeEnvelope({
      result: str(parsed.Result),
      resultExplanation: str(parsed.ResultExplanation),
      code: str(parsed.Code),
      explanation: str(parsed.Explanation),
    });
    return { envelope, requestXml, responseXml };
  }

  async cancelToken(transToken: string): Promise<DpoXmlResult<DpoSimpleResponse>> {
    const body = {
      CompanyToken: this.options.companyToken,
      Request: 'cancelToken',
      TransactionToken: transToken,
    };
    const { requestXml, responseXml, parsed } = await this.post(this.apiUrlV6, body);
    const response: DpoSimpleResponse = {
      result: str(parsed.Result) ?? '',
      resultExplanation: str(parsed.ResultExplanation) ?? '',
    };
    return { response, requestXml, responseXml };
  }

  async updateToken(input: {
    transToken: string;
    companyRef?: string;
    paymentAmount?: number;
  }): Promise<DpoXmlResult<DpoSimpleResponse>> {
    const body = {
      CompanyToken: this.options.companyToken,
      Request: 'updateToken',
      TransactionToken: input.transToken,
      ...(input.companyRef ? { CompanyRef: input.companyRef } : {}),
      ...(input.paymentAmount !== undefined ? { PaymentAmount: input.paymentAmount.toFixed(2) } : {}),
    };
    const { requestXml, responseXml, parsed } = await this.post(this.apiUrlV6, body);
    const response: DpoSimpleResponse = {
      result: str(parsed.Result) ?? '',
      resultExplanation: str(parsed.ResultExplanation) ?? '',
    };
    return { response, requestXml, responseXml };
  }

  /** The URL to redirect the customer to in order to pay on DPO's hosted page. */
  getHostedPaymentUrl(transToken: string): string {
    const base = this.options.hostedPaymentBaseUrl ?? DEFAULT_HOSTED_PAYMENT_BASE_URL;
    return `${base}?ID=${encodeURIComponent(transToken)}`;
  }
}
