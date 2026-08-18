import { google, type sheets_v4 } from "googleapis";
import { HEADERS, ITINERARY_COLUMNS, KEY_COLUMN_INDEX, type ItineraryRow } from "@pdwkend/contracts";
import { getAuth, serviceAccountEmail } from "./auth.js";
import { LAST_COLUMN, columnLetter, planUpsert } from "./upsert_plan.js";

/**
 * Sheets API v4 wrapper. Writes into a spreadsheet the user already owns,
 * addressed by ID — it never creates a file.
 */

export class SheetsAccessError extends Error {
  readonly code = "SHEETS_ACCESS";
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "SheetsAccessError";
  }
}

let api: sheets_v4.Sheets | undefined;

function sheets(): sheets_v4.Sheets {
  api ??= google.sheets({ version: "v4", auth: getAuth().client });
  return api;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { code?: number; status?: number; response?: { status?: number } };
  return e?.code ?? e?.status ?? e?.response?.status;
}

/** Turns Google's opaque errors into something the user can act on. */
function translate(err: unknown, spreadsheetId: string): never {
  const status = statusOf(err);
  const email = safeEmail();
  const message = err instanceof Error ? err.message : String(err);

  if (status === 404) {
    throw new SheetsAccessError(
      `Spreadsheet ${spreadsheetId} not found.`,
      `Check the ID, and share the sheet with ${email} as an Editor — a sheet the service ` +
        `account can't see is indistinguishable from one that doesn't exist.`,
    );
  }
  if (status === 403) {
    throw new SheetsAccessError(
      `No write access to spreadsheet ${spreadsheetId}.`,
      `Share it with ${email} and give that account the Editor role (Viewer isn't enough).`,
    );
  }
  if (status === 401) {
    throw new SheetsAccessError(
      `Google rejected the service-account credentials.`,
      `Check the key file is current and that the Sheets API is enabled for its project.`,
    );
  }
  throw new SheetsAccessError(`Sheets API error: ${message}`, `Status ${status ?? "unknown"}.`);
}

function safeEmail(): string {
  try {
    return serviceAccountEmail();
  } catch {
    return "the service account";
  }
}

const KEY_COLUMN = columnLetter(KEY_COLUMN_INDEX);

/** Sheet titles can't contain single quotes unescaped in A1 notation. */
function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

export interface SpreadsheetInfo {
  spreadsheetId: string;
  title: string;
  tabs: { title: string; sheetId: number }[];
  url: string;
}

export async function getSpreadsheet(spreadsheetId: string): Promise<SpreadsheetInfo> {
  try {
    const res = await sheets().spreadsheets.get({ spreadsheetId, fields: "properties.title,sheets.properties" });
    return {
      spreadsheetId,
      title: res.data.properties?.title ?? "(untitled)",
      tabs: (res.data.sheets ?? []).map((s) => ({
        title: s.properties?.title ?? "",
        sheetId: s.properties?.sheetId ?? -1,
      })),
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    };
  } catch (err) {
    translate(err, spreadsheetId);
  }
}

/**
 * Proves write access before any work is done, using developer metadata: a real
 * write that leaves nothing visible in the sheet, created and then removed.
 *
 * Requirement #4 asks for the gap to be reported up front rather than discovered
 * after the itinerary has been assembled, and a read-only `get` can't prove that
 * — a Viewer-shared sheet reads fine and fails only on write.
 */
export async function checkWriteAccess(spreadsheetId: string): Promise<{ ok: true; info: SpreadsheetInfo }> {
  const info = await getSpreadsheet(spreadsheetId);
  const key = "pdwkend_write_probe";
  try {
    await sheets().spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            createDeveloperMetadata: {
              developerMetadata: {
                metadataKey: key,
                metadataValue: new Date().toISOString(),
                location: { spreadsheet: true },
                visibility: "DOCUMENT",
              },
            },
          },
        ],
      },
    });
  } catch (err) {
    translate(err, spreadsheetId);
  }

  // Best-effort cleanup; a stray metadata entry is invisible and harmless.
  await sheets()
    .spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ deleteDeveloperMetadata: { dataFilter: { developerMetadataLookup: { metadataKey: key } } } }],
      },
    })
    .catch(() => {});

  return { ok: true, info };
}

