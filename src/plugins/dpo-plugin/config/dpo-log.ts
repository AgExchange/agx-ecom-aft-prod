import { Logger } from '@vendure/core';
import { loggerCtx } from './constants';

/**
 * One-line, grep-able operational log lines for the DPO plugin, e.g.
 *
 *   [verify] result source=return order=ABC123 txn=4 token=… code=000 class=terminal-success status=paid
 *
 * Printed under the `DpoPayPlugin` context, so on the VM:
 *
 *   grep DpoPayPlugin ~/.pm2/logs/vendure-server-out.log
 *
 * Never pass the CompanyToken, raw XML, card details or customer PII in `fields` — the full
 * request/response audit trail lives in the dpo_transaction_event table, not in the logs.
 */
export type DpoLogFields = Record<string, string | number | boolean | null | undefined>;

export function formatDpoLog(area: string, event: string, fields: DpoLogFields = {}): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      const text = String(value);
      return `${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`;
    });
  return [`[${area}]`, event, ...parts].join(' ');
}

export const dpoLog = {
  info(area: string, event: string, fields?: DpoLogFields): void {
    Logger.info(formatDpoLog(area, event, fields), loggerCtx);
  },
  warn(area: string, event: string, fields?: DpoLogFields): void {
    Logger.warn(formatDpoLog(area, event, fields), loggerCtx);
  },
  error(area: string, event: string, fields?: DpoLogFields, stack?: string): void {
    Logger.error(formatDpoLog(area, event, fields), loggerCtx, stack);
  },
};
