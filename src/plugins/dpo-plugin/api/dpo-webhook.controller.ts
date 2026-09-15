import { Controller, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { dpoLog } from '../config/dpo-log';
import { DpoVerifyAndSettleService } from '../service/dpo-verify-and-settle.service';

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Server-to-server notification endpoint, reserved for DPO's pushPayments feature.
 *
 * This is NOT where DPO's BackURL lands: per DPO's createToken docs, BackURL is a customer
 * browser GET, handled by GET /payments/dpo/callback in dpo-redirect.controller.ts.
 * pushPayments (configured with DPO; XML body; expects an XML <Response>OK</Response> ack) is
 * not supported yet — XML bodies aren't parsed here, so a push would currently log
 * `[callback] received` with its content type but no readable fields, then `[verify] no_match`.
 *
 * Never trusted as proof of payment on its own — purely a trigger to call verifyToken via
 * DpoVerifyAndSettleService, per doc §4.1.1's "always verify, every time."
 */
@Controller('payments/dpo')
export class DpoWebhookController {
  constructor(private verifyAndSettleService: DpoVerifyAndSettleService) {}

  @Post('callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = { ...query, ...body };

    const transToken = pickString(payload, ['TransactionToken', 'TransToken', 'transToken']);
    const companyRef = pickString(payload, ['CompanyRef', 'companyRef']);

    // Logged first, before any lookup, so "did anything reach us at all?" is answerable from the
    // logs alone. Field NAMES only — values other than token/companyRef stay out of the logs.
    dpoLog.info('callback', 'received', {
      method: req.method,
      contentType: req.headers['content-type'],
      fields: Object.keys(payload).join(',') || 'none',
      token: transToken,
      companyRef,
    });

    try {
      await this.verifyAndSettleService.verifyAndSettle({
        transToken,
        companyRef,
        source: 'callback',
        notification: { kind: 'push_callback', rawPayload: payload },
      });
    } catch (err) {
      // Log-not-throw: DPO would retry a callback whose real problem is on our side,
      // potentially spamming. Always respond 200 regardless of outcome — DPO's guidance
      // treats the callback as "go verify," not something requiring a meaningful body.
      dpoLog.error(
        'callback',
        'verify_failed',
        { token: transToken, companyRef, error: (err as Error).message },
        (err as Error).stack,
      );
    }
    res.status(200).send('OK');
  }
}
