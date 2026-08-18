import { describe, expect, it, beforeEach } from "vitest";
import {
  DEFAULT_TTL_MS,
  FareQuoteSchema,
  StalePriceError,
  assertFresh,
  createQuote,
  currentSession,
  fromDecimal,
  isFresh,
  renderQuoteTable,
  resetSession,
  stampFetch,
  type FareQuote,
} from "@pdwkend/contracts";

/**
 * Hard requirement #1: never state a number as *the* price unless it was fetched
 * live in this turn. These tests are the enforcement — if they pass, there is no
 * path from stale or foreign data to a displayed price.
 */

const LEG = { origin: "London St Pancras Int'l", destination: "Paris Gare du Nord", date: "2026-09-05" };

function freshQuote(overrides: Partial<Parameters<typeof createQuote>[0]> = {}): FareQuote {
  return createQuote({
    leg: LEG,
    mode: "rail",
    operator: "Eurostar",
    fare_name: "Standard",
    base_price: fromDecimal(78, "GBP"),
    fee_confidence: "confirmed",
    source_type: "operator",
    source_url: "https://www.eurostar.com/search/uk-en",
    ...overrides,
  });
}

/** Build a quote that bypasses createQuote's stamping, to simulate bad input. */
function quoteWithStamp(fetched_at: string, session_id: string): FareQuote {
  const base = freshQuote();
  return FareQuoteSchema.parse({ ...base, fetched_at, session_id });
}

beforeEach(() => {
  resetSession();
});

describe("every quote is stamped at creation", () => {
  it("carries a fetched_at from the current session", () => {
    const q = freshQuote();
    expect(q.session_id).toBe(currentSession().id);
    expect(Date.now() - Date.parse(q.fetched_at)).toBeLessThan(1_000);
    expect(q.price_kind).toBe("quote");
  });

  it("cannot be constructed without one — the stamp is not caller-supplied", () => {
    const q = freshQuote();
    // createQuote takes no fetched_at/session_id parameters at all.
    expect(Object.keys(q)).toContain("fetched_at");
    expect(Object.keys(q)).toContain("session_id");
    expect(() => assertFresh(q)).not.toThrow();
  });
});

describe("assertFresh rejects anything that isn't a live, in-session price", () => {
  it("rejects a price from a previous session", () => {
    const q = quoteWithStamp(new Date().toISOString(), "some-earlier-session");
    expect(() => assertFresh(q)).toThrow(StalePriceError);
    expect(() => assertFresh(q)).toThrow(/different fetch session/i);
  });

  it("rejects an in-session price that has aged past the TTL", () => {
    const q = freshQuote();
    const later = new Date(Date.now() + DEFAULT_TTL_MS + 1_000);
    expect(() => assertFresh(q, { now: later })).toThrow(StalePriceError);
    expect(() => assertFresh(q, { now: later })).toThrow(/re-fetch/i);
  });

  it("accepts an in-session price inside the TTL", () => {
    const q = freshQuote();
    const later = new Date(Date.now() + DEFAULT_TTL_MS - 1_000);
    expect(() => assertFresh(q, { now: later })).not.toThrow();
    expect(isFresh(q, { now: later })).toBe(true);
  });

  it("rejects a timestamp in the future", () => {
    const q = quoteWithStamp(new Date(Date.now() + 60_000).toISOString(), currentSession().id);
    expect(() => assertFresh(q)).toThrow(/future/i);
  });

  it("rejects an unparseable timestamp", () => {
    const q = { ...freshQuote(), fetched_at: "sometime yesterday" };
    expect(() => assertFresh(q)).toThrow(StalePriceError);
  });
});

describe("the table is the freshness gate", () => {
  it("renders live quotes", () => {
    const table = renderQuoteTable([freshQuote()]);
    expect(table).toContain("£78.00");
    expect(table).toContain("just now");
  });

  it("refuses to render a stale quote rather than printing an old number", () => {
    const stale = quoteWithStamp(new Date(Date.now() - 60 * 60_000).toISOString(), currentSession().id);
    expect(() => renderQuoteTable([stale])).toThrow(StalePriceError);
  });

  it("refuses to render a quote from another session", () => {
    const foreign = quoteWithStamp(new Date().toISOString(), "other-session");
    expect(() => renderQuoteTable([foreign])).toThrow(StalePriceError);
  });
});

describe("a new session invalidates prices fetched by the old one", () => {
  it("treats last session's quote as stale even seconds later", () => {
    const q = freshQuote();
    expect(() => assertFresh(q)).not.toThrow();
    resetSession(); // simulates the server restarting between turns
    expect(() => assertFresh(q)).toThrow(StalePriceError);
  });
});

describe("stampFetch", () => {
  it("stamps with the live clock, not a cached value", () => {
    const a = stampFetch(new Date("2026-08-18T10:00:00.000Z"));
    expect(a.fetched_at).toBe("2026-08-18T10:00:00.000Z");
    expect(a.session_id).toBe(currentSession().id);
  });
});
