import { z } from "zod";
import { addMoney, formatMoney, toDecimal } from "./money.js";
import { renderDuration } from "./present.js";
import type { FareQuote } from "./quote.js";

/**
 * One row of the itinerary as written to the sheet.
 *
 * `itinerary_key` is the idempotency key: deterministic from the leg's identity,
 * so re-running the same search updates the row in place instead of appending a
 * duplicate. It's human-readable on purpose — when a row looks wrong in the
 * sheet you want to see why without decoding a hash.
 */

export const BookingStatus = z.enum([
  "unbooked",
  // Phase 2 only. Phase 1 writes "unbooked" and never advances past it.
  "booking_in_progress",
  "booked",
  "cancelled",
]);
export type BookingStatus = z.infer<typeof BookingStatus>;

export const ItineraryRowSchema = z.object({
  itinerary_key: z.string().min(1),
  trip_id: z.string().min(1),
  leg_index: z.number().int().min(1),
  date: z.string(),
  origin: z.string(),
  destination: z.string(),
  mode: z.string(),
  operator: z.string(),
  fare_name: z.string(),
  depart_at: z.string(),
  arrive_at: z.string(),
  duration: z.string(),
  base_price: z.number(),
  fees: z.number(),
  total_price: z.number(),
  currency: z.string(),
  fees_confirmed: z.boolean(),
  source_type: z.string(),
  source_url: z.string(),
  fetched_at: z.string(),
  /** Phase 2 seam — present in the schema so adding booking doesn't rewrite the sheet. */
  booking_status: BookingStatus,
  booking_ref: z.string(),
  notes: z.string(),
});
export type ItineraryRow = z.infer<typeof ItineraryRowSchema>;

/** Column order in the sheet. Changing this reorders existing tabs — append, don't insert. */
export const ITINERARY_COLUMNS = [
  "itinerary_key",
  "trip_id",
  "leg_index",
  "date",
  "origin",
  "destination",
  "mode",
  "operator",
  "fare_name",
  "depart_at",
  "arrive_at",
  "duration",
  "base_price",
  "fees",
  "total_price",
  "currency",
  "fees_confirmed",
  "source_type",
  "source_url",
  "fetched_at",
  "booking_status",
  "booking_ref",
  "notes",
] as const satisfies readonly (keyof ItineraryRow)[];

export const HEADERS: string[] = [
  "Key",
  "Trip",
  "Leg",
  "Date",
  "From",
  "To",
  "Mode",
  "Operator",
  "Fare",
  "Depart",
  "Arrive",
  "Duration",
  "Base",
  "Fees",
  "Total",
  "Cur",
  "Fees confirmed",
  "Source type",
  "Source",
  "Fetched (UTC)",
  "Booking status",
  "Booking ref",
  "Notes",
];

/** The column the upsert matches on, 0-indexed. */
export const KEY_COLUMN_INDEX = 0;

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function itineraryKey(parts: {
  trip_id: string;
  leg_index: number;
  operator: string;
  fare_name: string;
}): string {
  return [parts.trip_id, `leg${parts.leg_index}`, slug(parts.operator), slug(parts.fare_name)].join("::");
}

export function rowFromQuote(quote: FareQuote, ctx: { trip_id: string; leg_index: number }): ItineraryRow {
  const feeTotal = quote.fees.length ? addMoney(...quote.fees.map((f) => f.amount)) : null;

  const notes: string[] = [];
  if (quote.non_obvious) notes.push(quote.non_obvious.reason);
  notes.push(...quote.caveats);
  if (quote.fee_confidence === "unconfirmed") {
    notes.push(`FEES UNCONFIRMED: ${quote.fee_note ?? "check total at checkout"}`);
  }

  return {
    itinerary_key: itineraryKey({ ...ctx, operator: quote.operator, fare_name: quote.fare_name }),
    trip_id: ctx.trip_id,
    leg_index: ctx.leg_index,
    date: quote.leg.date,
    origin: quote.leg.origin,
    destination: quote.leg.destination,
    mode: quote.mode,
    operator: quote.operator,
    fare_name: quote.fare_name,
    depart_at: quote.depart_at ?? "",
    arrive_at: quote.arrive_at ?? "",
    duration: renderDuration(quote.duration_minutes),
    base_price: toDecimal(quote.base_price),
    fees: feeTotal ? toDecimal(feeTotal) : 0,
    total_price: toDecimal(quote.total_price),
    currency: quote.total_price.currency,
    fees_confirmed: quote.fee_confidence === "confirmed",
    source_type: quote.source_type,
    source_url: quote.booking_url ?? quote.source_url,
    fetched_at: quote.fetched_at,
    booking_status: "unbooked",
    booking_ref: "",
    notes: notes.join(" | "),
  };
}

/** Flatten to the cell order the Sheets API expects. */
export function rowToValues(row: ItineraryRow): (string | number | boolean)[] {
  return ITINERARY_COLUMNS.map((col) => row[col]);
}

export function valuesToKey(values: unknown[]): string {
  const cell = values[KEY_COLUMN_INDEX];
  return typeof cell === "string" ? cell : "";
}

/** Human-readable one-liner used when confirming what was written. */
export function describeRow(row: ItineraryRow): string {
  const total = formatMoney({
    minor: Math.round(row.total_price * 100),
    currency: row.currency,
  });
  return `Leg ${row.leg_index}: ${row.origin}→${row.destination} ${row.date} — ${row.operator} ${row.fare_name} ${total}`;
}
