import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { Logger } from '@vendure/core';
import { Response } from 'express';
import { loggerCtx } from '../config/constants';
import { DPO_PAY_PLUGIN_OPTIONS, DpoPluginOptions } from '../config/dpo-plugin-options';
import { DpoVerifyAndSettleService } from '../service/dpo-verify-and-settle.service';

// Not part of the original spec (which is backend-only) — where the customer's browser
// goes after verifyAndSettle completes. Default assumes the same storefront-at-
// localhost:8080 convention already used elsewhere in vendure-config.ts's email plugin
// config; override via DpoPluginOptions.storefrontConfirmationUrlTemplate.
const DEFAULT_STOREFRONT_CONFIRMATION_URL_TEMPLATE = 'http://localhost:8080/checkout/confirmation/{orderCode}?dpoStatus={status}';

/**
 * The browser-facing RedirectURL target — where DPO sends the customer back after they
 * pay (or cancel) on the hosted page. This replaces the old confirmDpoPayment GraphQL
 * mutation's session-dependent design entirely: verification happens server-side via the
 * same shared verifyAndSettle used by the webhook, with no dependency on the customer's
 * original session surviving the trip to DPO and back. The storefront's confirmation
 * page should re-query order state normally (e.g. orderByCode) rather than trusting the
 * query string as proof of anything — verification has already happened by this point.
 */
@Controller('payments/dpo')
export class DpoRedirectController {
  constructor(
    private verifyAndSettleService: DpoVerifyAndSettleService,
    @Inject(DPO_PAY_PLUGIN_OPTIONS) private options: DpoPluginOptions,
  ) {}

  @Get('return')
  async returnFromHostedPage(@Query() query: Record<string, string>, @Res() res: Response): Promise<void> {
    const transToken = query.TransactionToken || query.TransToken || query.transToken;
    const companyRef = query.CompanyRef || query.companyRef;

    let orderCode = companyRef ?? '';
    let status = 'unknown';
    try {
      const result = await this.verifyAndSettleService.verifyAndSettle({
        transToken,
        companyRef,
        notification: { kind: 'redirect_return', rawPayload: query },
      });
      if (result) {
        orderCode = result.dpoTransaction.order?.code ?? result.dpoTransaction.companyRef;
        status = result.dpoTransaction.status;
      }
    } catch (err) {
      Logger.error(`DPO redirect return failed: ${(err as Error).message}`, loggerCtx, (err as Error).stack);
      status = 'error';
    }

    const template = this.options.storefrontConfirmationUrlTemplate ?? DEFAULT_STOREFRONT_CONFIRMATION_URL_TEMPLATE;
    const target = template
      .replace('{orderCode}', encodeURIComponent(orderCode))
      .replace('{status}', encodeURIComponent(status));
    res.redirect(302, target);
  }
}
