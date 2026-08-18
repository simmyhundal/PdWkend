import { ITINERARY_COLUMNS, rowToValues, type ItineraryRow } from "@pdwkend/contracts";

/**
 * The decision half of an upsert, separated from the API calls so the
 * idempotency guarantee can be tested without a live spreadsheet.
 *
 * Everything that decides *whether a row is new* lives here; sheets_client only
 * executes the resulting plan.
 */

export interface UpsertPlan {
  /** Existing rows to overwrite in place, with their 1-based sheet row numbers. */
  updates: { rowNumber: number; key: string; values: (string | number | boolean)[] }[];
  /** Rows not already present, to be appended. */
  appends: { key: string; values: (string | number | boolean)[] }[];
}

/**
 * @param existingKeyColumn Column A read top-to-bottom, including the header cell
 *                          at index 0. A key at index i sits on sheet row i + 1.
 */
export function planUpsert(existingKeyColumn: string[], rows: ItineraryRow[]): UpsertPlan {
  const keyToRow = new Map<string, number>();
  existingKeyColumn.forEach((key, i) => {
    // Index 0 is the header; a blank cell is a gap, not a key.
    if (i > 0 && key) keyToRow.set(key, i + 1);
  });

  // Within one batch the last write wins, so a repeated key can't append twice.
  const deduped = new Map<string, ItineraryRow>();
  for (const row of rows) deduped.set(row.itinerary_key, row);

  const plan: UpsertPlan = { updates: [], appends: [] };
  for (const row of deduped.values()) {
    const values = rowToValues(row);
    const rowNumber = keyToRow.get(row.itinerary_key);
    if (rowNumber) plan.updates.push({ rowNumber, key: row.itinerary_key, values });
    else plan.appends.push({ key: row.itinerary_key, values });
  }
  return plan;
}

export function columnLetter(indexZeroBased: number): string {
  let n = indexZeroBased + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export const LAST_COLUMN = columnLetter(ITINERARY_COLUMNS.length - 1);