export interface TabResult {
  title: string;
  sheetId: number;
  created: boolean;
}

/** Finds a tab by title, or creates it with the itinerary header row. */
export async function findOrCreateTab(spreadsheetId: string, title: string): Promise<TabResult> {
  const info = await getSpreadsheet(spreadsheetId);
  const existing = info.tabs.find((t) => t.title === title);
  if (existing) return { title, sheetId: existing.sheetId, created: false };

  try {
    const res = await sheets().spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title, gridProperties: { rowCount: 200, columnCount: ITINERARY_COLUMNS.length } },
            },
          },
        ],
      },
    });
    const sheetId = res.data.replies?.[0]?.addSheet?.properties?.sheetId ?? -1;

    await sheets().spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteTitle(title)}!A1:${LAST_COLUMN}1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });

    // Freeze and bold the header so the tab is usable by a human, not just an API.
    await sheets()
      .spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                fields: "gridProperties.frozenRowCount",
              },
            },
            {
              repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: "userEnteredFormat.textFormat.bold",
              },
            },
          ],
        },
      })
      .catch(() => {});

    return { title, sheetId, created: true };
  } catch (err) {
    translate(err, spreadsheetId);
  }
}

export interface UpsertResult {
  tab: string;
  updated: number;
  appended: number;
  updatedKeys: string[];
  appendedKeys: string[];
}

/**
 * Idempotent write, keyed on the itinerary_key in column A.
 *
 * Re-running the same search updates those rows in place rather than appending
 * duplicates — the acceptance criterion for requirement #4. Rows already in the
 * tab that aren't in this batch are left alone, so a tab can hold several trips.
 */
export async function upsertRows(
  spreadsheetId: string,
  tabTitle: string,
  rows: ItineraryRow[],
): Promise<UpsertResult> {
  if (rows.length === 0) {
    return { tab: tabTitle, updated: 0, appended: 0, updatedKeys: [], appendedKeys: [] };
  }
  await findOrCreateTab(spreadsheetId, tabTitle);

  let existingKeys: string[] = [];
  try {
    const res = await sheets().spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteTitle(tabTitle)}!${KEY_COLUMN}:${KEY_COLUMN}`,
      majorDimension: "COLUMNS",
    });
    existingKeys = (res.data.values?.[0] ?? []).map((v) => String(v ?? ""));
  } catch (err) {
    translate(err, spreadsheetId);
  }

  const plan = planUpsert(existingKeys, rows);
  const updates: sheets_v4.Schema$ValueRange[] = plan.updates.map((u) => ({
    range: `${quoteTitle(tabTitle)}!A${u.rowNumber}:${LAST_COLUMN}${u.rowNumber}`,
    values: [u.values],
  }));
  const appends = plan.appends.map((a) => a.values);
  const updatedKeys = plan.updates.map((u) => u.key);
  const appendedKeys = plan.appends.map((a) => a.key);

  try {
    if (updates.length) {
      await sheets().spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "RAW", data: updates },
      });
    }
    if (appends.length) {
      await sheets().spreadsheets.values.append({
        spreadsheetId,
        range: `${quoteTitle(tabTitle)}!A1`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: appends },
      });
    }
  } catch (err) {
    translate(err, spreadsheetId);
  }

  return {
    tab: tabTitle,
    updated: updatedKeys.length,
    appended: appendedKeys.length,
    updatedKeys,
    appendedKeys,
  };
}

/** Reads back the itinerary rows in a tab, for verification and for tests. */
export async function readRows(spreadsheetId: string, tabTitle: string): Promise<string[][]> {
  try {
    const res = await sheets().spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteTitle(tabTitle)}!A:${LAST_COLUMN}`,
    });
    return (res.data.values ?? []).map((r) => r.map((c) => String(c ?? "")));
  } catch (err) {
    translate(err, spreadsheetId);
  }
}

export async function deleteTab(spreadsheetId: string, title: string): Promise<void> {
  const info = await getSpreadsheet(spreadsheetId);
  const tab = info.tabs.find((t) => t.title === title);
  if (!tab) return;
  await sheets()
    .spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ deleteSheet: { sheetId: tab.sheetId } }] },
    })
    .catch((err: unknown) => translate(err, spreadsheetId));
}
