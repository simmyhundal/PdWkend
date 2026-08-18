import { describe, expect, it, beforeEach } from "vitest";
import {
  HEADERS,
  ITINERARY_COLUMNS,
  createQuote,
  fromDecimal,
  itineraryKey,
  resetSession,
  rowFromQuote,
  rowToValues,
  type ItineraryRow,
} from "@pdwkend/contracts";
import { LAST_COLUMN, columnLetter, planUpsert } from "@pdwkend/sheets-writer-mcp/src/upsert_plan.js";

/**
 * Hard requirement #4: writing into the user's *existing* spreadsheet, idempotently.
 *
 * The acceptance criterion is that re-running a search updates rows rather than
 * appending duplicates, so these tests drive planUpsert — the part that decides
 * new-vs-existing — against a simulated key column.
 */

const LEG = { origin: "London St Pancras Int'l", destination: "Paris Gare du Nord", date: "2026-09-05" };
const TRIP = "paris-sep-2026";

beforeEach(() => {
  resetSession();
});

function quote(fareName = "Standard", price = 78) {
  return createQuote({
    leg: LEG,
    mode: "rail",
    operator: "Eurostar",
    fare_name: fareName,
    base_price: fromDecimal(price, "GBP"),
    fee_confidence: "confirmed",
    source_type: "operator",
    source_url: "https://www.eurostar.com/search/uk-en",
    depart_at: "2026-09-05T18:01",
    arrive_at: "2026-09-05T21:30",
    duration_minutes: 149,
  });
}

function row(fareName = "Standard", price = 78, legIndex = 1): ItineraryRow {
  return rowFromQuote(quote(fareName, price), { trip_id: TRIP, leg_index: legIndex });
}

/** Column A as the API returns it: header cell first, then one key per row. */
function keyColumn(rows: ItineraryRow[]): string[] {
  return ["itinerary_key", ...rows.map((r) => r.itinerary_key)];
}

describe("itinerary keys are deterministic", () => {
  it("produces the same key for the same leg identity", () => {
    const a = itineraryKey({ trip_id: TRIP, leg_index: 1, operator: "Eurostar", fare_name: "Standard" });
    const b = itineraryKey({ trip_id: TRIP, leg_index: 1, operator: "Eurostar", fare_name: "Standard" });
    expect(a).toBe(b);
    expect(a).toBe("paris-sep-2026::leg1::eurostar::standard");
  });

  it("distinguishes fare products on the same leg", () => {
    expect(row("Standard").itinerary_key).not.toBe(row("Plus").itinerary_key);
  });

  it("distinguishes legs within a trip", () => {
    expect(row("Standard", 78, 1).itinerary_key).not.toBe(row("Standard", 78, 2).itinerary_key);
  });
});

describe("upsert is idempotent on re-run", () => {
  it("appends on the first write into an empty tab", () => {
    const rows = [row("Standard"), row("Plus", 120)];
    const plan = planUpsert(["itinerary_key"], rows);
    expect(plan.appends).toHaveLength(2);
    expect(plan.updates).toHaveLength(0);
  });

  it("updates in place on the second write — no duplicate rows", () => {
    const rows = [row("Standard"), row("Plus", 120)];
    const plan = planUpsert(keyColumn(rows), rows);
    expect(plan.appends).toHaveLength(0);
    expect(plan.updates).toHaveLength(2);
  });

  it("targets the correct sheet rows, accounting for the header", () => {
    const rows = [row("Standard"), row("Plus", 120)];
    const plan = planUpsert(keyColumn(rows), rows);
    // Header occupies row 1, so the first data row is row 2.
    expect(plan.updates.map((u) => u.rowNumber)).toEqual([2, 3]);
  });

  it("writes the new price into the existing row when a fare changes", () => {
    const original = [row("Standard", 78)];
    const repriced = [row("Standard", 91)];
    const plan = planUpsert(keyColumn(original), repriced);
    expect(plan.appends).toHaveLength(0);
    expect(plan.updates).toHaveLength(1);
    const totalIdx = ITINERARY_COLUMNS.indexOf("total_price");
    expect(plan.updates[0]!.values[totalIdx]).toBe(91);
  });

  it("mixes updates and appends when a run adds an option", () => {
    const existing = [row("Standard")];
    const rerun = [row("Standard"), row("Snap 13:00–20:01", 50)];
    const plan = planUpsert(keyColumn(existing), rerun);
    expect(plan.updates).toHaveLength(1);
    expect(plan.appends).toHaveLength(1);
    expect(plan.appends[0]!.key).toContain("snap");
  });

  it("leaves unrelated trips in the tab untouched", () => {
    const otherTrip = rowFromQuote(quote(), { trip_id: "lisbon-oct-2026", leg_index: 1 });
    const plan = planUpsert(keyColumn([otherTrip]), [row("Standard")]);
    expect(plan.updates).toHaveLength(0);
    expect(plan.appends).toHaveLength(1);
  });

  it("collapses a duplicated key inside one batch instead of appending twice", () => {
    const plan = planUpsert(["itinerary_key"], [row("Standard", 78), row("Standard", 91)]);
    expect(plan.appends).toHaveLength(1);
    const totalIdx = ITINERARY_COLUMNS.indexOf("total_price");
    expect(plan.appends[0]!.values[totalIdx]).toBe(91); // last write wins
  });

  it("ignores blank cells in the key column rather than treating them as keys", () => {
    const rows = [row("Standard")];
    const plan = planUpsert(["itinerary_key", "", ...rows.map((r) => r.itinerary_key)], rows);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.rowNumber).toBe(3);
  });
});

describe("row shape matches the sheet", () => {
  it("emits one value per declared column, in order", () => {
    const values = rowToValues(row());
    expect(values).toHaveLength(ITINERARY_COLUMNS.length);
    expect(HEADERS).toHaveLength(ITINERARY_COLUMNS.length);
  });

  it("puts the idempotency key in column A", () => {
    expect(ITINERARY_COLUMNS[0]).toBe("itinerary_key");
    expect(rowToValues(row())[0]).toBe(row().itinerary_key);
  });

  it("computes the last column letter from the schema", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(LAST_COLUMN).toBe(columnLetter(ITINERARY_COLUMNS.length - 1));
  });
});

describe("phase 2 seam", () => {
  it("writes every row as unbooked with an empty booking ref", () => {
    const r = row();
    expect(r.booking_status).toBe("unbooked");
    expect(r.booking_ref).toBe("");
  });

  it("keeps booking columns in the schema so adding booking doesn't reshape the sheet", () => {
    expect(ITINERARY_COLUMNS).toContain("booking_status");
    expect(ITINERARY_COLUMNS).toContain("booking_ref");
  });
});

describe("rows carry provenance", () => {
  it("records fetched_at and the source it came from", () => {
    const r = row();
    expect(Date.now() - Date.parse(r.fetched_at)).toBeLessThan(1_000);
    expect(r.source_type).toBe("operator");
    expect(r.source_url).toContain("eurostar.com");
    expect(r.fees_confirmed).toBe(true);
  });
});
