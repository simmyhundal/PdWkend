import type { Page } from "playwright";
import { LiveFetchUnavailableError } from "@pdwkend/contracts";
import { withPage, dismissConsent, type BrowserPool } from "@pdwkend/sources";

/**
 * Eurostar station index, sourced from Eurostar's own `getStations` GraphQL call.
 *
 * Fetching the list beats hardcoding 236 UIC codes that would rot silently — a
 * wrong UIC produces a confidently wrong route rather than a visible failure.
 * The seeds below are the two busiest pairs, verified against a live response,
 * so the common London↔Paris query never pays for the index load.
 */

export interface Station {
  uic: string;
  name: string;
  city: string;
  country: string;
  countryCode: string;
  isEurostarDirect: boolean;
}

const SEED: Station[] = [
  { uic: "7015400", name: "London St Pancras Int'l", city: "London", country: "United Kingdom", countryCode: "GBR", isEurostarDirect: true },
  { uic: "8727100", name: "Paris Gare du Nord", city: "Paris", country: "France", countryCode: "FRA", isEurostarDirect: true },
  { uic: "8814001", name: "Brussels Midi / Zuid", city: "Brussels", country: "Belgium", countryCode: "BEL", isEurostarDirect: true },
  { uic: "8722326", name: "Lille Europe", city: "Lille", country: "France", countryCode: "FRA", isEurostarDirect: true },
];

const STATIONS_URL = "https://www.eurostar.com/uk-en";

let index: Station[] | undefined;
let loading: Promise<Station[]> | undefined;

function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Loads the full list once per process, falling back to seeds if the page misbehaves. */
export async function loadStations(pool: BrowserPool): Promise<Station[]> {
  if (index) return index;
  loading ??= withPage(pool, "eurostar-stations", STATIONS_URL, async (page: Page) => {
    const captured = waitForStations(page);
    await page.goto(STATIONS_URL, { waitUntil: "domcontentloaded" });
    await dismissConsent(page, [
      'button[aria-label="Accept all cookies"]',
      'button:has-text("Accept all")',
      "#onetrust-accept-btn-handler",
    ]);
    const stations = await captured;
    index = stations.length ? stations : SEED;
    return index;
  }).catch(() => {
    // A station-list failure shouldn't sink a London–Paris query.
    index = SEED;
    return index;
  });
  return loading;
}

function waitForStations(page: Page): Promise<Station[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), 25_000);
    page.on("response", async (res) => {
      if (!res.url().includes("/search/stations/graphql")) return;
      try {
        const body = (await res.json()) as { data?: { stations?: Station[] } };
        const list = body?.data?.stations;
        if (Array.isArray(list) && list.length) {
          clearTimeout(timer);
          resolve(list);
        }
      } catch {
        // Keep waiting; another response may carry it.
      }
    });
  });
}

export interface ResolveResult {
  station: Station;
  /** True when the match was exact, so callers can mention the assumption if not. */
  exact: boolean;
}

/**
 * Resolve free text ("Paris", "London St Pancras", "8727100") to a station.
 * Prefers Eurostar-direct stations so "Paris" lands on Gare du Nord rather than
 * an obscure connected station.
 */
export function resolveStation(query: string, stations: Station[]): ResolveResult {
  const q = normalise(query);
  if (/^\d{7}$/.test(query.trim())) {
    const byUic = stations.find((s) => s.uic === query.trim());
    if (byUic) return { station: byUic, exact: true };
  }

  const score = (s: Station): number => {
    const name = normalise(s.name);
    const city = normalise(s.city);
    if (name === q || city === q) return 100;
    if (name.startsWith(q) || city.startsWith(q)) return 80;
    if (name.includes(q) || city.includes(q)) return 60;
    if (q.includes(city) && city.length > 3) return 50;
    return 0;
  };

  const ranked = stations
    .map((s) => ({ s, score: score(s) + (s.isEurostarDirect ? 5 : 0) }))
    .filter((r) => r.score > 5)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) {
    throw new LiveFetchUnavailableError(`No Eurostar station matches "${query}".`, {
      source: "eurostar",
      reason: "no_service_on_route",
    });
  }
  return { station: best.s, exact: best.score >= 100 };
}

/** Market segment of the URL, which also fixes the currency Eurostar quotes in. */
export function marketFor(origin: Station): { market: string; currency: string } {
  switch (origin.countryCode) {
    case "GBR":
      return { market: "uk-en", currency: "GBP" };
    case "FRA":
      return { market: "fr-en", currency: "EUR" };
    case "BEL":
      return { market: "be-en", currency: "EUR" };
    case "NLD":
      return { market: "nl-en", currency: "EUR" };
    case "DEU":
      return { market: "de-en", currency: "EUR" };
    default:
      return { market: "uk-en", currency: "GBP" };
  }
}
