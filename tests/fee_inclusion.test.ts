import { describe, expect, it, beforeEach } from "vitest";
import {
  FareQuoteSchema,
  FeeInclusionError,
  addMoney,
  createQuote,
  formatMoney,
  fromDecimal,
  money,
  renderNotes,
  renderPrice,
  resetSession,
  type Fee,
} from "@pdwkend/contracts";
import {
  EXAMPLE_OMIO_FEE,
  quoteFromListing,
  resolveAggregatorPrice,
  type AggregatorListing,
} from "@pdwkend/rail-fares-mcp/src/aggregator.js";

/**
 * Hard requirement #2, reconstructed from the original failure: an Omio fare was
 * quoted at its pre-fee price, omitting the ~€7 booking fee, from a reseller that
 * shouldn't have been the default source in the first place.
 */

const LEG = { origin: "Paris", destination: "Amsterdam", date: "2026-09-05" };

beforeEach(() => {
  resetSession();
});

function listing(overrides: Partial<AggregatorListing> = {}): AggregatorListing {
  return {
    vendor: "Omio",
    base: fromDecimal(89, "EUR"),
    disclosedFees: [],
    totalIsCheckoutReady: false,
    sourceUrl: "https://www.omio.com/search",
    operator: "Thalys",
    ...overrides,
  };
}

describe("the arithmetic must hold", () => {
  it("derives total from base + fees so a fee cannot go missing", () => {
    const q = createQuote({
      leg: LEG,
      mode: "rail",
      operator: "Thalys",
      fare_name: "via Omio",
      base_price: fromDecimal(89, "EUR"),
      fees: [EXAMPLE_OMIO_FEE()],
      fee_confidence: "confirmed",
      source_type: "aggregator",
      source_url: "https://www.omio.com/search",
    });
    expect(q.total_price).toEqual(money(9600, "EUR"));
    expect(formatMoney(q.total_price)).toBe("€96.00");
  });

  it("rejects a hand-built quote whose total omits the fee", () => {
    const bad = {
      quote_id: "x",
      price_kind: "quote",
      leg: LEG,
      mode: "rail",
      operator: "Thalys",
      fare_name: "via Omio",
      base_price: money(8900, "EUR"),
      fees: [EXAMPLE_OMIO_FEE()],
      total_price: money(8900, "EUR"), // the bug: pre-fee number presented as the total
      fee_confidence: "confirmed",
      source_type: "aggregator",
      source_url: "https://www.omio.com/search",
      fetched_at: new Date().toISOString(),
      session_id: "s",
      caveats: [],
      booking_status: "unbooked",
    };
    const parsed = FareQuoteSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/a fee is missing from the displayed total/i);
  });

  it("refuses to mix currencies between fare and fee", () => {
    const mixed: Fee = { kind: "booking", label: "fee", amount: money(700, "GBP") };
    expect(() =>
      createQuote({
        leg: LEG,
        mode: "rail",
        operator: "Thalys",
        fare_name: "via Omio",
        base_price: fromDecimal(89, "EUR"),
        fees: [mixed],
        fee_confidence: "confirmed",
        source_type: "aggregator",
        source_url: "https://www.omio.com/search",
      }),
    ).toThrow();
  });

  it("adds money in minor units without float drift", () => {
    const total = addMoney(fromDecimal(8.9, "EUR"), fromDecimal(0.7, "EUR"));
    expect(total.minor).toBe(960);
    expect(formatMoney(total)).toBe("€9.60");
  });
});

describe("an aggregator that discloses no fee cannot claim it has none", () => {
  it("marks undisclosed fees unconfirmed rather than assuming zero", () => {
    const resolved = resolveAggregatorPrice(listing());
    expect(resolved.feeConfidence).toBe("unconfirmed");
    expect(resolved.fees).toHaveLength(0);
    expect(resolved.feeNote).toMatch(/did not disclose/i);
  });

  it("rejects the schema-level claim of confirmed-with-no-fees for an aggregator", () => {
    expect(() =>
      createQuote({
        leg: LEG,
        mode: "rail",
        operator: "Thalys",
        fare_name: "via Omio",
        base_price: fromDecimal(89, "EUR"),
        fees: [],
        fee_confidence: "confirmed",
        source_type: "aggregator",
        source_url: "https://www.omio.com/search",
      }),
    ).toThrow(FeeInclusionError);
  });

  it("allows confirmed-with-no-fees for an operator, where the price is the checkout price", () => {
    const q = createQuote({
      leg: LEG,
      mode: "rail",
      operator: "Eurostar",
      fare_name: "Standard",
      base_price: fromDecimal(78, "GBP"),
      fees: [],
      fee_confidence: "confirmed",
      source_type: "operator",
      source_url: "https://www.eurostar.com/search/uk-en",
    });
    expect(q.fee_confidence).toBe("confirmed");
  });

  it("accepts confirmed when the fee is itemised", () => {
    const resolved = resolveAggregatorPrice(listing({ disclosedFees: [EXAMPLE_OMIO_FEE()] }));
    expect(resolved.feeConfidence).toBe("confirmed");
    expect(resolved.fees).toHaveLength(1);
  });

  it("accepts confirmed when the page showed a checkout-ready total", () => {
    const resolved = resolveAggregatorPrice(listing({ totalIsCheckoutReady: true }));
    expect(resolved.feeConfidence).toBe("confirmed");
  });
});

describe("display never presents an unverified number as final", () => {
  it("shows 'before fees' instead of a total when fees are unconfirmed", () => {
    const q = quoteFromListing(listing(), { ...LEG, adults: 1 });
    expect(q.fee_confidence).toBe("unconfirmed");
    expect(renderPrice(q)).toBe("€89.00 before fees");
    expect(renderPrice(q)).not.toMatch(/^€89\.00$/);
  });

  it("breaks out base + fee when the fee is known", () => {
    const q = quoteFromListing(listing({ disclosedFees: [EXAMPLE_OMIO_FEE()] }), { ...LEG, adults: 1 });
    expect(renderPrice(q)).toBe("€96.00 (€89.00 + €7.00 fee)");
  });

  it("footnotes the unconfirmed fee so it is stated, not just implied", () => {
    const q = quoteFromListing(listing(), { ...LEG, adults: 1 });
    const notes = renderNotes([q]);
    expect(notes.join(" ")).toMatch(/check the total at checkout/i);
  });

  it("warns that a reseller was used instead of the operator", () => {
    const q = quoteFromListing(listing(), { ...LEG, adults: 1 });
    expect(q.caveats.join(" ")).toMatch(/not Thalys directly/i);
    expect(q.source_type).toBe("aggregator");
  });
});

describe("resolveAggregatorPrice guards its inputs", () => {
  it("rejects a non-positive base fare", () => {
    expect(() => resolveAggregatorPrice(listing({ base: money(0, "EUR") }))).toThrow(FeeInclusionError);
  });

  it("rejects a fee quoted in a different currency from the fare", () => {
    const badFee: Fee = { kind: "booking", label: "fee", amount: money(700, "GBP") };
    expect(() => resolveAggregatorPrice(listing({ disclosedFees: [badFee] }))).toThrow(/cannot form a reliable total/i);
  });
});
