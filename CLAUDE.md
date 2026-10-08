# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

TypeScript ESM monorepo (npm workspaces, Node >=20.10) of three stdio MCP servers (rail fares, flight fares, Google Sheets itinerary writer) plus shared packages. Claude is the orchestrator; `prompts/project_instructions.md` is the system prompt.

## Commands

- First-time setup: `npm install`, `npx playwright install chromium`, `npm run build`
- `npm run build` (`tsc --build`) — **required after any source change.** MCP servers run from `dist/`, and tests import built workspace packages via `exports` mappings to `dist/`, so skipping it means stale code.
- `npm test` builds then runs vitest; `npm run test:fast` skips the build.
- Single test: `npx vitest run tests/sheets_write.test.ts -t "name"` (does not build first).
- `npm run typecheck` is only `tsc --build --dry`, so it won't surface type errors. Use `npm run build`.
- No linter/formatter is configured. Match existing style: 2-space indent, double quotes, semicolons, trailing commas, ~100 cols. Imports need `.js` extensions (NodeNext).

## Hard rules (enforced in `packages/contracts`; don't bypass)

- Never quote an unfetched price. `createQuote` stamps `fetched_at`/`session_id`; `assertFresh` gates rendering. `upsert_itinerary_rows` rejects prices older than 30 min — re-search, never edit timestamps.
- Totals are fee-inclusive (`total_price` = base + fees). Unconfirmed fees render as "€X before fees". Aggregator "confirmed" with no fees is rejected.
- `PriceEstimate` is deliberately a different type from `FareQuote`; adapters throw `LiveFetchUnavailableError` rather than fall back to a number.
- `curateQuotes` trims ~45 raw options to ≤6 but must keep the non-obvious ones (Snap fares, nearby dates, alternate airports).
- Phase 2 booking is stubbed: `BookingProvider` throws `NotImplementedError` and `booking_status` is `unbooked`. Do not implement checkout or payment.

## Gotchas

- Points/award prices are human-in-the-loop (issue #4): `build_award_check_links` only builds links to each program's own award search. There is no API or scraper for points costs (automating logged-in sites risks their ToS), so never state or recall a points price — ask the user what they see. Prefill URL formats in `award_links.ts` are unverified until marked `verified`.

- Idempotency: `planUpsert` (`mcp-servers/sheets-writer/src/upsert_plan.ts`) keys on column A `itinerary_key` (trip_id + leg_index). Existing keys update in place, new ones append, last duplicate in a batch wins. Re-running must never duplicate rows.
- `splitCarriers` (`mcp-servers/flight-fares/src/google_flights.ts`) masks `INTERNAL_CAPS` brands with a sentinel before splitting codeshares on lower→upper case boundaries. The sentinel must be letter-free and **printable ASCII** — it was once NUL bytes, which made git treat the file as binary. Add any new mid-word-capital airline brand to `INTERNAL_CAPS`.
- Fare adapters drive live sites with Playwright (eurostar.com behind AWS WAF, reading `NewBookingSearch`/`CheapestFaresSearch` GraphQL payloads; snap.eurostar.com, which only sells within 14 days; Google Flights). Site changes break them. Debug with `PDWKEND_HEADFUL=1`; `PDWKEND_NAV_TIMEOUT_MS` defaults to 45000.
- Tests are offline unit tests; no live Sheets or browser calls. Parser fixtures should be real rows captured from the page (note the capture date), not reconstructed text.
- Known flight-fares limits (open issues; don't build on the current behaviour):
  - `curateQuotes` keeps the cheapest per `fare_name`, which suits Eurostar fare classes. Flight `fare_name` is "Nonstop X–Y" / "1 stop X–Y", so every nonstop collapses to one row and other departure times are dropped (#7).
  - The cabin label ("Premium Economy") isn't parsed, so premium fares look like economy (#8).
  - With `adults > 1`, `total_price` is still the per-person fare, and nothing on the quote says so (#9).
  - Rows Google shows as "Price unavailable" (e.g. Sky Airline one-way) are dropped silently (#5). Fixed in PR #6, which adds `unpriced` and `FetchContext.report`.
- After merging a server change, rebuild and restart the MCP server; a connected session keeps running the old `dist/` until then.
- Dogfooding: when planning a real trip, use these MCP tools for any price they cover rather than browsing Google Flights, so quotes carry `fetched_at`. Write findings up in `docs/field-notes/` (on the `docs/field-notes` branch until merged).

## Credentials / env

- Sheets auth: `PDWKEND_SA_KEY_JSON` (inline, takes precedence) or `GOOGLE_APPLICATION_CREDENTIALS` / `PDWKEND_SA_KEY_FILE` (path). See `.env.example`.
- The target sheet must be shared as Editor with the service account's `client_email`; a missing share looks identical to a wrong spreadsheet ID. The spreadsheet ID is passed per tool call, not via env.
- `.mcp.json` hardcodes absolute machine paths and a placeholder `GOOGLE_APPLICATION_CREDENTIALS`; edit both on a new machine.
- Never read or commit `.env` or the service-account `*.json` key in the repo root.
