export interface DpoPluginOptions {
  /** Shared-secret GUID authenticating every request — see doc §2. Per-environment secret. */
  companyToken: string;
  /** Paired with companyToken; DPO rejects a request if the two don't belong together. */
  serviceType: string;
  serviceDescription?: string;
  /** Our own /payments/dpo/return controller's absolute URL — where DPO sends the customer's browser back. */
  redirectUrl: string;
  /** Our own /payments/dpo/callback controller's absolute URL — DPO's server-to-server BackURL notification. */
  backUrl: string;
  /** Default: https://secure.3gdirectpay.com/API/v6/ */
  apiUrlV6?: string;
  /** Default: https://secure.3gdirectpay.com/API/v7/ — used only for verifyToken/verifyRefund. */
  apiUrlV7?: string;
  /** Default: https://secure.3gdirectpay.com/payv3.php */
  hostedPaymentBaseUrl?: string;
  /** Pay Time Limit sent on createToken. Default: 5. */
  ptl?: number;
  /** Default: 'hours'. */
  ptlType?: 'minutes' | 'hours' | 'days';
  /**
   * Informational only — same host for both environments, DPO differentiates purely by
   * which companyToken is used. Logged prominently at startup as a human-visible tripwire
   * against a sandbox token reaching production; see doc §2/§4.4 open items.
   */
  useSandbox: boolean;
  /**
   * Not part of the original spec (which is backend-only) — where the redirect controller
   * sends the customer's browser after verifyAndSettle completes. Supports `{orderCode}` and
   * `{status}` placeholders. Default assumes the same storefront-at-localhost:8080 convention
   * already used elsewhere in vendure-config.ts's email plugin config.
   */
  storefrontConfirmationUrlTemplate?: string;
}

export const DPO_PAY_PLUGIN_OPTIONS = Symbol('DPO_PAY_PLUGIN_OPTIONS');

export function validateDpoPluginOptions(options: DpoPluginOptions | undefined): asserts options is DpoPluginOptions {
  if (!options) {
    throw new Error(
      'DpoPayPlugin: no options were provided. Call DpoPayPlugin.init({ ... }) before adding it to the plugins array.',
    );
  }
  const required: Array<keyof DpoPluginOptions> = ['companyToken', 'serviceType', 'redirectUrl', 'backUrl'];
  const missing = required.filter(key => !options[key]);
  if (missing.length > 0) {
    throw new Error(`DpoPayPlugin: missing required option(s): ${missing.join(', ')}.`);
  }
  if (typeof options.useSandbox !== 'boolean') {
    throw new Error('DpoPayPlugin: "useSandbox" must be explicitly set to true or false.');
  }
}
