const COMPANY_TOKEN_TAG_RE = /(<CompanyToken>)([\s\S]*?)(<\/CompanyToken>)/gi;

/**
 * Every DPO request embeds the shared-secret CompanyToken in the body (doc §2), so the
 * audit log must never store it in plaintext. This is the single place that redaction
 * happens — called once, from dpo-transaction.service.ts's event-logging methods, never
 * duplicated at each call site and never done inside dpo-client.ts (which shouldn't know
 * about persistence/audit concerns at all).
 */
export function redactCompanyToken(xml: string | undefined | null): string | null {
  if (!xml) return null;
  return xml.replace(COMPANY_TOKEN_TAG_RE, '$1[REDACTED]$3');
}
