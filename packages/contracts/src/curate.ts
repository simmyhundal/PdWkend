import type { FareQuote } from "./quote.js";

/**
 * Hard requirement #3 is a *data* problem before it's a prompt problem.
 *
 * A Eurostar day search returns ~43 priced combinations. Handing all of them to
 * the model and asking it to be brief invites either a wall of table or an
 * arbitrary truncation that drops the interesting fare. So the selection happens
 * here, deterministically, and the model receives a shortlist it can print whole.
 *
 * What survives, in priority order:
 *   1. the cheapest option overall — the default recommendation
 *   2. every non-obvious option (Snap, flexible dates, split tickets) — rule #3
 *      explicitly says not to hide these to save space; they're the value add
 *   3. the cheapest of each remaining fare class, so upgrades stay visible
 *   4. the fastest, when meaningfully quicker than the cheapest
 */

export interface CurateOptions {
  /** Hard cap on rows. Six fits a terminal without scrolling. */
  limit?: number;
  /** A journey must beat the cheapest by this much (minutes) to earn a row on speed. */
  fasterByMinutes?: number;
}

export function curateQuotes(quotes: FareQuote[], opts: CurateOptions = {}): FareQuote[] {
  const { limit = 6, fasterByMinutes = 20 } = opts;
  if (quotes.length <= limit) return [...quotes].sort(byPrice);

  const picked = new Map<string, FareQuote>();
  const keep = (q: FareQuote | undefined) => {
    if (q && !picked.has(q.quote_id)) picked.set(q.quote_id, q);
  };

  const sorted = [...quotes].sort(byPrice);
  const cheapest = sorted[0];
  keep(cheapest);

  // Non-obvious options are the whole point of the tool — never crowded out.
  for (const q of sorted) if (q.non_obvious) keep(q);

  // Cheapest per fare class, so "what does Plus cost?" stays answerable.
  const byClass = new Map<string, FareQuote>();
  for (const q of sorted) {
    const existing = byClass.get(q.fare_name);
    if (!existing || q.total_price.minor < existing.total_price.minor) byClass.set(q.fare_name, q);
  }
  for (const q of byClass.values()) {
    if (picked.size >= limit) break;
    keep(q);
  }

  // A materially faster journey is worth a row even at a higher price.
  if (picked.size < limit && cheapest?.duration_minutes) {
    const fastest = sorted
      .filter((q) => q.duration_minutes !== undefined)
      .sort((a, b) => (a.duration_minutes ?? 0) - (b.duration_minutes ?? 0))[0];
    if (fastest?.duration_minutes && fastest.duration_minutes + fasterByMinutes <= cheapest.duration_minutes) {
      keep(fastest);
    }
  }

  return [...picked.values()].slice(0, limit).sort(byPrice);
}

function byPrice(a: FareQuote, b: FareQuote): number {
  return a.total_price.minor - b.total_price.minor;
}

/**
 * The single recommendation rule #3 asks for.
 *
 * Cheapest wins, including the non-obvious fares — hiding a £50 Snap behind a
 * £114 standard fare because Snap has strings attached would defeat the point of
 * finding it. The strings get stated alongside the pick, not used to bury it.
 *
 * The one genuine disqualifier is a quote for a date the user didn't ask for: a
 * cheaper Tuesday is worth *showing* when someone asked about Saturday, but it
 * is not an answer to the question they asked. Callers that resolved a date
 * window themselves can omit `forDate` to let any date compete.
 *
 * Unconfirmed fees also lose, since those totals aren't checkout figures (#2).
 */
export function recommend(quotes: FareQuote[], opts: { forDate?: string } = {}): FareQuote | undefined {
  const sorted = [...quotes].sort(byPrice);
  const eligible = sorted.filter(
    (q) => q.fee_confidence === "confirmed" && (!opts.forDate || q.leg.date === opts.forDate),
  );
  return eligible[0] ?? sorted[0];
}
