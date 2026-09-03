import { ValueTransformer } from 'typeorm';

/**
 * Postgres (and some other drivers) return `decimal` columns as strings to avoid
 * float rounding surprises. Applying this on every decimal column keeps the JS-side
 * type as `number` consistently across the sqlite (local dev) and Postgres
 * (eventual agx-stores) drivers.
 */
export const decimalTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | number | null | undefined) => (value == null ? value : parseFloat(value as string)),
};
