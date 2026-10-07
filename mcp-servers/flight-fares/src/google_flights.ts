import {
  LiveFetchUnavailableError,
  createQuote,
  fromDecimal,
  type FareQuote,
} from "@pdwkend/contracts";
import {
  dismissConsent,
  withPage,
  type FareQuery,
  type FareSource,
  type FetchContext,
  type UnpricedOption,
} from "@pdwkend/sources";

/**
 * Flights, read from Google Flights.
 *
 * Airlines don't share a single site to scrape and each one guards its own
 * booking funnel, so a per-operator adapter for flights isn't a realistic v1.
 * Google Flights is the pragmatic source: it shows the airline's own fare and
 * adds no booking fee of its own, then hands off to the airline to book.
 *
 * It is still marked `aggregator`, and its fares are marked `unconfirmed` — not
 * because Google skims a fee, but because the headline fare on a basic-economy
 * ticket routinely excludes checked bags and seat selection. Under rule #2 an
 * amount that isn't the checkout total gets shown as "before fees", and being
 * conservative in that direction is the safe way to be wrong.
 *
 * Rows are parsed from their rendered text rather than CSS classes; Google's
 * class names are generated and change without notice, but the text layout
 * ("08:35 – 10:45 British Airways 1 hr 10 min LHR–CDG Nonstop … €112") is stable.
 */

const CONSENT_SELECTORS = [
  'button:has-text("Accept all")',
  'button:has-text("Reject all")',
  'form[action*="consent"] button',
  'button[aria-label*="Accept"]',
];

const SYMBOL_TO_CURRENCY: Record<string, string> = { "€": "EUR", "£": "GBP", $: "USD", "₹": "INR", "¥": "JPY" };

/** Project default; callers can override per search with `FareQuery.currency`. */
export const DEFAULT_CURRENCY = "USD";

/** Currencies that share the "$" symbol, so the symbol alone can't identify them. */
const DOLLAR_CURRENCIES = new Set(["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN", "CLP", "COP", "ARS"]);

export function buildFlightsUrl(query: FareQuery): string {
  // The natural-language `q` form is the documented human-facing entry point and
  // lets Google resolve "Paris" or "CDG" itself, so we don't need an airport table.
  const q = `Flights to ${query.destination} from ${query.origin} on ${query.date} oneway`;
  const params = new URLSearchParams({ q, hl: "en", curr: (query.currency ?? DEFAULT_CURRENCY).toUpperCase() });
  return `https://www.google.com/travel/flights?${params.toString()}`;
}

/** The schedule part of a row: everything except the price. */
export interface ParsedSchedule {
  departTime: string;
  arriveTime: string;
  /** Days after departure that the flight lands (the "+1" on an overnight arrival). */
  arriveDayOffset: number;
  airline: string;
  durationMinutes: number;
  originCode?: string;
  destinationCode?: string;
  stops: number;
}

export interface ParsedRow extends ParsedSchedule {
  priceMinor: number;
  currency: string;
}

const ROW_TIME = /\d{1,2}:\d{2}/;
const ROW_PRICE = /[£€$]\s?\d/;
/** Google's wording for a departure it lists but won't price (seen for Sky Airline one-way). */
const ROW_UNPRICED = /price unavailable/i;
const MONEY = /([£€$₹¥])\s?([\d,]+)(?:\.(\d{2}))?/g;

/**
 * Whether an `<li>`'s text is a result row worth parsing. Unpriced rows count:
 * filtering on a price here is what made them vanish before parsing (issue #5).
 */
export function isResultRowText(text: string): boolean {
  return (
    text.length < 400 && ROW_TIME.test(text) && (ROW_PRICE.test(text) || ROW_UNPRICED.test(text))
  );
}

function parseSchedule(clean: string): ParsedSchedule | undefined {
  // An overnight arrival carries a "+1" straight after the time; it has to be consumed
  // here or it leaks into the carrier text below.
  const times = clean.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*[–—-]\s*(\d{1,2}:\d{2}\s*[AP]M)(?:\s*\+\s*(\d))?/i);
  if (!times) return undefined;

  // The first duration is the journey; a connecting itinerary lists the layover
  // afterwards, so anchoring on the first match matters.
  const dur = clean.match(/(\d+)\s*hr(?:\s*(\d+)\s*min)?|(\d+)\s*min/i);
  if (!dur) return undefined;
  const durationMinutes = dur[1]
    ? Number(dur[1]) * 60 + Number(dur[2] ?? 0)
    : Number(dur[3] ?? 0);
  if (!durationMinutes) return undefined;

  const route = clean.match(/\b([A-Z]{3})[–—-]([A-Z]{3})\b/);
  const stopsMatch = clean.match(/Nonstop|(\d+)\s*stops?/i);
  const stops = !stopsMatch ? 0 : stopsMatch[1] ? Number(stopsMatch[1]) : 0;

  // The carrier is whatever sits between the arrival time and the duration.
  const between = clean.slice(
    (times.index ?? 0) + times[0].length,
    dur.index ?? clean.length,
  );
  const airline = splitCarriers(between.replace(/Operated by.*$/i, "")) || "Airline";

  return {
    departTime: normaliseTime(times[1] ?? ""),
    arriveTime: normaliseTime(times[2] ?? ""),
    arriveDayOffset: Number(times[3] ?? 0),
    airline,
    durationMinutes,
    originCode: route?.[1],
    destinationCode: route?.[2],
    stops,
  };
}

