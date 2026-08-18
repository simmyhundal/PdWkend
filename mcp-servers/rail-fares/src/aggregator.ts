import {
  FeeInclusionError,
  LiveFetchUnavailableError,
  createQuote,
  fromDecimal,
  money,
  type Fee,
  type FareQuote,
  type Money,
} from "@pdwkend/contracts";
import type { FareQuery, FareSource, FetchContext } from "@pdwkend/sources";

/**
 * Aggregator fallback — the Omio case from the brief.
 *
 * The original failure was quoting an Omio fare without its ~€7 booking fee, and
 * defaulting to a reseller when the operator sold the same seat directly. Rule #2
 * addresses both: aggregators run only when no operator adapter covers the route
 * (enforced by `orderSources` in the registry), and any aggregator price must be
 * resolved to a fee-inclusive total before it can be displayed.
 *
 * `resolveAggregatorPrice` below is the enforcement point and is fully live and
 * tested. The scraper that feeds it is intentionally not implemented: every route
 * Paddy Weekend covers today has an operator adapter, so wiring a reseller now
 * would add a fragile dependency that rule #2 says to avoid using anyway. When a
 * route genuinely needs one, implement `fetchListing` and the fee maths already
 * holds.
 */

export interface AggregatorListing {
  vendor: string;
  /** Fare before the aggregator's own fees, as displayed in search results. */
  base: Money;
  /**
   * Fees the vendor disclosed. An empty array means "we found none", which is
   * treated as *unknown*, not zero — resellers routinely defer fees to checkout.
   */
  disclosedFees: Fee[];
  /**
   * True only when the page states a checkout-ready total (e.g. a basket/summary
   * view). Search-results pages almost never qualify.
   */
  totalIsCheckoutReady: boolean;
  sourceUrl: string;
  operator: string;
  departAt?: string;
  arriveAt?: string;
  durationMinutes?: number;
  changes?: number;
}

export interface ResolvedAggregatorPrice {
  base: Money;
  fees: Fee[];
  feeConfidence: "confirmed" | "unconfirmed";
  feeNote?: string;
}

/**
 * Turns a reseller listing into something displayable, or refuses.
 *
 * Three outcomes, and only three:
 *   - fees itemised            → confirmed, total = base + fees
 *   - checkout-ready total     → confirmed, no separate fee line
 *   - neither                  → unconfirmed, and the renderer shows
 *                                "X before fees" instead of a total
 *
 * There is no branch that guesses a fee, because a guessed fee reads exactly like
 * a real one once it's in a table.
 */
export function resolveAggregatorPrice(listing: AggregatorListing): ResolvedAggregatorPrice {
  if (listing.base.minor <= 0) {
    throw new FeeInclusionError(`${listing.vendor} returned a non-positive base fare.`, {
      vendor: listing.vendor,
    });
  }

  if (listing.disclosedFees.length > 0) {
    const mismatched = listing.disclosedFees.find((f) => f.amount.currency !== listing.base.currency);
    if (mismatched) {
      throw new FeeInclusionError(
        `${listing.vendor} quoted a ${mismatched.amount.currency} fee against a ${listing.base.currency} fare; ` +
          `cannot form a reliable total.`,
        { vendor: listing.vendor },
      );
    }
    return { base: listing.base, fees: listing.disclosedFees, feeConfidence: "confirmed" };
  }

  if (listing.totalIsCheckoutReady) {
    return { base: listing.base, fees: [], feeConfidence: "confirmed" };
  }

  return {
    base: listing.base,
    fees: [],
    feeConfidence: "unconfirmed",
    feeNote: `${listing.vendor} did not disclose its booking fee on this page`,
  };
}

/** Build a quote from a listing, with the fee position already resolved. */
export function quoteFromListing(listing: AggregatorListing, query: FareQuery): FareQuote {
  const resolved = resolveAggregatorPrice(listing);
  return createQuote({
    leg: { origin: query.origin, destination: query.destination, date: query.date },
    mode: "rail",
    operator: listing.operator,
    fare_name: `via ${listing.vendor}`,
    base_price: resolved.base,
    fees: resolved.fees,
    fee_confidence: resolved.feeConfidence,
    fee_note: resolved.feeNote,
    source_type: "aggregator",
    source_url: listing.sourceUrl,
    depart_at: listing.departAt,
    arrive_at: listing.arriveAt,
    duration_minutes: listing.durationMinutes,
    changes: listing.changes,
    caveats: [
      `Booked through ${listing.vendor}, not ${listing.operator} directly — check the operator's own site before paying.`,
    ],
  });
}

/** Convenience for adapters that read a fee off the page. */
export function detectedBookingFee(amountDecimal: number, currency: string, vendor: string): Fee {
  return {
    kind: "booking",
    label: `${vendor} booking fee`,
    amount: fromDecimal(amountDecimal, currency),
  };
}

export class AggregatorSource implements FareSource {
  readonly id = "aggregator";
  readonly operator = "Various";
  readonly mode = "rail" as const;
  readonly sourceType = "aggregator" as const;

  supports(): boolean {
    return true;
  }

  async fetch(query: FareQuery, ctx: FetchContext): Promise<FareQuote[]> {
    const listings = await this.fetchListing(query, ctx);
    return listings.map((l) => quoteFromListing(l, query));
  }

  /**
   * Implement this to add a reseller. Return listings with whatever fee data the
   * page actually disclosed — `resolveAggregatorPrice` decides how to present it.
   */
  protected async fetchListing(_query: FareQuery, _ctx: FetchContext): Promise<AggregatorListing[]> {
    throw new LiveFetchUnavailableError(
      "No aggregator adapter is configured. Every supported route currently has an " +
        "operator adapter, which rule #2 prefers anyway.",
      { source: "aggregator", reason: "not_configured" },
    );
  }
}

/** Exported for tests: the €7 Omio fee from the brief, as a worked example. */
export const EXAMPLE_OMIO_FEE = (currency = "EUR"): Fee => ({
  kind: "booking",
  label: "Omio booking fee",
  amount: money(700, currency),
});
