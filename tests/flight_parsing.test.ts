import { describe, expect, it } from "vitest";
import {
  addDays,
  buildFlightsUrl,
  parseFlightRow,
  splitCarriers,
} from "@pdwkend/flight-fares-mcp/src/google_flights.js";

/**
 * Row parsing is the most brittle code in the repo — it reads rendered text from
 * a page that can be restyled at any time. These cases are real rows captured
 * from Google Flights; if a change to the parser breaks one, the adapter would
 * have started dropping or misreading fares silently.
 */

const REAL_ROWS = {
  nonstop: "5:35 PM – 7:55 PM Air France 1 hr 20 min LHR–CDG Nonstop 57 kg CO2e Avg emissions €77",
  budget: "4:30 PM – 6:50 PM easyJet 1 hr 20 min LGW–CDG Nonstop 57 kg CO2e £38",
  codeshare:
    "3:00 PM – 5:35 PM VuelingIberia, British Airways 1 hr 35 min LHR–ORY Nonstop 47 kg CO2e £44",
  connecting:
    "6:40 AM – 8:25 PM Scandinavian AirlinesOperated by Sas Connect, Sas Connect 12 hr 45 min LHR–CDG 1 stop 7 hr 45 min ARN 245 kg CO2e +338% emissions €181",
};

describe("parseFlightRow reads real rows", () => {
  it("parses a nonstop row", () => {
    const r = parseFlightRow(REAL_ROWS.nonstop)!;
    expect(r.airline).toBe("Air France");
    expect(r.departTime).toBe("17:35");
    expect(r.arriveTime).toBe("19:55");
    expect(r.durationMinutes).toBe(80);
    expect(r.stops).toBe(0);
    expect(r.originCode).toBe("LHR");
    expect(r.destinationCode).toBe("CDG");
    expect(r.priceMinor).toBe(7700);
    expect(r.currency).toBe("EUR");
  });

  it("keeps a brand with an internal capital intact", () => {
    expect(parseFlightRow(REAL_ROWS.budget)!.airline).toBe("easyJet");
  });

  it("separates glued codeshare carriers", () => {
    expect(parseFlightRow(REAL_ROWS.codeshare)!.airline).toBe("Vueling, Iberia, British Airways");
  });

  it("takes the journey duration, not the layover, on a connecting itinerary", () => {
    const r = parseFlightRow(REAL_ROWS.connecting)!;
    // 12h45 total, not the 7h45 layover that appears later in the same row.
    expect(r.durationMinutes).toBe(765);
    expect(r.stops).toBe(1);
    expect(r.airline).toBe("Scandinavian Airlines");
  });

  it("takes the price from the end of the row, not an emissions figure", () => {
    expect(parseFlightRow(REAL_ROWS.connecting)!.priceMinor).toBe(18100);
  });
});

describe("parseFlightRow rejects rather than guesses", () => {
  it("returns undefined when there are no times", () => {
    expect(parseFlightRow("Some promo banner £99")).toBeUndefined();
  });

  it("returns undefined when there is no price", () => {
    expect(parseFlightRow("5:35 PM – 7:55 PM Air France 1 hr 20 min LHR–CDG Nonstop")).toBeUndefined();
  });

  it("returns undefined when there is no duration", () => {
    expect(parseFlightRow("5:35 PM – 7:55 PM Air France LHR–CDG £77")).toBeUndefined();
  });

  it("returns undefined on a zero price rather than reporting a free flight", () => {
    expect(parseFlightRow("5:35 PM – 7:55 PM Air France 1 hr 20 min LHR–CDG Nonstop £0")).toBeUndefined();
  });
});

describe("time normalisation", () => {
  it("converts 12-hour times so they sort as strings", () => {
    expect(parseFlightRow("12:05 AM – 6:00 AM BA 5 hr 55 min A–B Nonstop £10")!.departTime).toBe("00:05");
    expect(parseFlightRow("12:30 PM – 1:00 PM BA 30 min A–B Nonstop £10")!.departTime).toBe("12:30");
  });

  it("handles a minutes-only duration", () => {
    expect(parseFlightRow("12:30 PM – 1:00 PM BA 30 min A–B Nonstop £10")!.durationMinutes).toBe(30);
  });
});

describe("currency comes from the symbol on the page", () => {
  it.each([
    ["£38", "GBP"],
    ["€77", "EUR"],
    ["$120", "USD"],
  ])("reads %s as %s", (price, currency) => {
    const r = parseFlightRow(`4:30 PM – 6:50 PM easyJet 1 hr 20 min LGW–CDG Nonstop ${price}`)!;
    expect(r.currency).toBe(currency);
  });

  it("handles thousands separators and decimals", () => {
    const r = parseFlightRow("4:30 PM – 6:50 PM BA 1 hr 20 min A–B Nonstop £1,234.56")!;
    expect(r.priceMinor).toBe(123456);
  });
});

