# Paddy Weekend (`pdwkend`)

Multi-city trip planning that returns **real, bookable prices** — not estimates —
and keeps the itinerary in a Google Sheet you already own.

Phase 1: information gathering. Booking is deliberately not implemented; there's a
seam for it, nothing behind the seam.

---

## What this is

Three MCP servers plus a system prompt. Claude is the orchestrator — there's no
custom agent loop, because native tool-calling already handles the reasoning,
table rendering and turn-taking that a hand-built loop would re-implement.

| Server | Tools | What it reads |
|---|---|---|
| `rail-fares` | `search_rail_fares`, `check_snap_availability` | eurostar.com and snap.eurostar.com, live |
| `flight-fares` | `search_flight_fares` | Google Flights, live |
| `sheets-writer` | `check_sheet_access`, `find_or_create_tab`, `upsert_itinerary_rows`, `read_itinerary` | Sheets API v4 |

`packages/contracts` holds the fare and itinerary types. It's where the project's
four hard rules are enforced as code rather than as prompt text — see
[Design notes](#design-notes).

## Setup

```bash
npm install
npx playwright install chromium   # the fare adapters drive a real browser
npm run build
npm test
```

### Google Sheets access

1. In [Google Cloud Console](https://console.cloud.google.com), create a project
   and enable the **Google Sheets API**.
2. IAM & Admin → Service Accounts → create one → Keys → **Add key → JSON**.
3. Point `GOOGLE_APPLICATION_CREDENTIALS` at the downloaded file (see
   [`.env.example`](.env.example)).
4. Open your spreadsheet and **share it with the service account's email**
   (the `client_email` in the key file) as an **Editor**.

Step 4 is the one people miss. Without it the servers can't see the file at all,
and a missing share is indistinguishable from a wrong ID.

Verify before doing anything else:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
  node -e 'import("./mcp-servers/sheets-writer/dist/src/sheets_client.js")
    .then(m => m.checkWriteAccess("YOUR_SPREADSHEET_ID"))
    .then(r => console.log("OK:", r.info.title, r.info.tabs.map(t => t.title)))
    .catch(e => console.error("FAILED:", e.message, e.hint ?? ""))'
```

### Wiring the servers up

Claude Code (`.mcp.json` in the project, or `claude mcp add`):

```json
{
  "mcpServers": {
    "pdwkend-rail": {
      "command": "node",
      "args": ["/absolute/path/to/pdwkend/mcp-servers/rail-fares/dist/server.js"]
    },
    "pdwkend-flights": {
      "command": "node",
      "args": ["/absolute/path/to/pdwkend/mcp-servers/flight-fares/dist/server.js"]
    },
    "pdwkend-sheets": {
      "command": "node",
      "args": ["/absolute/path/to/pdwkend/mcp-servers/sheets-writer/dist/server.js"],
      "env": { "GOOGLE_APPLICATION_CREDENTIALS": "/absolute/path/to/key.json" }
    }
  }
}
```

Claude Desktop uses the same shape in `claude_desktop_config.json`.

Then paste [`prompts/project_instructions.md`](prompts/project_instructions.md)
in as the project/system prompt. It isn't optional decoration — response brevity
and the "never quote an unfetched price" rule are enforced there and in the tool
descriptions, since there's no UI layer to gate them in code.

## Design notes

### Why a headless browser rather than a fare API

Checked August 2026, and this is the load-bearing constraint on the whole project:

- **Amadeus Self-Service** — decommissioned 17 July 2026. Enterprise portal only.
- **Duffel** — test mode returns sandbox data, which rule #1 forbids; production
  needs a commercial account.
- **Deutsche Bahn Vendo** — the station lookup is open, the *fare* endpoint
  bot-blocks (`OPS_BLOCKED`). The maintainers of `db-vendo-client` warn the APIs
  "have become very unreliable".
- **Eurostar's own API** — distribution partners only, with a ~€20k annual sales
  threshold.

So there is no free, sanctioned source of live fares left. Driving the operator's
own site is what remains, and it happens to satisfy rule #2 exactly: the number
on eurostar.com's search *is* the checkout number, with no reseller fee on top.

Eurostar sits behind AWS WAF, which is why a real browser is needed — the WAF
challenge is solved by the page's own JavaScript. The adapters navigate straight
to the results URL and read the underlying `NewBookingSearch` GraphQL payload
rather than scraping rendered prices, so they survive a restyle.

**This is the fragile part of the system.** When a site changes, its adapter
fails loudly with `LiveFetchUnavailableError` rather than returning a stale or
guessed number. Run with `PDWKEND_HEADFUL=1` to watch it work.

### The four rules, as code

| Rule | Where it lives |
|---|---|
| Never quote an unfetched price | `createQuote` stamps `fetched_at`/`session_id` itself and takes no timestamp argument; `assertFresh` gates rendering; `renderQuoteTable` throws on stale input |
| Fee-inclusive, checkout-ready | `total_price` is *derived* from `base + fees`, never passed in; an aggregator claiming confirmed-with-no-fees is rejected by the schema; unconfirmed fees render as "€89.00 before fees", never as a total |
| Keep responses short | `curateQuotes` cuts ~45 raw options to ≤6 before the model sees them, always keeping the non-obvious ones; `renderNotes` prints a shared caveat once |
| Real sheet write access | `spreadsheets` scope (not `drive.file`); `checkWriteAccess` proves write access with a real no-op write before work starts; `planUpsert` keys on column A so re-runs update rather than duplicate |

An estimate is a structurally different type (`PriceEstimate`) from a quote
(`FareQuote`), so one cannot be passed where the other is expected. There is no
code path from "the fetch failed" to "here is a number".

### Non-obvious options

The point of the tool. Surfaced automatically:

- **Eurostar Snap** — up to 50% off, but you book a time *slot* and get told your
  train 48h ahead. Only sells within 14 days, so `check_snap_availability` answers
  that instantly rather than burning a 30s search.
- **Cheaper nearby dates** — read from Eurostar's own `CheapestFaresSearch`,
  shown when a nearby date beats the requested one by ≥10%.
- **Alternate airports** — Google Flights surfaces LGW/LTN/ORY departures that a
  naive LHR→CDG search would miss.

These are never dropped by curation, even when trimming to fit.

## Layout

```
packages/
  contracts/       fare + itinerary types; the four rules as code
  sources/         FareSource interface, headless-browser plumbing
mcp-servers/
  rail-fares/      eurostar.ts, eurostar_snap.ts, aggregator.ts, stations.ts
  flight-fares/    google_flights.ts
  sheets-writer/   sheets_client.ts, upsert_plan.ts, auth.ts
prompts/           project_instructions.md — the system prompt
tests/             freshness, fee inclusion, sheet idempotency, flight parsing
```

## Phase 2

Not built. The seams that exist so the schema doesn't need rewriting:

- `booking_status` and `booking_ref` columns, written as `unbooked`/empty
- `BookingProvider` in `packages/contracts/src/booking.ts` — interface only,
  every method throws `NotImplementedError`
- `BookingRequest` takes a `payment_token`, never card data, and refuses without
  `cancellation_policy_acknowledged`

Do not implement checkout, payment capture, or ticket issuance against these yet.
