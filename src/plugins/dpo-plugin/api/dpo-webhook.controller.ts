import { Controller, Post, Req, Res } from '@nestjs/common';
import { Logger } from '@vendure/core';
import { Request, Response } from 'express';
import { loggerCtx } from '../config/constants';
import { DpoVerifyAndSettleService } from '../service/dpo-verify-and-settle.service';

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * DPO's server-to-server BackURL notification. Doc §3.4: DPO supports both query-string
 * and POST-body callback styles depending on configuration, so both are read here. This
 * is never trusted as proof of payment on its own — it's purely a trigger to call
 * verifyToken via DpoVerifyAndSettleService, per doc §4.1.1's "always verify, every time."
 */
@Controller('payments/dpo')
export class DpoWebhookController {
  constructor(private verifyAndSettleService: DpoVerifyAndSettleService) {}

  @Post('callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const source: Record<string, unknown> = { ...query, ...body };

    const transToken = pickString(source, ['TransactionToken', 'TransToken', 'transToken']);
    const companyRef = pickString(source, ['CompanyRef', 'companyRef']);

    try {
      await this.verifyAndSettleService.verifyAndSettle({
        transToken,
        companyRef,
        notification: { kind: 'push_callback', rawPayload: source },
      });
    } catch (err) {
      // Log-not-throw: DPO would retry a callback whose real problem is on our side,
      // potentially spamming. Always respond 200 regardless of outcome — DPO's guidance
      // treats the callback as "go verify," not something requiring a meaningful body.
      Logger.error(`DPO webhook callback failed: ${(err as Error).message}`, loggerCtx, (err as Error).stack);
    }
    res.status(200).send('OK');
  }
}
