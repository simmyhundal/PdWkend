#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  LiveFetchUnavailableError,
  curateQuotes,
  formatMoney,
  recommend,
  renderNotes,
  renderQuoteTable,
  type FareQuote,
} from "@pdwkend/contracts";
import { BrowserPool, orderSources, type FareQuery, type FareSource } from "@pdwkend/sources";
import {
  AWARD_CABINS,
  AWARD_CHECK_GUIDANCE,
  AWARD_PROGRAMS,
  buildAwardCheckLinks,
  renderAwardCheckTable,
} from "./src/award_links.js";
import { GoogleFlightsSource } from "./src/google_flights.js";

const log = (msg: string) => process.stderr.write(`[flight-fares] ${msg}\n`);

const browser = new BrowserPool();
const SOURCES: FareSource[] = orderSources([new GoogleFlightsSource()]);

const server = new McpServer({ name: "pdwkend-flight-fares", version: "0.1.0" });

server.registerTool(
  "search_flight_fares",
  {
    title: "Search live flight fares",
    description:
      "Fetch live flight fares for one leg, read from Google Flights at call time. Every price " +
      "carries a fetched_at timestamp from this call — nothing is cached or estimated. Results " +
      "are curated to a handful of options; present the returned table as-is. Fares are the " +
      "airline's headline price and are labelled as excluding bags and seat selection, so they " +
      "display as 'before fees' rather than as a checkout total — keep that wording. For rail " +
      "routes inside Europe, prefer search_rail_fares: it reads the operator's own site and its " +
      "totals are checkout-ready. Takes roughly 30s.",
    inputSchema: {
      origin: z.string().describe("Origin city or airport, e.g. 'London' or 'LHR'."),
      destination: z.string().describe("Destination city or airport, e.g. 'Paris' or 'CDG'."),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Departure date, YYYY-MM-DD."),
      adults: z.number().int().min(1).max(9).default(1),
      currency: z
        .string()
        .regex(/^[A-Za-z]{3}$/)
        .default("USD")
        .describe("ISO-4217 currency to price in, e.g. 'USD' or 'GBP'. Use one currency across all legs of a trip so totals can be summed."),
      earliest_departure: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Earliest departure, HH:MM local."),
      latest_departure: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Latest departure, HH:MM local."),
    },
  },
  async (args) => {
    const query: FareQuery = {
      origin: args.origin,
      destination: args.destination,
      date: args.date,
      adults: args.adults ?? 1,
      currency: (args.currency ?? "USD").toUpperCase(),
      earliest_departure: args.earliest_departure,
      latest_departure: args.latest_departure,
    };

    const quotes: FareQuote[] = [];
    const unavailable: string[] = [];

    for (const source of SOURCES) {
      if (!source.supports(query)) continue;
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
              `No live flight fare could be fetched for ${query.origin} → ${query.destination} on ${query.date}.\n` +
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
      pick ? `**Pick:** ${pick.operator} ${pick.fare_name} at ${formatMoney(pick.total_price)} (before bags)` : "",
      notes.length ? notes.map((n) => `- ${n}`).join("\n") : "",
      unavailable.length ? `Not priced: ${unavailable.join("; ")}` : "",
      `_${curated.length} of ${quotes.length} options shown; all fetched live just now._`,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { quotes: curated, total_found: quotes.length, unavailable },
    };
  },
);

server.registerTool(
  "build_award_check_links",
  {
    title: "Links to check live award (points) prices",
    description:
      "Build links to each loyalty program's own award search (Flying Blue, United, Delta, " +
      "American, Alaska) so the user can check the live points cost of a flight themselves. This " +
      "tool does NOT fetch any points price and none is available from this server — never state, " +
      "estimate or recall a points cost; ask the user to open the links and tell you what they " +
      "see. Pass the flight from a search_flight_fares result in `flight` so the user knows which " +
      "one to look for. Present the returned table and guidance as-is. Instant; no network.",
    inputSchema: {
      origin: z.string().describe("Origin city or airport, e.g. 'London' or 'LHR'."),
      destination: z.string().describe("Destination city or airport, e.g. 'New York' or 'JFK'."),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Departure date, YYYY-MM-DD."),
      adults: z.number().int().min(1).max(9).default(1),
      cabin: z.enum(AWARD_CABINS).default("economy"),
      programs: z.array(z.enum(AWARD_PROGRAMS)).optional().describe("Limit to these programs; default is all."),
      flight: z
        .string()
        .optional()
        .describe("The specific flight to look for, e.g. 'KLM KL1070 09:30'. Shown to the user only."),
    },
  },
  async (args) => {
    const links = buildAwardCheckLinks(
      {
        origin: args.origin,
        destination: args.destination,
        date: args.date,
        adults: args.adults ?? 1,
        cabin: args.cabin ?? "economy",
      },
      args.programs,
    );
    const text = [
      args.flight ? `Look for: **${args.flight}** on ${args.date}.` : "",
      renderAwardCheckTable(links),
      AWARD_CHECK_GUIDANCE,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { links, price_fetched: false },
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
