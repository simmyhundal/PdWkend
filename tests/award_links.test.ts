import { describe, expect, it } from "vitest";
import {
  AWARD_PROGRAMS,
  buildAwardCheckLinks,
  renderAwardCheckTable,
  type AwardCheckQuery,
} from "@pdwkend/flight-fares-mcp/src/award_links.js";

const q: AwardCheckQuery = {
  origin: "lhr",
  destination: "JFK",
  date: "2026-12-01",
  adults: 2,
  cabin: "business",
};

describe("buildAwardCheckLinks", () => {
  it("returns one link per program by default", () => {
    expect(buildAwardCheckLinks(q).map((l) => l.program)).toEqual([...AWARD_PROGRAMS]);
  });

  it("limits to the requested programs", () => {
    expect(buildAwardCheckLinks(q, ["united"]).map((l) => l.program)).toEqual(["united"]);
  });

  it("prefills united with codes, date, party and the money+miles flag", () => {
    const url = new URL(buildAwardCheckLinks(q, ["united"])[0]!.url);
    expect(url.searchParams.get("f")).toBe("LHR");
    expect(url.searchParams.get("t")).toBe("JFK");
    expect(url.searchParams.get("d")).toBe("2026-12-01");
    expect(url.searchParams.get("px")).toBe("2");
    expect(url.searchParams.get("mm")).toBe("1");
  });

  it("builds the browser-confirmed united economy URL for SFO-ATL on 2027-01-01", () => {
    const [l] = buildAwardCheckLinks(
      { origin: "SFO", destination: "ATL", date: "2027-01-01", adults: 1, cabin: "economy" },
      ["united"],
    );
    const got = new URL(l!.url);
    // Parameter set copied from a working united.com money+miles results URL.
    const confirmed = new URL(
      "https://www.united.com/en/us/fsr/choose-flights?tt=1&st=bestmatches&d=2027-01-01&clm=7&taxng=1&f=SFO&px=1&sc=7&tqp=R&t=ATL&mm=1",
    );
    expect(got.origin + got.pathname).toBe(confirmed.origin + confirmed.pathname);
    for (const key of ["tt", "d", "clm", "taxng", "f", "px", "sc", "tqp", "t", "mm"]) {
      expect(got.searchParams.get(key), key).toBe(confirmed.searchParams.get(key));
    }
    expect(l!.prefill).toBe("verified");
  });

  it("keeps united non-economy cabins unverified", () => {
    expect(buildAwardCheckLinks(q, ["united"])[0]!.prefill).toBe("unverified");
  });

  it("url-encodes free-text places", () => {
    const [l] = buildAwardCheckLinks({ ...q, origin: "New York", destination: "São Paulo" }, ["alaska"]);
    expect(new URL(l!.url).searchParams.get("O")).toBe("New York");
    expect(new URL(l!.url).searchParams.get("D")).toBe("São Paulo");
  });

  it("gives flying blue as search-page-only, with login and miles guidance", () => {
    const [l] = buildAwardCheckLinks(q, ["flying_blue"]);
    expect(l!.prefill).toBe("none");
    expect(l!.url).not.toContain("?");
    expect(l!.url).toBe("https://www.klm.com/search/advanced");
    expect(l!.enter).toContain("Book with my");
  });

  it("marks unknown-prefill programs as search-page-only and lists what to enter", () => {
    const [l] = buildAwardCheckLinks(q, ["flying_blue"]);
    expect(l!.prefill).toBe("none");
    expect(l!.enter).toContain("LHR → JFK");
    expect(l!.enter).toContain("2 adults");
    expect(l!.enter).toContain("business");
  });

  it("builds the browser-confirmed alaska URL for SFO-ATL on 2027-01-01", () => {
    const [l] = buildAwardCheckLinks(
      { origin: "SFO", destination: "ATL", date: "2027-01-01", adults: 1, cabin: "economy" },
      ["alaska"],
    );
    expect(l!.url).toBe(
      "https://www.alaskaair.com/search/results?A=1&C=0&L=0&O=SFO&D=ATL&OD=2027-01-01&RT=false&ShoppingMethod=onlineaward",
    );
    expect(l!.prefill).toBe("verified");
  });

  it("does not claim verification for programs that haven't been checked", () => {
    for (const l of buildAwardCheckLinks(q, ["delta", "american", "flying_blue"])) {
      expect(l.prefill).not.toBe("verified");
    }
  });

  it("renders a table and contains no points figures", () => {
    const table = renderAwardCheckTable(buildAwardCheckLinks(q));
    expect(table).toContain("Open award search");
    expect(table).not.toMatch(/\d[\d,]*\s*(pts|points|miles|avios)/i);
  });
});
