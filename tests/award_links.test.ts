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

  it("prefills united with codes, date, party and the award flag", () => {
    const url = new URL(buildAwardCheckLinks(q, ["united"])[0]!.url);
    expect(url.searchParams.get("f")).toBe("LHR");
    expect(url.searchParams.get("t")).toBe("JFK");
    expect(url.searchParams.get("d")).toBe("2026-12-01");
    expect(url.searchParams.get("px")).toBe("2");
    expect(url.searchParams.get("tqp")).toBe("A");
  });

  it("url-encodes free-text places", () => {
    const [l] = buildAwardCheckLinks({ ...q, origin: "New York", destination: "São Paulo" }, ["alaska"]);
    expect(new URL(l!.url).searchParams.get("O")).toBe("New York");
    expect(new URL(l!.url).searchParams.get("D")).toBe("São Paulo");
  });

  it("marks unknown-prefill programs as search-page-only and lists what to enter", () => {
    const [l] = buildAwardCheckLinks(q, ["flying_blue"]);
    expect(l!.prefill).toBe("none");
    expect(l!.enter).toContain("LHR → JFK");
    expect(l!.enter).toContain("2 adults");
    expect(l!.enter).toContain("business");
  });

  it("never claims an unconfirmed link format is verified", () => {
    for (const l of buildAwardCheckLinks(q)) expect(l.prefill).not.toBe("verified");
  });

  it("renders a table and contains no points figures", () => {
    const table = renderAwardCheckTable(buildAwardCheckLinks(q));
    expect(table).toContain("Open award search");
    expect(table).not.toMatch(/\d[\d,]*\s*(pts|points|miles|avios)/i);
  });
});
