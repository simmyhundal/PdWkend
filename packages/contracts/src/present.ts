import { addMoney, formatMoney } from "./money.js";
import { assertFresh, ageMs, type FreshnessOptions } from "./freshness.js";
import { isQuote, type FareQuote, type Priced } from "./quote.js";

/**
 * Rendering lives here rather than in the system prompt because hard requirements
 * #2 and #3 are display rules, and a display rule enforced in code can't be
 * forgotten three turns into a conversation.
 */

/** Never print a bare total when fees are unconfirmed — that's the Omio failure. */
export function renderPrice(q: FareQuote): string {
  const total = formatMoney(q.total_price);

  if (q.fee_confidence === "unconfirmed") {
    return `${formatMoney(q.base_price)} before fees`;
  }
  if (q.fees.length === 0) {
    return total;
  }
  const feeTotal = addMoney(...q.fees.map((f) => f.amount));
  return `${total} (${formatMoney(q.base_price)} + ${formatMoney(feeTotal)} fee)`;
}

export function renderDuration(minutes: number | undefined): string {
  if (minutes === undefined) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m`;
}

export function renderAge(q: FareQuote, now: Date = new Date()): string {
  const seconds = Math.round(ageMs(q, now) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

function renderTimes(q: FareQuote): string {
  if (!q.depart_at) return "—";
  const time = (iso: string) => (iso.includes("T") ? iso.slice(11, 16) : iso);
  return q.arrive_at ? `${time(q.depart_at)}–${time(q.arrive_at)}` : time(q.depart_at);
}

function renderOption(q: FareQuote): string {
  const label = `${q.operator} ${q.fare_name}`;
  return q.non_obvious ? `${label} ⚡` : label;
}

function renderSource(q: FareQuote): string {
  const host = safeHost(q.source_url);
  return q.source_type === "aggregator" ? `${host} (reseller)` : host;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export interface TableOptions extends FreshnessOptions {
  /** Skip the freshness gate. Only for rendering historical rows into the sheet. */
  skipFreshnessCheck?: boolean;
}

/**
 * Markdown table of live options. Throws if any quote is stale — a table is the
 * moment a price gets stated as fact, so that's where the freshness gate belongs.
 */
export function renderQuoteTable(quotes: FareQuote[], opts: TableOptions = {}): string {
  if (quotes.length === 0) return "_No live prices available for this leg._";
  if (!opts.skipFreshnessCheck) for (const q of quotes) assertFresh(q, opts);

  const now = opts.now ?? new Date();
  const header = "| Option | Price | Duration | Times | Source | Fetched |";
  const divider = "|---|---|---|---|---|---|";
  const rows = [...quotes]
    .sort((a, b) => a.total_price.minor - b.total_price.minor)
    .map((q) =>
      [
        renderOption(q),
        renderPrice(q),
        renderDuration(q.duration_minutes),
        renderTimes(q),
        renderSource(q),
        renderAge(q, now),
      ].join(" | "),
    )
    .map((r) => `| ${r} |`);

  return [header, divider, ...rows].join("\n");
}

/**
 * Footnotes for anything the table can't carry: caveats, non-obvious rationale,
 * fee warnings.
 *
 * A note that applies to every row is printed once, unattributed. Repeating
 * "confirm the total including bags" under all six flights is the exact
 * padding rule #3 exists to prevent, and it buries the note that only applies
 * to one row.
 */
export function renderNotes(quotes: FareQuote[]): string[] {
  const shared: string[] = [];
  const specific: string[] = [];

  // Anything said about more than one option is said once, without a row label.
  const tally = new Map<string, number>();
  const record = (text: string) => tally.set(text, (tally.get(text) ?? 0) + 1);
  for (const q of quotes) {
    for (const caveat of q.caveats) record(caveat);
    if (q.fee_confidence === "unconfirmed") record(feeNoteText(q));
  }
  const isShared = (text: string) => (tally.get(text) ?? 0) > 1 && quotes.length > 1;

  const emitted = new Set<string>();
  for (const q of quotes) {
    // A non-obvious option's rationale is why it's in the table at all, so it
    // always keeps its own line.
    if (q.non_obvious) specific.push(`⚡ ${q.operator} ${q.fare_name}: ${q.non_obvious.reason}`);

    for (const caveat of q.caveats) {
      if (isShared(caveat)) {
        if (!emitted.has(caveat)) {
          emitted.add(caveat);
          shared.push(caveat);
        }
      } else {
        specific.push(`${q.operator} ${q.fare_name}: ${caveat}`);
      }
    }

    if (q.fee_confidence === "unconfirmed") {
      const text = feeNoteText(q);
      if (isShared(text)) {
        if (!emitted.has(text)) {
          emitted.add(text);
          shared.push(text);
        }
      } else {
        specific.push(`${q.operator} ${q.fare_name}: ${text}`);
      }
    }
  }

  return [...specific, ...shared];
}

function feeNoteText(q: FareQuote): string {
  return `${q.fee_note ?? "fees not confirmed"} — check the total at checkout.`;
}

/** Estimates render separately and always carry the disclaimer inline. */
export function renderPriced(items: Priced[], opts: TableOptions = {}): string {
  const quotes = items.filter(isQuote);
  const estimates = items.filter((i) => !isQuote(i));

  const parts = [renderQuoteTable(quotes, opts)];
  const notes = renderNotes(quotes);
  if (notes.length) parts.push(notes.map((n) => `- ${n}`).join("\n"));

  for (const e of estimates) {
    if (e.price_kind !== "estimate") continue;
    parts.push(
      `_Estimate only, not bookable:_ ${e.leg.origin}→${e.leg.destination} ` +
        `${formatMoney(e.range_low)}–${formatMoney(e.range_high)} (${e.basis}, as of ${e.as_of}). ${e.disclaimer}`,
    );
  }
  return parts.join("\n\n");
}