describe("splitCarriers", () => {
  it.each([
    ["easyJet", "easyJet"],
    ["Air France", "Air France"],
    ["British Airways", "British Airways"],
    ["VuelingIberia", "Vueling, Iberia"],
    ["LATAMDelta", "LATAM, Delta"],
    ["COPAUnited", "COPA, United"],
    ["Delta, LATAM", "Delta, LATAM"],
    ["LATAM Airlines", "LATAM Airlines"],
    ["SAS", "SAS"],
    ["easyJetLATAM", "easyJet, LATAM"],
  ])("%s → %s", (input, expected) => {
    expect(splitCarriers(input)).toBe(expected);
  });
});

describe("buildFlightsUrl", () => {
  it("encodes the search so Google resolves the places itself", () => {
    const url = buildFlightsUrl({ origin: "London", destination: "Paris", date: "2026-09-05", adults: 1 });
    expect(url).toContain("google.com/travel/flights");
    // URLSearchParams encodes spaces as "+", which only the query parser undoes.
    const q = new URL(url).searchParams.get("q");
    expect(q).toBe("Flights to Paris from London on 2026-09-05 oneway");
  });
});

describe("overnight arrivals", () => {
  it("reads the +1 day marker and keeps it out of the carrier name", () => {
    const r = parseFlightRow("9:28 PM – 5:07 AM+1 Delta 4 hr 39 min SFO–ATL Nonstop 174 kg CO2e $224")!;
    expect(r.arriveDayOffset).toBe(1);
    expect(r.arriveTime).toBe("05:07");
    expect(r.airline).toBe("Delta");
  });

  it("tolerates whitespace around the marker", () => {
    const r = parseFlightRow("7:05 PM – 6:40 AM +1 Delta 9 hr 35 min ATL–SCL Nonstop $1,100")!;
    expect(r.arriveDayOffset).toBe(1);
    expect(r.airline).toBe("Delta");
  });

  it("is zero for a same-day arrival", () => {
    expect(parseFlightRow(REAL_ROWS.nonstop)!.arriveDayOffset).toBe(0);
  });
});

describe("addDays", () => {
  it.each([
    ["2027-01-01", 0, "2027-01-01"],
    ["2027-01-01", 1, "2027-01-02"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2027-02-28", 1, "2027-03-01"],
    ["2026-03-28", 2, "2026-03-30"],
  ])("%s + %i days = %s", (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});

describe("pricing currency", () => {
  const base = { origin: "SFO", destination: "ATL", date: "2027-01-01", adults: 1 };

  it("defaults the search to USD", () => {
    expect(new URL(buildFlightsUrl(base)).searchParams.get("curr")).toBe("USD");
  });

  it("honours a requested currency, case-insensitively", () => {
    expect(new URL(buildFlightsUrl({ ...base, currency: "gbp" })).searchParams.get("curr")).toBe("GBP");
  });

  it("labels a $ fare with the requested dollar currency", () => {
    const row = "4:30 PM – 6:50 PM Air Canada 5 hr 20 min SFO–YYZ Nonstop $412";
    expect(parseFlightRow(row, "CAD")!.currency).toBe("CAD");
    expect(parseFlightRow(row, "USD")!.currency).toBe("USD");
  });

  it("does not relabel a non-dollar symbol to the requested currency", () => {
    const row = "4:30 PM – 6:50 PM easyJet 1 hr 20 min LGW–CDG Nonstop £38";
    expect(parseFlightRow(row, "USD")!.currency).toBe("GBP");
  });
});

describe("ATL–SCL overnight rows (captured 2026-10-04, before the +1 fix)", () => {
  // The live run reported operators "+1 Delta, LATAM" and "+1 United, COPA", so the
  // marker follows the arrival time directly. Prices and CO2 are reconstructed.
  const departing = "2026-12-31";

  it("lands the nonstop on 1 Jan and names the carriers cleanly", () => {
    const r = parseFlightRow("7:05 PM – 6:40 AM+1 Delta, LATAM 9 hr 35 min ATL–SCL Nonstop 331 kg CO2e $866")!;
    expect(r.airline).toBe("Delta, LATAM");
    expect(r.durationMinutes).toBe(575);
    expect(addDays(departing, r.arriveDayOffset)).toBe("2027-01-01");
  });

  it("handles the 2-stop that leaves in the morning and still lands next day", () => {
    const r = parseFlightRow("7:00 AM – 2:53 AM+1 United, COPA 17 hr 53 min ATL–SCL 2 stops 540 kg CO2e $1,071")!;
    expect(r.airline).toBe("United, COPA");
    expect(r.stops).toBe(2);
    expect(r.arriveDayOffset).toBe(1);
  });
});

describe("all-caps carrier glued to the next", () => {
  it("separates them in a full row, as seen on ATL–SCL", () => {
    const r = parseFlightRow("10:15 PM – 3:00 PM+1 LATAMDelta 14 hr 45 min ATL–SCL 1 stop 3 hr ... GRU $1,100")!;
    expect(r.airline).toBe("LATAM, Delta");
    expect(r.arriveDayOffset).toBe(1);
  });
});
