// Request/response shapes per documentation/dpo-pay-vendure-plugin-docs.md §3.1-3.7.

export interface DpoCreateTokenRequest {
  companyToken: string;
  paymentAmount: number;
  paymentCurrency: string;
  /** Vendure order code, possibly retry-suffixed — see doc §3.1 field notes. */
  companyRef: string;
  companyRefUnique?: boolean;
  redirectUrl: string;
  backUrl: string;
  ptl?: number;
  ptlType?: 'minutes' | 'hours' | 'days';
  customer?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    city?: string;
    country?: string; // ISO 3166-1 alpha-2
  };
  services: Array<{
    serviceType: string;
    serviceDescription: string;
    serviceDate: string; // "YYYY/MM/DD HH:mm"
  }>;
}

export interface DpoCreateTokenResponse {
  result: string; // '000' = success
  resultExplanation: string;
  transToken?: string;
  transRef?: string;
}

export interface DpoVerifyTokenRequest {
  companyToken: string;
  transactionToken?: string;
  companyRef?: string;
  verifyTransaction?: boolean;
}

/** v7 verifyToken response. Envelope fields normalized separately — see dpo-envelope.ts. */
export interface DpoVerifyTokenV7Response {
  transactionPaymentDate?: string; // "YYYY/MM/DD HH:mm:ss" — NO timezone offset
  transactionCreatedDate?: string;
  transactionExpiryDate?: string;
  transactionSettlementDate?: string; // date only

  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  customerCountry?: string;
  customerCity?: string;

  cardType?: string;
  cardLastFour?: string;
  cardFirstSix?: string; // BIN only — never a full PAN
  approvalNumber?: string;

  transactionAmount?: number;
  transactionCurrency?: string;
  transactionFinalAmount?: number; // post-FX settlement value
  transactionFinalCurrency?: string;
  partPaymentRef?: string; // relates to Result 007

  companyRef?: string;
  transactionRef?: string;
  transactionFraudAlert?: string;
  transactionFraudExplanation?: string;
}

export interface DpoRefundTokenRequest {
  companyToken: string;
  transactionToken: string;
  refundAmount: number;
  refundDetails: string;
}

export interface DpoRefundTokenResponse {
  result: string;
  resultExplanation: string;
}

export interface DpoCancelTokenRequest {
  companyToken: string;
  transactionToken: string;
}

export interface DpoUpdateTokenRequest {
  companyToken: string;
  transactionToken: string;
  companyRef?: string;
  paymentAmount?: number;
}

export interface DpoSimpleResponse {
  result: string;
  resultExplanation: string;
}
