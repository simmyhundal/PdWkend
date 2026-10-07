import type { FetchReport, UnpricedOption } from "@pdwkend/sources";

/**
 * What a search saw beyond its priced quotes. Without this, a curated list of
 * three LATAM fares reads as "only three flights that day" when Google also
 * listed a Sky Airline nonstop it wouldn't price one-way (issue #5).
 */

export function emptyReport(): FetchReport {
  return { unpriced: [], skipped_rows: 0 };
}

export function mergeReport(into: FetchReport, from: FetchReport): void {
  into.unpriced.push(...from.unpriced);
  into.skipped_rows += from.skipped_rows;
}

/** "Sky Airline 09:00 → 12:17 (nonstop)" — schedule only; there is no price to show. */
export function describeUnpriced(o: UnpricedOption): string {
  const time = (iso: string) => iso.slice(11, 16);
  const nextDay = o.arrive_at.slice(0, 10) !== o.depart_at.slice(0, 10) ? " +1" : "";
  const stops = o.changes === 0 ? "nonstop" : `${o.changes} stop${o.changes > 1 ? "s" : ""}`;
  return `${o.operator} ${time(o.depart_at)} → ${time(o.arrive_at)}${nextDay} (${stops})`;
}

/** Lines to append to a result so the agent can't present a partial list as complete. */
export function renderCoverageNotes(report: FetchReport): string[] {
  const lines: string[] = [];
  if (report.unpriced.length > 0) {
    lines.push(
      `Also flying, but Google Flights shows no one-way price: ` +
        report.unpriced.map(describeUnpriced).join("; ") +
        `. Check the airline's own site for a fare; do not estimate one.`,
    );
  }
  if (report.skipped_rows > 0) {
    lines.push(
      `${report.skipped_rows} result row${report.skipped_rows > 1 ? "s" : ""} couldn't be read, ` +
        `so this list may be incomplete.`,
    );
  }
  return lines;
}
