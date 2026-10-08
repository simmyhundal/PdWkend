---
name: debug-fare-adapter
description: Diagnose a broken live fare adapter (Eurostar, Snap, Google Flights) that returns no results or throws LiveFetchUnavailableError. Use when a fare search fails or parses wrongly.
---

Diagnose the failing Playwright adapter without weakening the repo's hard rules.

1. Identify the adapter: `mcp-servers/rail-fares/src/eurostar.ts`, `eurostar_snap.ts`, `aggregator.ts`, or `mcp-servers/flight-fares/src/google_flights.ts`. Shared browser plumbing is in `packages/sources/src/browser.ts`.
2. Reproduce with the browser visible: set `PDWKEND_HEADFUL=1` (and raise `PDWKEND_NAV_TIMEOUT_MS` if it's a timeout; default 45000).
3. Check the usual causes:
   - Eurostar: AWS WAF challenge, or the `NewBookingSearch` / `CheapestFaresSearch` GraphQL payload shape changed.
   - Snap: only sells within 14 days of travel, so empty results for later dates are expected.
   - Google Flights: DOM/selector changes; codeshare parsing in `splitCarriers` (new mid-word-capital brands belong in `INTERNAL_CAPS`; keep the sentinel printable ASCII and letter-free).
4. Fix the parsing/selectors, add or update an offline test in `tests/` using captured fixture data (tests must not hit live sites), then run `npm test` (it builds first).
5. Keep failures loud: adapters must throw `LiveFetchUnavailableError`, never return an estimate or cached price, and never bypass `createQuote`/`assertFresh`.