/**
 * A row Google lists without a price. Returns the schedule only, never a number,
 * and only when the row says so explicitly, so a priced row that merely failed to
 * parse isn't passed off as "unpriced".
 */
export function parseUnpricedRow(text: string): ParsedSchedule | undefined {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!ROW_UNPRICED.test(clean) || [...clean.matchAll(MONEY)].length > 0) return undefined;
  return parseSchedule(clean);
}

/** Exported for tests — this is the fragile part, so it's tested in isolation. */
export function parseFlightRow(text: string, expectedCurrency?: string): ParsedRow | undefined {
  const clean = text.replace(/\s+/g, " ").trim();
  const schedule = parseSchedule(clean);
  if (!schedule) return undefined;

  // Price sits at the end of the row; take the last money-shaped token.
  const priceMatches = [...clean.matchAll(MONEY)];
  const price = priceMatches.at(-1);
  if (!price) return undefined;
  const symbolCurrency = SYMBOL_TO_CURRENCY[price[1] ?? ""] ?? "GBP";
  // "$" is shared by many currencies. When we asked for one of them, the page is
  // showing that one; otherwise a CAD fare would be mislabelled as USD.
  const wanted = expectedCurrency?.toUpperCase();
  const currency =
    price[1] === "$" && wanted && DOLLAR_CURRENCIES.has(wanted) ? wanted : symbolCurrency;
  const whole = Number((price[2] ?? "0").replace(/,/g, ""));
  const cents = Number(price[3] ?? 0);
  const priceMinor = whole * 100 + cents;
  if (priceMinor <= 0) return undefined;

  return { ...schedule, priceMinor, currency };
}

/**
 * Airlines whose own branding contains an internal capital. Without these, the
 * codeshare split below turns "easyJet" into "easy, Jet".
 */
const INTERNAL_CAPS = ["easyJet", "flyDubai", "jetBlue", "airBaltic", "AirAsia", "airBLUE", "flyNAS"];

/**
 * innerText collapses the carrier block's line breaks, so a codeshare arrives
 * glued together ("VuelingIberia, British Airways"). Restore the seam, without
 * cutting brands that legitimately capitalise mid-word.
 */
export function splitCarriers(raw: string): string {
  let text = raw.trim();
  const masks = new Map<string, string>();

  INTERNAL_CAPS.forEach((brand, i) => {
    const re = new RegExp(brand, "gi");
    if (!re.test(text)) return;
    // Letter-free sentinel: it must not itself create a lowercase->uppercase
    // boundary for the split below, and must stay printable so this file
    // doesn't read as binary to git and other tooling.
    const token = `~~${i}~~`;
    masks.set(token, brand);
    text = text.replace(re, token);
  });

  text = text
    // A masked brand glued to a neighbouring carrier ("easyJetLATAM") has no case
    // boundary to split on, so cut at the sentinel's edges instead.
    .replace(/([A-Za-z])(~~\d+~~)/g, "$1, $2")
    .replace(/(~~\d+~~)([A-Za-z])/g, "$1, $2")
    .replace(/([a-z])([A-Z])/g, "$1, $2")
    // An all-caps carrier glued to a capitalised one ("LATAMDelta"): split between the
    // caps run and the last capital, which starts the next name.
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, "$1, $2")
    .replace(/\s*,\s*,+/g, ",")
    .replace(/[,·]+$/, "")
    .trim();

  for (const [token, brand] of masks) text = text.replaceAll(token, brand);
  return text.replace(/\s+/g, " ").trim();
}

/** "5:35 PM" → "17:35", so times sort and compare as strings. */
function normaliseTime(t: string): string {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
  if (!m) return t.trim();
  let hour = Number(m[1]) % 12;
  if ((m[3] ?? "").toUpperCase() === "P") hour += 12;
  return `${String(hour).padStart(2, "0")}:${m[2]}`;
}

export class GoogleFlightsSource implements FareSource {
  readonly id = "google-flights";
  readonly operator = "Various airlines";
  readonly mode = "flight" as const;
  readonly sourceType = "aggregator" as const;

  supports(): boolean {
    return true;
  }

  /**
   * Collect result rows once the list has stopped growing.
   *
   * Returns as soon as two consecutive polls agree on the count, so a fast search
   * doesn't pay the full settle budget, but a slow one still gets its later (and
   * often cheaper) results.
   */
  async #readSettledRows(page: import("playwright").Page): Promise<string[]> {
    // Filter in Node rather than in the page so the same predicate is unit-tested.
    const readRows = () =>
      page
        .evaluate(() =>
          [...document.querySelectorAll("li")].map((li) => (li as HTMLElement).innerText ?? ""),
        )
        .then((texts) => texts.filter(isResultRowText));

