import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { dpoLog } from '../config/dpo-log';
import { DPO_PAY_PLUGIN_OPTIONS, DpoPluginOptions } from '../config/dpo-plugin-options';
import { DpoVerifyAndSettleService } from '../service/dpo-verify-and-settle.service';

// Not part of the original spec (which is backend-only) — where the customer's browser
// goes after verifyAndSettle completes. Default assumes the same storefront-at-
// localhost:8080 convention already used elsewhere in vendure-config.ts's email plugin
// config; override via DpoPluginOptions.storefrontConfirmationUrlTemplate.
const DEFAULT_STOREFRONT_CONFIRMATION_URL_TEMPLATE = 'http://localhost:8080/checkout/confirmation/{orderCode}?dpoStatus={status}';

/**
 * The browser-facing targets of DPO's hosted payment page. Per DPO's createToken docs, both
 * URLs we send are customer browser redirects using GET, with TransactionToken and CompanyRef
 * in the query string — neither is a server-to-server notification:
 *
 *  - RedirectURL → GET /payments/dpo/return   (after the customer pays)
 *  - BackURL     → GET /payments/dpo/callback (customer clicks "Back to Merchant", cancels, or times out)
 *
 * Both verify server-side via the shared verifyAndSettle, then 302 to the storefront
 * confirmation page, with no dependency on the customer's original session surviving the trip
 * to DPO and back. The storefront should re-query order state normally (e.g. orderByCode)
 * rather than trust the query string as proof of anything — verification has already happened.
 */
@Controller('payments/dpo')
export class DpoRedirectController {
  constructor(
    private verifyAndSettleService: DpoVerifyAndSettleService,
    @Inject(DPO_PAY_PLUGIN_OPTIONS) private options: DpoPluginOptions,
  ) {}

  @Get('return')
  async returnFromHostedPage(@Query() query: Record<string, string>, @Res() res: Response): Promise<void> {
    await this.verifyThenRedirect(query, res, 'return');
  }

  @Get('callback')
  async backFromHostedPage(@Query() query: Record<string, string>, @Res() res: Response): Promise<void> {
    await this.verifyThenRedirect(query, res, 'back');
  }

  private async verifyThenRedirect(
    query: Record<string, string>,
    res: Response,
    source: 'return' | 'back',
  ): Promise<void> {
    const transToken = query.TransactionToken || query.TransToken || query.transToken;
    const companyRef = query.CompanyRef || query.companyRef;
    dpoLog.info(source, 'received', { token: transToken, companyRef });

    let orderCode = companyRef ?? '';
    let status = 'unknown';
    try {
      const result = await this.verifyAndSettleService.verifyAndSettle({
        transToken,
        companyRef,
        source,
        // The audit-trail event type has no separate "back" value — the log line's
        // source= distinguishes a BackURL hit from a RedirectURL one.
        notification: { kind: 'redirect_return', rawPayload: query },
      });
      if (result) {
        orderCode = result.dpoTransaction.order?.code ?? result.dpoTransaction.companyRef;
        status = result.dpoTransaction.status;
      }
    } catch (err) {
      dpoLog.error(
        source,
        'verify_failed',
        { token: transToken, companyRef, error: (err as Error).message },
        (err as Error).stack,
      );
      status = 'error';
    }

    const template = this.options.storefrontConfirmationUrlTemplate ?? DEFAULT_STOREFRONT_CONFIRMATION_URL_TEMPLATE;
    const target = template
      .replace('{orderCode}', encodeURIComponent(orderCode))
      .replace('{status}', encodeURIComponent(status));
    dpoLog.info(source, 'redirect', { order: orderCode, status });
    res.redirect(302, target);
  }
}
