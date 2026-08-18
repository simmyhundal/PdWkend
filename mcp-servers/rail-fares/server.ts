#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  LiveFetchUnavailableError,
  curateQuotes,
  recommend,
  renderNotes,
  renderQuoteTable,
  formatMoney,
  type FareQuote,
} from "@pdwkend/contracts";
import { EurostarSource } from "./src/eurostar.js";
import { EurostarSnapSource, daysUntil } from "./src/eurostar_snap.js";
import { AggregatorSource } from "./src/aggregator.js";
import { BrowserPool, orderSources, type FareQuery, type FareSource } from "@pdwkend/sources";

/**
 * stdio transport owns stdout — anything written there corrupts the protocol
 * frame. Diagnostics go to stderr.
 */
const log = (msg: string) => process.stderr.write(`[rail-fares] ${msg}\n`);

const browser = new BrowserPool();
const SOURCES: FareSource[] = orderSources([
  new EurostarSource(),
  new EurostarSnapSource(),
  new AggregatorSource(),
]);

const server = new McpServer({ name: "pdwkend-rail-fares", version: "0.1.0" });

const queryShape = {
  origin: z.string().describe("Origin station or city, e.g. 'London St Pancras' or 'London'."),
  destination: z.string().describe("Destination station or city, e.g. 'Paris'."),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Travel date, YYYY-MM-DD."),
  adults: z.number().int().min(1).max(9).default(1).describe("Number of adult passengers."),
  earliest_departure: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Earliest acceptable departure, HH:MM local."),
  latest_departure: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Latest acceptable departure, HH:MM local."),
};

server.registerTool(
  "search_rail_fares",
  {
    title: "Search live rail fares",
    description:
      "Fetch live, fee-inclusive rail fares for one leg, read from the operator's own booking " +
      "site. Every price returned was fetched during this call and carries a fetched_at " +
      "timestamp — there are no cached or estimated figures. Results are already curated to a " +
      "handful of options (cheapest, each fare class, and any non-obvious cheaper option such " +
      "as a Eurostar Snap fare or a materially cheaper nearby date); present the returned table " +
      "as-is rather than re-listing every row. If a source could not be priced, the reason is " +
      "reported explicitly — say so rather than substituting an estimate. Takes roughly 30s.",
    inputSchema: queryShape,
  },
  async (args) => {
    const query: FareQuery = {
      origin: args.origin,
      destination: args.destination,
      date: args.date,
      adults: args.adults ?? 1,
      earliest_departure: args.earliest_departure,
      latest_departure: args.latest_departure,
    };

    const quotes: FareQuote[] = [];
    const unavailable: string[] = [];

    for (const source of SOURCES) {
      if (!source.supports(query)) continue;
      // An aggregator only earns a turn if no operator priced the leg (rule #2).
      if (source.sourceType === "aggregator" && quotes.length > 0) continue;
      try {
        quotes.push(...(await source.fetch(query, { browser, log })));
      } catch (err) {
        if (err instanceof LiveFetchUnavailableError) {
          unavailable.push(err.userMessage);
          log(`${source.id}: ${err.message}`);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          unavailable.push(`${source.operator}: ${msg}`);
          log(`${source.id} unexpected: ${msg}`);
        }
      }
    }

    if (quotes.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text:
              `No live fare could be fetched for ${query.origin} → ${query.destination} on ${query.date}.\n` +
              unavailable.map((u) => `- ${u}`).join("\n") +
              `\n\nDo not substitute an estimated price. Report this to the user as-is.`,
          },
        ],
      };
    }

    const curated = curateQuotes(quotes);
    const pick = recommend(curated, { forDate: query.date });
    const notes = renderNotes(curated);

    const text = [
      renderQuoteTable(curated),
      pick
        ? `**Pick:** ${pick.operator} ${pick.fare_name} at ${formatMoney(pick.total_price)}` +
          (pick.non_obvious ? ` — ${pick.non_obvious.reason}` : "") +
          (pick.caveats.length ? ` (${pick.caveats[0]})` : "")
        : "",
      notes.length ? notes.map((n) => `- ${n}`).join("\n") : "",
      unavailable.length ? `Not priced: ${unavailable.join("; ")}` : "",
      `_${curated.length} of ${quotes.length} options shown; all fetched live just now._`,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        quotes: curated,
        total_found: quotes.length,
        unavailable,
      },
    };
  },
);

server.registerTool(
  "check_snap_availability",
  {
    title: "Check whether Eurostar Snap is on sale for a date",
    description:
      "Cheap, instant check of whether Eurostar Snap can be booked for a given date. Snap only " +
      "sells within 14 days of travel. Call this before search_rail_fares when the user asks " +
      "about Snap for a date further out, to avoid a 30s search that cannot return a Snap price. " +
      "Returns no prices — use search_rail_fares for those.",
    inputSchema: { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Travel date, YYYY-MM-DD.") },
  },
  async ({ date }) => {
    const lead = daysUntil(date);
    const available = lead >= 0 && lead <= 14;
    const text = available
      ? `Snap is on sale for ${date} (${lead} days out).`
      : lead < 0
        ? `${date} is in the past.`
        : `Snap is not on sale for ${date} yet — it's ${lead} days out and Snap opens 14 days before travel. No Snap price exists to quote.`;
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { date, days_ahead: lead, snap_available: available },
    };
  },
);

async function shutdown() {
  await browser.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
log("ready");
