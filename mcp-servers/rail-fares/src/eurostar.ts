import {
  LiveFetchUnavailableError,
  createQuote,
  fromDecimal,
  type FareQuote,
} from "@pdwkend/contracts";
import { dismissConsent, waitForGraphQLOp, withPage } from "@pdwkend/sources";
import { loadStations, marketFor, resolveStation, type Station } from "./stations.js";
import type { FareQuery, FareSource, FetchContext } from "@pdwkend/sources";

/**
 * Eurostar, read from Eurostar's own booking search.
 *
 * Rule #2 makes the operator the default source of truth, and Eurostar is the
 * clean case: the price its search returns is the price at checkout — no booking
 * fee is added on eurostar.com, which is exactly why we prefer it over Omio.
 * So these quotes carry `fees: []` with `fee_confidence: "confirmed"`.
 *
 * Eurostar sits behind AWS WAF, which is why this drives a real browser: the WAF
 * challenge is solved by the page's own JS. We navigate straight to the results
 * URL and read the `NewBookingSearch` GraphQL response rather than driving the
 * search widget, which has duplicate responsive copies and a fiddly date picker.
 */

const CONSENT_SELECTORS = [
  'button[aria-label="Accept all cookies"]',
  'button:has-text("Accept all")',
  "#onetrust-accept-btn-handler",
];

interface EurostarPrices {
  displayPrice: number | null;
  total: number | null;
  adult: number | null;
}

interface EurostarFare {
  class: { name: string; code: string } | null;
  classOfService: { name: string; code: string } | null;
  prices: EurostarPrices | null;
  seats: number | null;
  promo: unknown;
  legs?: { flexibilityLevel?: number; products?: { name?: string }[] }[];
}

interface EurostarJourney {
  timing: { date: string; departureTime: string; arrivalTime: string; duration: number } | null;
  fares: EurostarFare[] | null;
}

interface NewBookingSearchBody {
  data?: {
    journeySearch?: {
      outbound?: {
        origin?: { name: string; uic: string };
        destination?: { name: string; uic: string };
        journeys?: EurostarJourney[];
      };
    };
  };
}

interface CheapestFaresBody {
  data?: { cheapestFaresSearch?: { cheapestFares?: { date: string; price: number }[] }[] };
}

/** Classes that are fare products a traveller can actually buy. */
const BOOKABLE_CLASSES = new Set(["STANDARD", "PLUS", "PREMIER"]);

export function buildSearchUrl(params: {
  market: string;
  originUic: string;
  destinationUic: string;
  date: string;
  adults: number;
}): string {
  const qs = new URLSearchParams({
    adult: String(params.adults),
    origin: params.originUic,
    destination: params.destinationUic,
    outbound: params.date,
  });
  return `https://www.eurostar.com/search/${params.market}?${qs.toString()}`;
}

export class EurostarSource implements FareSource {
  readonly id = "eurostar";
  readonly operator = "Eurostar";
  readonly mode = "rail" as const;
  readonly sourceType = "operator" as const;

  #stations: Station[] | undefined;

  supports(): boolean {
    // Route validity is decided by station resolution, which needs the index.
    // Returning true here keeps `supports` synchronous and network-free; an
    // unroutable pair fails loudly in fetch() rather than being silently skipped.
    return true;
  }

