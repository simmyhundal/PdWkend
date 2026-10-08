import type { FareQuote, TransportMode } from "@pdwkend/contracts";
import type { BrowserPool } from "./browser.js";

/**
 * The seam between "how we get a price" and "what a price is".
 *
 * Adapters are Playwright-driven today because no free fare API survives (Amadeus
 * self-service was decommissioned 2026-07-17, DB's fare endpoint bot-blocks, and
 * Eurostar's own API is partner-only). Swapping any single adapter for a paid API
 * later means implementing this interface — nothing above it changes.
 */

export interface FareQuery {
  /** Station name or code; adapters resolve against their own station list. */
  origin: string;
  destination: string;
  /** YYYY-MM-DD, local to the origin. */
  date: string;
  adults: number;
  /** ISO-4217 code to price in, for sources that can; each adapter picks its own default. */
  currency?: string;
  /** Optional filter, local 24h "HH:MM". */
  earliest_departure?: string;
  latest_departure?: string;
}

export interface FetchContext {
  browser: BrowserPool;
  signal?: AbortSignal;
  log: (msg: string) => void;
}

export interface FareSource {
  /** Stable id, used in logs and error messages. */
  readonly id: string;
  readonly operator: string;
  readonly mode: TransportMode;
  /**
   * `operator` sources are preferred and tried first; `aggregator` sources only
   * run when no operator source covers the route (hard requirement #2).
   */
  readonly sourceType: "operator" | "aggregator";
  /** Cheap, synchronous route check — no network. */
  supports(query: FareQuery): boolean;
  fetch(query: FareQuery, ctx: FetchContext): Promise<FareQuote[]>;
}

/** Operator-first ordering. Aggregators sort last regardless of registration order. */
export function orderSources(sources: FareSource[]): FareSource[] {
  return [...sources].sort((a, b) => {
    if (a.sourceType === b.sourceType) return 0;
    return a.sourceType === "operator" ? -1 : 1;
  });
}
