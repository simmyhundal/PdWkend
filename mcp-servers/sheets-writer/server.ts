#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ITINERARY_COLUMNS, describeRow, itineraryKey, type ItineraryRow } from "@pdwkend/contracts";
import { isConfigured, serviceAccountEmail, SheetsAuthError } from "./src/auth.js";
import {
  SheetsAccessError,
  checkWriteAccess,
  findOrCreateTab,
  getSpreadsheet,
  readRows,
  upsertRows,
} from "./src/sheets_client.js";

const log = (msg: string) => process.stderr.write(`[sheets-writer] ${msg}\n`);

/**
 * A price crossing a process boundary loses its session identity, so the
 * same-session rule can't be checked here. Staleness still can be: nothing older
 * than this gets written, because a sheet outlives the conversation and a stale
 * number in it reads as fact forever.
 */
const MAX_WRITE_AGE_MS = 30 * 60 * 1000;

const server = new McpServer({ name: "pdwkend-sheets-writer", version: "0.1.0" });

const legShape = z.object({
  leg_index: z.number().int().min(1).describe("1-based position of this leg in the trip."),
  date: z.string().describe("Travel date, YYYY-MM-DD."),
  origin: z.string(),
  destination: z.string(),
  mode: z.string().describe("rail | flight | bus | ferry"),
  operator: z.string(),
  fare_name: z.string().describe("Fare product, e.g. 'Standard', 'Snap 13:00-20:01'."),
  depart_at: z.string().default(""),
  arrive_at: z.string().default(""),
  duration: z.string().default("").describe("Human-readable, e.g. '2h 23m'."),
  base_price: z.number().describe("Fare before fees, as a decimal."),
  fees: z.number().default(0).describe("Total fees, as a decimal. 0 for operator-direct fares."),
  total_price: z.number().describe("base_price + fees. Must be the checkout-ready figure."),
  currency: z.string().length(3),
  fees_confirmed: z.boolean().describe("False if the source didn't disclose its fees."),
  source_type: z.string().describe("operator | aggregator"),
  source_url: z.string(),
  fetched_at: z.string().describe("ISO-8601 timestamp from the live fetch. Required."),
  notes: z.string().default(""),
});

function toRow(leg: z.infer<typeof legShape>, tripId: string): ItineraryRow {
  return {
    itinerary_key: itineraryKey({
      trip_id: tripId,
      leg_index: leg.leg_index,
      operator: leg.operator,
      fare_name: leg.fare_name,
    }),
    trip_id: tripId,
    leg_index: leg.leg_index,
    date: leg.date,
    origin: leg.origin,
    destination: leg.destination,
    mode: leg.mode,
    operator: leg.operator,
    fare_name: leg.fare_name,
    depart_at: leg.depart_at ?? "",
    arrive_at: leg.arrive_at ?? "",
    duration: leg.duration ?? "",
    base_price: leg.base_price,
    fees: leg.fees ?? 0,
    total_price: leg.total_price,
    currency: leg.currency.toUpperCase(),
    fees_confirmed: leg.fees_confirmed,
    source_type: leg.source_type,
    source_url: leg.source_url,
    fetched_at: leg.fetched_at,
    booking_status: "unbooked",
    booking_ref: "",
    notes: leg.notes ?? "",
  };
}

/** Rejects anything that would put an unverified number into a durable document. */
function validateLeg(leg: z.infer<typeof legShape>): string | undefined {
  const label = `leg ${leg.leg_index} (${leg.operator} ${leg.fare_name})`;

  const ts = Date.parse(leg.fetched_at);
  if (Number.isNaN(ts)) return `${label}: fetched_at "${leg.fetched_at}" isn't a valid timestamp.`;
  const age = Date.now() - ts;
  if (age < 0) return `${label}: fetched_at is in the future.`;
  if (age > MAX_WRITE_AGE_MS) {
    return `${label}: price was fetched ${Math.round(age / 60000)} minutes ago; re-fetch before writing it to the sheet.`;
  }

  const expected = Math.round((leg.base_price + (leg.fees ?? 0)) * 100);
  if (Math.round(leg.total_price * 100) !== expected) {
    return `${label}: total_price ${leg.total_price} != base ${leg.base_price} + fees ${leg.fees ?? 0}.`;
  }
  return undefined;
}