  async fetch(query: FareQuery, ctx: FetchContext): Promise<FareQuote[]> {
    this.#stations ??= await loadStations(ctx.browser);
    const origin = resolveStation(query.origin, this.#stations).station;
    const destination = resolveStation(query.destination, this.#stations).station;

    if (origin.uic === destination.uic) {
      throw new LiveFetchUnavailableError(`Origin and destination are the same station (${origin.name}).`, {
        source: this.id,
        reason: "no_service_on_route",
      });
    }

    const { market, currency } = marketFor(origin);
    const url = buildSearchUrl({
      market,
      originUic: origin.uic,
      destinationUic: destination.uic,
      date: query.date,
      adults: query.adults,
    });

    ctx.log(`eurostar: ${origin.name} → ${destination.name} on ${query.date} (${currency})`);

    return withPage(ctx.browser, this.id, url, async (page) => {
      // Listeners must be attached before navigation or the response outruns them.
      const searchPromise = waitForGraphQLOp<NewBookingSearchBody>(page, "NewBookingSearch");
      const cheapestPromise = waitForGraphQLOp<CheapestFaresBody>(page, "CheapestFaresSearch", {
        timeoutMs: 20_000,
      });

      await page.goto(url, { waitUntil: "domcontentloaded" });
      await dismissConsent(page, CONSENT_SELECTORS);

      const body = await searchPromise;
      if (!body) {
        throw new LiveFetchUnavailableError(
          "Eurostar returned no fare payload — the search may have been blocked or the route isn't served.",
          { source: this.id, reason: "upstream_timeout", source_url: url },
        );
      }

      const outbound = body.data?.journeySearch?.outbound;
      const journeys = outbound?.journeys ?? [];
      if (journeys.length === 0) {
        throw new LiveFetchUnavailableError(
          `Eurostar has no journeys for ${origin.name} → ${destination.name} on ${query.date}.`,
          { source: this.id, reason: "no_service_on_route", source_url: url },
        );
      }

      const quotes = this.#mapJourneys(journeys, { query, origin, destination, currency, url });
      if (quotes.length === 0) {
        throw new LiveFetchUnavailableError(
          `Eurostar journeys exist on ${query.date} but none had a bookable fare — likely sold out.`,
          { source: this.id, reason: "sold_out", source_url: url },
        );
      }

      // The flexible-date option: strictly better dates nearby, which a
      // single-date search would never surface. This is the value the tool adds.
      const cheapest = await cheapestPromise;
      const alt = this.#cheaperNearbyDate(cheapest, query.date, quotes);
      if (alt) {
        quotes.push(
          createQuote({
            leg: { origin: origin.name, destination: destination.name, date: alt.date },
            mode: this.mode,
            operator: this.operator,
            fare_name: "Standard (flexible date)",
            base_price: fromDecimal(alt.price, currency),
            fee_confidence: "confirmed",
            source_type: this.sourceType,
            source_url: buildSearchUrl({
              market,
              originUic: origin.uic,
              destinationUic: destination.uic,
              date: alt.date,
              adults: query.adults,
            }),
            non_obvious: {
              kind: "advance_fare",
              reason: `${alt.date} is ${alt.savingPct}% cheaper than ${query.date} on the same route.`,
            },
            caveats: [`Different date (${alt.date}), not ${query.date}.`],
          }),
        );
      }

      return quotes;
    });
  }

  #mapJourneys(
    journeys: EurostarJourney[],
    ctx: { query: FareQuery; origin: Station; destination: Station; currency: string; url: string },
  ): FareQuote[] {
    const quotes: FareQuote[] = [];

    for (const journey of journeys) {
      const timing = journey.timing;
      if (!timing) continue;
      if (!withinWindow(timing.departureTime, ctx.query)) continue;

      for (const fare of journey.fares ?? []) {
        const code = fare.classOfService?.code ?? "";
        if (!BOOKABLE_CLASSES.has(code)) continue;

        // `displayPrice` is what the site shows; 0/null means unavailable, not free.
        const amount = fare.prices?.displayPrice ?? fare.prices?.total ?? fare.prices?.adult;
        if (typeof amount !== "number" || amount <= 0) continue;
        if ((fare.seats ?? 0) <= 0) continue;

        quotes.push(
          createQuote({
            leg: {
              origin: ctx.origin.name,
              destination: ctx.destination.name,
              date: timing.date || ctx.query.date,
            },
            mode: this.mode,
            operator: this.operator,
            fare_name: fare.classOfService?.name?.replace(/^Eurostar\s+/, "") ?? code,
            base_price: fromDecimal(amount, ctx.currency),
            // Operator direct: the displayed price is the checkout price.
            fees: [],
            fee_confidence: "confirmed",
            source_type: this.sourceType,
            source_url: ctx.url,
            depart_at: `${timing.date}T${timing.departureTime}`,
            arrive_at: `${timing.date}T${timing.arrivalTime}`,
            duration_minutes: timing.duration > 0 ? timing.duration : undefined,
            changes: 0,
            caveats: (fare.seats ?? 0) <= 4 ? [`Only ${fare.seats} seats left at this fare.`] : [],
          }),
        );
      }
    }
    return quotes;
  }

  /** Cheapest nearby date, but only if it beats today's best by a margin worth mentioning. */
  #cheaperNearbyDate(
    body: CheapestFaresBody | undefined,
    date: string,
    quotes: FareQuote[],
  ): { date: string; price: number; savingPct: number } | undefined {
    const fares = body?.data?.cheapestFaresSearch?.[0]?.cheapestFares;
    if (!fares?.length) return undefined;

    const best = Math.min(...quotes.map((q) => q.total_price.minor)) / 100;
    let winner: { date: string; price: number } | undefined;
    for (const f of fares) {
      if (f.date === date || typeof f.price !== "number" || f.price <= 0) continue;
      if (!winner || f.price < winner.price) winner = { date: f.date, price: f.price };
    }
    if (!winner || winner.price >= best) return undefined;

    const savingPct = Math.round(((best - winner.price) / best) * 100);
    // Below ~10% isn't worth asking someone to move their trip.
    return savingPct >= 10 ? { ...winner, savingPct } : undefined;
  }
}

function withinWindow(departureTime: string, query: FareQuery): boolean {
  if (query.earliest_departure && departureTime < query.earliest_departure) return false;
  if (query.latest_departure && departureTime > query.latest_departure) return false;
  return true;
}
