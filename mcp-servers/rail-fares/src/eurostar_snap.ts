import {
  LiveFetchUnavailableError,
  createQuote,
  fromDecimal,
  type FareQuote,
} from "@pdwkend/contracts";
import { dismissConsent, withPage } from "@pdwkend/sources";
import { loadStations, marketFor, resolveStation, type Station } from "./stations.js";
import type { FareQuery, FareSource, FetchContext } from "@pdwkend/sources";

/**
 * Eurostar Snap — the non-obvious cheap option rule #3 says not to hide.
 *
 * Snap sells a *time slot*, not a train: you pick a date and a window, and
 * Eurostar assigns your service at least 48h before departure. That trade is the
 * whole product, so every Snap quote carries it as a caveat — a £50 fare the
 * traveller can't plan around isn't a bargain if they didn't know the terms.
 *
 * Snap only sells within 14 days of travel. Outside that window there is no live
 * price to fetch, and we say so rather than estimating one (rule #1).
 */

const SNAP_MAX_DAYS_AHEAD = 14;

const CONSENT_SELECTORS = [
  'button[aria-label="Accept all cookies"]',
  'button:has-text("Accept all")',
  "#onetrust-accept-btn-handler",
];

interface SnapFare {
  seats: number | null;
  classOfService: { name: string; code: string } | null;
  prices: { displayPrice: number | null; total: number | null; adult: number | null } | null;
  legs?: { timing?: { departureTime?: string; arrivalTime?: string; duration?: number } }[];
}

interface SnapSlot {
  id: string;
  departureWindow: { earliest: string; latest: string } | null;
  /** null means that slot is sold out — not free. */
  fare: SnapFare | null;
}

interface SnapPageProps {
  outboundTimeSlots?: SnapSlot[];
  cheapestFares?: { outboundCheapestFares?: { date: string; price: number }[] | null } | null;
}

interface NextData {
  props?: { pageProps?: SnapPageProps };
}

export function daysUntil(date: string, today: Date = new Date()): number {
  const target = Date.parse(`${date}T00:00:00Z`);
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - base) / 86_400_000);
}

function isoDaysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function buildSnapUrl(params: {
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
  return `https://snap.eurostar.com/${params.market}/search?${qs.toString()}`;
}

export class EurostarSnapSource implements FareSource {
  readonly id = "eurostar-snap";
  readonly operator = "Eurostar";
  readonly mode = "rail" as const;
  readonly sourceType = "operator" as const;

  #stations: Station[] | undefined;

  supports(): boolean {
    return true;
  }

  async fetch(query: FareQuery, ctx: FetchContext): Promise<FareQuote[]> {
    const lead = daysUntil(query.date);
    if (lead > SNAP_MAX_DAYS_AHEAD) {
      throw new LiveFetchUnavailableError(
        `Snap only sells within ${SNAP_MAX_DAYS_AHEAD} days of travel; ${query.date} is ${lead} days out.`,
        {
          source: "Eurostar Snap",
          reason: "booking_window_not_open",
          retry_after: isoDaysBefore(query.date, SNAP_MAX_DAYS_AHEAD),
          source_url: "https://snap.eurostar.com",
        },
      );
    }
    if (lead < 0) {
      throw new LiveFetchUnavailableError(`${query.date} is in the past.`, {
        source: "Eurostar Snap",
        reason: "no_service_on_route",
      });
    }

    this.#stations ??= await loadStations(ctx.browser);
    const origin = resolveStation(query.origin, this.#stations).station;
    const destination = resolveStation(query.destination, this.#stations).station;
    const { market, currency } = marketFor(origin);

    const url = buildSnapUrl({
      market,
      originUic: origin.uic,
      destinationUic: destination.uic,
      date: query.date,
      adults: query.adults,
    });
    ctx.log(`snap: ${origin.name} → ${destination.name} on ${query.date}`);

    return withPage(ctx.browser, this.id, url, async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await dismissConsent(page, CONSENT_SELECTORS);

      // On a direct navigation Next.js inlines the payload rather than fetching
      // search.json, so read it from the page instead of intercepting a request.
      const props = await page
        .evaluate(() => (globalThis as unknown as { __NEXT_DATA__?: NextData }).__NEXT_DATA__?.props?.pageProps)
        .catch(() => undefined);

      const slots = (props as SnapPageProps | undefined)?.outboundTimeSlots ?? [];
      if (slots.length === 0) {
        throw new LiveFetchUnavailableError(
          `Snap returned no time slots for ${origin.name} → ${destination.name} on ${query.date}.`,
          { source: "Eurostar Snap", reason: "no_service_on_route", source_url: url },
        );
      }

      const quotes: FareQuote[] = [];
      for (const slot of slots) {
        const price = slot.fare?.prices?.displayPrice ?? slot.fare?.prices?.total ?? slot.fare?.prices?.adult;
        if (typeof price !== "number" || price <= 0) continue; // null fare = sold out

        const window = slot.departureWindow;
        const earliest = window?.earliest?.slice(11, 16);
        const latest = window?.latest?.slice(11, 16);
        if (!withinWindow(earliest, query)) continue;

        const windowText = earliest && latest ? `${earliest}–${latest}` : "the chosen slot";
        quotes.push(
          createQuote({
            leg: { origin: origin.name, destination: destination.name, date: query.date },
            mode: this.mode,
            operator: this.operator,
            fare_name: `Snap ${windowText}`,
            base_price: fromDecimal(price, currency),
            fees: [],
            fee_confidence: "confirmed",
            source_type: this.sourceType,
            source_url: url,
            depart_at: window?.earliest?.replace(" ", "T"),
            duration_minutes: slot.fare?.legs?.[0]?.timing?.duration ?? undefined,
            non_obvious: {
              kind: "snap",
              reason: `Snap fare — up to 50% below the standard fare for the same day.`,
            },
            caveats: [
              `You pick the ${windowText} window, not the train; Eurostar assigns your service at least 48h before departure.`,
              "Non-exchangeable, non-refundable.",
              ...((slot.fare?.seats ?? 0) > 0 && (slot.fare?.seats ?? 0) <= 4
                ? [`Only ${slot.fare?.seats} seats left in this slot.`]
                : []),
            ],
          }),
        );
      }

      if (quotes.length === 0) {
        throw new LiveFetchUnavailableError(
          `All Snap slots for ${query.date} are sold out.`,
          { source: "Eurostar Snap", reason: "sold_out", source_url: url },
        );
      }
      return quotes;
    });
  }
}

function withinWindow(departure: string | undefined, query: FareQuery): boolean {
  if (!departure) return true;
  if (query.earliest_departure && departure < query.earliest_departure) return false;
  if (query.latest_departure && departure > query.latest_departure) return false;
  return true;
}
