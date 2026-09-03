/**
 * DPO's ServiceDate format: "YYYY/MM/DD HH:mm".
 */
export function formatServiceDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

const DATE_TIME_RE = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const DATE_ONLY_RE = /^(\d{4})\/(\d{2})\/(\d{2})$/;

/**
 * Parses DPO's "YYYY/MM/DD HH:mm:ss" datetime strings (e.g. <TransactionPaymentDate>,
 * <TransactionCreatedDate>, <TransactionExpiryDate>), which carry NO timezone offset.
 *
 * DECISION (locked in for this pass, testing-only): assume UTC. This is explicitly
 * flagged in the doc as a blocking open item to confirm with DPO before go-live — this
 * is the single, greppable place that assumption lives, so it can be revisited without
 * hunting through the codebase. The raw string should always be persisted alongside
 * (see dpo_transaction.payment_date_raw) so a wrong assumption is correctable later.
 */
export function parseDpoDateTimeAssumeUtc(raw: string | undefined | null): Date | undefined {
  if (!raw) return undefined;
  const match = DATE_TIME_RE.exec(raw.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

const MS_PER_UNIT: Record<'minutes' | 'hours' | 'days', number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export function computePtlExpiresAt(now: Date, ptlValue: number, ptlType: 'minutes' | 'hours' | 'days'): Date {
  return new Date(now.getTime() + ptlValue * MS_PER_UNIT[ptlType]);
}

/** Parses DPO's date-only "YYYY/MM/DD" strings (e.g. <TransactionSettlementDate>). */
export function parseDpoDateOnly(raw: string | undefined | null): Date | undefined {
  if (!raw) return undefined;
  const match = DATE_ONLY_RE.exec(raw.trim());
  if (!match) return undefined;
  const [, year, month, day] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(ms) ? undefined : new Date(ms);
}