    const deadline = Date.now() + 25_000;
    let previous = -1;
    let rows: string[] = [];

    while (Date.now() < deadline) {
      rows = await readRows().catch(() => [] as string[]);
      if (rows.length > 0 && rows.length === previous) return rows;
      previous = rows.length;
      await page.waitForTimeout(1_500);
    }
    return rows;
  }

  async fetch(query: FareQuery, ctx: FetchContext): Promise<FareQuote[]> {
    const url = buildFlightsUrl(query);
    const requestedCurrency = (query.currency ?? DEFAULT_CURRENCY).toUpperCase();
    ctx.log(`google-flights: ${query.origin} → ${query.destination} on ${query.date}`);

    return withPage(ctx.browser, this.id, url, async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await dismissConsent(page, CONSENT_SELECTORS);

      // Google streams results in after the shell renders. Waiting for the first
      // priced row isn't enough — it returns while the list is still filling and
      // yields a single flight that isn't necessarily the cheapest. Poll until
      // the count stops growing instead.
      const texts = await this.#readSettledRows(page);

      if (texts.length === 0) {
        const blocked = await page
          .evaluate(() => /unusual traffic|not a robot|captcha/i.test(document.body.innerText))
          .catch(() => false);
        throw new LiveFetchUnavailableError(
          blocked
            ? "Google Flights served a bot check instead of results."
            : `No flights found for ${query.origin} → ${query.destination} on ${query.date}.`,
          {
            source: "Google Flights",
            reason: blocked ? "rate_limited" : "no_service_on_route",
            source_url: url,
          },
        );
      }

      const seen = new Set<string>();
      const quotes: FareQuote[] = [];
      const unpriced: UnpricedOption[] = [];
      let skippedRows = 0;
      for (const text of texts) {
        const row = parseFlightRow(text, query.currency ?? DEFAULT_CURRENCY);
        if (!row) {
          // Never drop a listed departure silently (issue #5): keep its schedule,
          // with no price, or at least count it so the result isn't read as complete.
          const sched = parseUnpricedRow(text);
          if (!sched) {
            skippedRows += 1;
            continue;
          }
          if (!withinWindow(sched.departTime, query)) continue;
          const key = `unpriced|${sched.airline}|${sched.departTime}`;
          if (seen.has(key)) continue;
          seen.add(key);
          unpriced.push({
            operator: sched.airline,
            depart_at: `${query.date}T${sched.departTime}`,
            arrive_at: `${addDays(query.date, sched.arriveDayOffset)}T${sched.arriveTime}`,
            duration_minutes: sched.durationMinutes,
            changes: sched.stops,
            reason: "price_not_shown",
            source_url: url,
          });
          continue;
        }
        if (!withinWindow(row.departTime, query)) continue;

        // Google repeats the same itinerary across its "best"/"cheapest" panels.
        const dedupeKey = `${row.airline}|${row.departTime}|${row.priceMinor}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const routeLabel =
          row.originCode && row.destinationCode ? ` ${row.originCode}–${row.destinationCode}` : "";

        quotes.push(
          createQuote({
            leg: { origin: query.origin, destination: query.destination, date: query.date },
            mode: this.mode,
            operator: row.airline,
            fare_name: `${row.stops === 0 ? "Nonstop" : `${row.stops} stop`}${routeLabel}`,
            base_price: fromDecimal(row.priceMinor / 100, row.currency),
            fees: [],
            fee_confidence: "unconfirmed",
            fee_note:
              "Google Flights shows the airline's headline fare; checked bags and seat selection may cost extra",
            source_type: this.sourceType,
            source_url: url,
            depart_at: `${query.date}T${row.departTime}`,
            arrive_at: `${addDays(query.date, row.arriveDayOffset)}T${row.arriveTime}`,
            duration_minutes: row.durationMinutes,
            changes: row.stops,
            caveats: [
              "Book on the airline's own site — confirm the total including bags at checkout.",
              ...(row.currency !== requestedCurrency
                ? [`Google showed this fare in ${row.currency}, not the requested ${requestedCurrency}.`]
                : []),
            ],
          }),
        );
      }

      ctx.report?.({ unpriced, skipped_rows: skippedRows });

      if (quotes.length === 0) {
        throw new LiveFetchUnavailableError(
          unpriced.length > 0
            ? `Google Flights lists ${unpriced.length} departure(s) for ${query.date} but shows no one-way price for any of them.`
            : `Google Flights returned rows but none could be parsed into a fare for ${query.date}.`,
          { source: "Google Flights", reason: "parse_failed", source_url: url },
        );
      }
      return quotes;
    });
  }
}

/** YYYY-MM-DD plus whole days, in UTC so DST can't shift the date. */
export function addDays(date: string, days: number): string {
  if (!days) return date;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function withinWindow(departure: string, query: FareQuery): boolean {
  if (query.earliest_departure && departure < query.earliest_departure) return false;
  if (query.latest_departure && departure > query.latest_departure) return false;
  return true;
}
