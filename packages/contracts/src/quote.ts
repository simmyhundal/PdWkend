import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MoneySchema, addMoney, formatMoney, money, moneyEquals, type Money } from "./money.js";
import { stampFetch } from "./freshness.js";
import { FeeInclusionError } from "./errors.js";

export const TransportMode = z.enum(["rail", "flight", "bus", "ferry"]);
export type TransportMode = z.infer<typeof TransportMode>;

export const SourceType = z.enum(["operator", "aggregator"]);
export type SourceType = z.infer<typeof SourceType>;

/**
 * `confirmed`   — every fee that will appear at checkout is itemised below.
 * `unconfirmed` — fees may exist that we could not read. The total is a floor,
 *                 not a checkout figure, and must be presented as such.
 */
export const FeeConfidence = z.enum(["confirmed", "unconfirmed"]);
export type FeeConfidence = z.infer<typeof FeeConfidence>;

export const FeeSchema = z.object({
  kind: z.enum(["booking", "card", "service", "seat_reservation", "baggage", "other"]),
  label: z.string().min(1),
  amount: MoneySchema,
});
export type Fee = z.infer<typeof FeeSchema>;

/** Why an option is worth showing even though a search wouldn't surface it first. */
export const NonObviousSchema = z.object({
  kind: z.enum([
    "snap",
    "split_ticket",
    "advance_fare",
    "off_peak",
    "alternate_airport",
    "alternate_station",
    "budget_carrier",
    "overnight",
  ]),
  reason: z.string().min(1),
});
export type NonObvious = z.infer<typeof NonObviousSchema>;

export const LegRefSchema = z.object({
  origin: z.string().min(1),
  destination: z.string().min(1),
  /** Travel date, YYYY-MM-DD, in the origin's local timezone. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
});
export type LegRef = z.infer<typeof LegRefSchema>;

export const FareQuoteSchema = z
  .object({
    quote_id: z.string().min(1),
    /** Discriminant. A FareQuote is always live-fetched; estimates use PriceEstimate. */
    price_kind: z.literal("quote"),

    leg: LegRefSchema,
    mode: TransportMode,
    operator: z.string().min(1),
    /** The specific fare product, e.g. "Standard", "Snap", "Economy Basic". */
    fare_name: z.string().min(1),

    base_price: MoneySchema,
    fees: z.array(FeeSchema),
    /** Derived: base_price + fees. Never set this by hand — see createQuote. */
    total_price: MoneySchema,
    fee_confidence: FeeConfidence,
    fee_note: z.string().optional(),

    source_type: SourceType,
    source_url: z.url(),
    booking_url: z.url().optional(),

    fetched_at: z.iso.datetime(),
    session_id: z.string().min(1),

    depart_at: z.string().optional(),
    arrive_at: z.string().optional(),
    duration_minutes: z.number().int().positive().optional(),
    changes: z.number().int().min(0).optional(),

    non_obvious: NonObviousSchema.optional(),
    caveats: z.array(z.string()).default([]),

    /** Phase 2 seam. Phase 1 never advances this. */
    booking_status: z.literal("unbooked").default("unbooked"),
  })
  .superRefine((q, ctx) => {
    // Hard requirement #2, part 1: the arithmetic must hold.
    let expected: Money;
    try {
      expected = q.fees.length ? addMoney(q.base_price, ...q.fees.map((f) => f.amount)) : q.base_price;
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        path: ["fees"],
        message: err instanceof Error ? err.message : "fee currency mismatch",
      });
      return;
    }
    if (!moneyEquals(expected, q.total_price)) {
      ctx.addIssue({
        code: "custom",
        path: ["total_price"],
        message:
          `total_price ${formatMoney(q.total_price)} != base ${formatMoney(q.base_price)} + fees ` +
          `${formatMoney(expected)} — a fee is missing from the displayed total.`,
      });
    }

    // Hard requirement #2, part 2: this is the Omio bug, encoded.
    // An aggregator that reports no fees has almost certainly not disclosed them
    // rather than genuinely having none, so it cannot claim `confirmed`.
    if (q.source_type === "aggregator" && q.fees.length === 0 && q.fee_confidence === "confirmed") {
      ctx.addIssue({
        code: "custom",
        path: ["fee_confidence"],
        message:
          "Aggregator quote lists no fees but claims confirmed fee data. Either itemise the " +
          "booking fee or mark fee_confidence 'unconfirmed' so the total is shown as pre-fee.",
      });
    }

    // An unconfirmed total is not a checkout figure; the caller must say so.
    if (q.fee_confidence === "unconfirmed" && !q.fee_note) {
      ctx.addIssue({
        code: "custom",
        path: ["fee_note"],
        message: "fee_confidence 'unconfirmed' requires a fee_note explaining what may be missing.",
      });
    }
  });

export type FareQuote = z.infer<typeof FareQuoteSchema>;

/**
 * A range, explicitly not bookable. Structurally incompatible with FareQuote so it
 * cannot be passed where a quote is expected — that's the point. Use only when a
 * live fetch is impossible (booking window not open) *and* the user asked for a
 * ballpark anyway.
 */
export const PriceEstimateSchema = z.object({
  price_kind: z.literal("estimate"),
  leg: LegRefSchema,
  mode: TransportMode,
  range_low: MoneySchema,
  range_high: MoneySchema,
  /** Where the range came from. Never "general knowledge" — cite something. */
  basis: z.string().min(1),
  as_of: z.string().min(1),
  bookable: z.literal(false),
  disclaimer: z.string().min(1),
});
export type PriceEstimate = z.infer<typeof PriceEstimateSchema>;

export type Priced = FareQuote | PriceEstimate;

export function isQuote(p: Priced): p is FareQuote {
  return p.price_kind === "quote";
}

export interface CreateQuoteInput {
  leg: LegRef;
  mode: TransportMode;
  operator: string;
  fare_name: string;
  base_price: Money;
  fees?: Fee[];
  fee_confidence: FeeConfidence;
  fee_note?: string;
  source_type: SourceType;
  source_url: string;
  booking_url?: string;
  depart_at?: string;
  arrive_at?: string;
  duration_minutes?: number;
  changes?: number;
  non_obvious?: NonObvious;
  caveats?: string[];
}

/**
 * The only sanctioned way for an adapter to produce a quote.
 *
 * `total_price` is derived here and `fetched_at`/`session_id` are stamped here,
 * so an adapter cannot hand back a total that omits a fee, nor backdate a price
 * to look freshly fetched. Call this at the moment the live response lands.
 */
export function createQuote(input: CreateQuoteInput): FareQuote {
  const fees = input.fees ?? [];
  const total = fees.length ? addMoney(input.base_price, ...fees.map((f) => f.amount)) : input.base_price;

  const candidate = {
    quote_id: randomUUID(),
    price_kind: "quote" as const,
    ...input,
    fees,
    total_price: total,
    caveats: input.caveats ?? [],
    booking_status: "unbooked" as const,
    ...stampFetch(),
  };

  const parsed = FareQuoteSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new FeeInclusionError(
      `Refusing to emit an invalid quote from ${input.operator}: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

/** Convenience for the common aggregator shape: one booking fee on top of a base fare. */
export function bookingFee(minor: number, currency: string, label = "Booking fee"): Fee {
  return { kind: "booking", label, amount: money(minor, currency) };
}