function errorText(err: unknown): string {
  if (err instanceof SheetsAccessError) return `${err.message}\n${err.hint}`;
  if (err instanceof SheetsAuthError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

server.registerTool(
  "check_sheet_access",
  {
    title: "Verify write access to a spreadsheet",
    description:
      "Confirms the service account can actually WRITE to an existing spreadsheet, by performing " +
      "a real no-op write. Call this before gathering an itinerary the user expects to be saved — " +
      "a read-only check would pass on a view-only sheet and the failure would only surface after " +
      "the work was done. Reports the service-account email to share the sheet with if access is " +
      "missing. Does not modify any visible cell.",
    inputSchema: {
      spreadsheet_id: z.string().describe("The ID from the sheet's URL (between /d/ and /edit)."),
    },
  },
  async ({ spreadsheet_id }) => {
    if (!isConfigured()) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              "Google credentials aren't configured, so the sheet cannot be written. Set " +
              "GOOGLE_APPLICATION_CREDENTIALS to a service-account key file, then share the " +
              "spreadsheet with that account as an Editor. Tell the user this before doing " +
              "any itinerary work — don't gather results and discover it later.",
          },
        ],
      };
    }
    try {
      const { info } = await checkWriteAccess(spreadsheet_id);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Write access confirmed on "${info.title}".\n` +
              `Tabs: ${info.tabs.map((t) => t.title).join(", ") || "(none)"}\n${info.url}`,
          },
        ],
        structuredContent: { ok: true, title: info.title, tabs: info.tabs.map((t) => t.title), url: info.url },
      };
    } catch (err) {
      log(`check_sheet_access: ${errorText(err)}`);
      return { isError: true, content: [{ type: "text" as const, text: errorText(err) }] };
    }
  },
);

server.registerTool(
  "find_or_create_tab",
  {
    title: "Find or create a tab in an existing spreadsheet",
    description:
      "Ensures a named tab exists in the given spreadsheet, creating it with the itinerary header " +
      "row if absent. Never creates a new spreadsheet file. Safe to call repeatedly.",
    inputSchema: {
      spreadsheet_id: z.string(),
      tab: z.string().describe("Tab title, e.g. 'Paris Sep 2026'."),
    },
  },
  async ({ spreadsheet_id, tab }) => {
    try {
      const res = await findOrCreateTab(spreadsheet_id, tab);
      return {
        content: [
          { type: "text" as const, text: res.created ? `Created tab "${tab}".` : `Tab "${tab}" already existed.` },
        ],
        structuredContent: { ...res },
      };
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: errorText(err) }] };
    }
  },
);

server.registerTool(
  "upsert_itinerary_rows",
  {
    title: "Write itinerary legs into a spreadsheet tab",
    description:
      "Writes itinerary legs into a tab of an EXISTING spreadsheet, keyed so that re-running the " +
      "same trip updates rows in place instead of appending duplicates. Every leg must carry the " +
      "fetched_at timestamp from the live fare lookup that produced its price; legs with a missing, " +
      "stale (>30min), or arithmetically inconsistent price are rejected rather than written. " +
      "booking_status is always written as 'unbooked' — this tool does not book anything.",
    inputSchema: {
      spreadsheet_id: z.string(),
      tab: z.string().describe("Tab title. Created if it doesn't exist."),
      trip_id: z
        .string()
        .describe("Stable identifier for this trip, e.g. 'paris-sep-2026'. Reused to update the same rows."),
      legs: z.array(legShape).min(1),
    },
  },
  async ({ spreadsheet_id, tab, trip_id, legs }) => {
    const problems = legs.map(validateLeg).filter((p): p is string => Boolean(p));
    if (problems.length) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `Refused to write ${problems.length} of ${legs.length} legs:\n` +
              problems.map((p) => `- ${p}`).join("\n") +
              `\n\nRe-fetch the affected fares and try again. Do not adjust the numbers by hand.`,
          },
        ],
      };
    }

    try {
      const rows = legs.map((l) => toRow(l, trip_id));
      const res = await upsertRows(spreadsheet_id, tab, rows);
      const info = await getSpreadsheet(spreadsheet_id);
      const summary =
        `Wrote ${res.appended + res.updated} legs to "${tab}" ` +
        `(${res.appended} new, ${res.updated} updated).\n` +
        rows.map((r) => `- ${describeRow(r)}`).join("\n") +
        `\n${info.url}`;
      return { content: [{ type: "text" as const, text: summary }], structuredContent: { ...res } };
    } catch (err) {
      log(`upsert: ${errorText(err)}`);
      return { isError: true, content: [{ type: "text" as const, text: errorText(err) }] };
    }
  },
);

server.registerTool(
  "read_itinerary",
  {
    title: "Read itinerary rows back from a tab",
    description:
      "Reads the current contents of an itinerary tab. Use to show the user what's saved, or to " +
      "check what a re-run would change. Prices read back from a sheet are historical — re-fetch " +
      "before quoting any of them as current.",
    inputSchema: { spreadsheet_id: z.string(), tab: z.string() },
  },
  async ({ spreadsheet_id, tab }) => {
    try {
      const values = await readRows(spreadsheet_id, tab);
      if (values.length <= 1) {
        return { content: [{ type: "text" as const, text: `Tab "${tab}" has no itinerary rows yet.` }] };
      }
      const [, ...body] = values;
      const idx = (col: (typeof ITINERARY_COLUMNS)[number]) => ITINERARY_COLUMNS.indexOf(col);
      const lines = body.map(
        (r) =>
          `- leg ${r[idx("leg_index")]}: ${r[idx("origin")]}→${r[idx("destination")]} ${r[idx("date")]} ` +
          `${r[idx("operator")]} ${r[idx("fare_name")]} ${r[idx("currency")]}${r[idx("total_price")]} ` +
          `[${r[idx("booking_status")]}] fetched ${r[idx("fetched_at")]}`,
      );
      return {
        content: [{ type: "text" as const, text: `"${tab}" — ${body.length} legs:\n${lines.join("\n")}` }],
        structuredContent: { rows: body.length, values: body },
      };
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: errorText(err) }] };
    }
  },
);

await server.connect(new StdioServerTransport());
log(isConfigured() ? `ready (service account: ${tryEmail()})` : "ready (NO CREDENTIALS CONFIGURED)");

function tryEmail(): string {
  try {
    return serviceAccountEmail();
  } catch {
    return "unreadable key";
  }
}
