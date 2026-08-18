import { z } from "zod";

/**
 * Money is stored in integer minor units (cents, pence) rather than a decimal.
 *
 * This is not fussiness. Hard requirement #2 is arithmetic — `base + fees = total`
 * must hold exactly, and must be *checkable*. Floating point makes that check
 * unreliable (8.9 + 0.7 !== 9.6), which is exactly how a fee silently goes
 * missing from a displayed total.
 */
export const MoneySchema = z.object({
  minor: z.number().int("Money.minor must be an integer in the currency's minor unit"),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, "currency must be an uppercase ISO-4217 code"),
});

export type Money = z.infer<typeof MoneySchema>;

/** Currencies whose minor unit is the whole unit (no cents). */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF"]);

export function minorUnitExponent(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function money(minor: number, currency: string): Money {
  return { minor: Math.round(minor), currency: currency.toUpperCase() };
}

/** Build Money from a decimal figure as displayed on a booking site (e.g. 89.5 → 8950). */
export function fromDecimal(amount: number, currency: string): Money {
  const factor = 10 ** minorUnitExponent(currency);
  return money(Math.round(amount * factor), currency);
}

export function toDecimal(m: Money): number {
  return m.minor / 10 ** minorUnitExponent(m.currency);
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Cannot combine ${a} and ${b} — convert to a single currency first.`);
    this.name = "CurrencyMismatchError";
  }
}

export function addMoney(...amounts: Money[]): Money {
  if (amounts.length === 0) throw new Error("addMoney requires at least one amount");
  const [first, ...rest] = amounts as [Money, ...Money[]];
  let total = first.minor;
  for (const next of rest) {
    if (next.currency !== first.currency) throw new CurrencyMismatchError(first.currency, next.currency);
    total += next.minor;
  }
  return { minor: total, currency: first.currency };
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

const SYMBOLS: Record<string, string> = { EUR: "€", GBP: "£", USD: "$", CHF: "CHF ", JPY: "¥" };

/** Human-facing rendering. Used in tables and in the sheet. */
export function formatMoney(m: Money): string {
  const symbol = SYMBOLS[m.currency] ?? `${m.currency} `;
  const digits = minorUnitExponent(m.currency);
  return `${symbol}${toDecimal(m).toFixed(digits)}`;
}
