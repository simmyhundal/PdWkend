# Field notes: planning Chile + Patagonia with an AI agent (Oct 4–7, 2026)

A real planning session, used as research for what Paddy Weekend should do. The agent
was Claude Code (Opus 5.5) with a browser, Google Flights, the Booking.com MCP, Kayak,
OSRM routing, and this repo's own flight tool. The trip: a friend's wedding in
Santiago, and what to do in the days before it.

The output was a shareable trip page (maps, day plan, booking list, live budget).
Getting there took four days of conversation, about a dozen user turns, and a lot
of wasted work. The notes below are about the waste.

## The trip, as it was finally known

| Constraint | Value | When it was learned |
|---|---|---|
| Event | Wedding at Museo de la Moda, Vitacura, Santiago, Sat Jan 9, 2027 | Turn 2 (venue), turn 3 (date) |
| Wedding activities start | Wed Jan 6 | Turn 1 said "wedding starts Jan 6"; corrected in turn 3 |
| Free window | Jan 2–5 | Turn 3 |
| Arrival | Delta DL147, ATL 20:25 Jan 1 → SCL 07:40 Jan 2 (already booked) | Turn 4 |
| Origin | Atlanta (family over New Year's), not San Francisco | Turn 4 |
| Days after wedding | None | Turn 2 |
| Style | Food, wine, scenery, some adventure | Turn 2 |
| Destination | Torres del Paine | Turn 3 (user raised Patagonia) |
| Lodging budget | Under $1K for all 3 nights, for two | Turn 5, after luxury research |

Final plan: fly SCL→Punta Arenas, one-way car to Puerto Natales, night in town,
night in a set-up tent at Las Torres Central (Base Torres trailhead), night at
Hostería Pehoé, fly PNT→SCL Jan 5. About $2,270–2,550 for two depending on meal plan.

## What went wrong, in order

### 1. Constraints arrived one at a time, and each one invalidated earlier work

- Searched SFO→SCL fares for three dates before learning they fly from Atlanta on a
  ticket they already hold. That search was wasted.
- The first Patagonia plan used the 08:50/09:00 SCL→Puerto Natales flights. The
  booked Delta flight lands 07:40, on a separate ticket (immigration + bag recheck),
  which makes those flights unworkable. Re-routed via Punta Arenas plus a 3-hour drive.
- "Wedding starts Jan 6" meant "activities start Jan 6; wedding is Jan 9". The agent
  took it literally.

**The agent asked its key questions late.** It led with a full itinerary built on
guesses (wedding location, origin, budget), then asked. The user's first message
gave enough to ask three high-leverage questions first: where is the wedding, where
are you flying from, any fixed bookings yet.

### 2. Budget was never asked, so the first lodging recommendation was 10x over

The agent recommended Awasi and the Las Torres all-inclusive and spent several tool
calls pricing them (Las Torres: $8,660 for 3 nights for two). The user's budget was
under $1K. This is the single most expensive miss of the session.

Note the tension with `prompts/project_instructions.md` rule 3: *"Don't ask about
budget if nothing you'd show would change."* Here lodging spans $90 to $3,000+ a
night for the same place. When tiers differ by an order of magnitude, budget changes
everything and should be asked before any lodging research, or the first answer
should show all tiers side by side.

### 3. Most of the inventory that mattered isn't on the OTAs

| Source | What happened |
|---|---|
| Booking.com MCP | Awasi and Hotel Las Torres returned "no availability". They aren't sold there at all, but the error looks the same as "sold out". |
| lastorres.com | Package prices were on the page, but the online calendar wouldn't page past October (all-inclusive) or December (refugios). The agent concluded "January isn't bookable online". |
| book.lastorres.com | **The user found this booking engine themselves**, pasted screenshots, and it had real January inventory: Francés tent $960 / 3 nights, Central tent $320 / 1 night, meal plans $140 / $90 / $70 pp/day. That became the core of the final plan. |
| awasi.com | Booking widget (Selfbook) never rendered; rates not published. The agent fell back on a remembered "$1,500–2,500+ pp/night" ballpark, labeled as unverified. |
| Vertice (Paine Grande, Grey refugios) | Multi-step booking SPA hung on "Wait a moment please…". Never got a price. |

Park concession operators (Las Torres, Vertice) and luxury lodges sell direct. An
agent limited to OTA inventory recommends Puerto Natales hotels 2+ hours from every
trailhead, because that's all it can see.

**The user's screenshots were the most valuable input in the whole session.** A
human in a real browser reached inventory the agent couldn't, and a screenshot
carried it back. That's a pattern to design for, not a workaround.

### 4. Availability rules hid behind "no availability"

- Casa Kauken showed $559 for 3 nights, but "no availability" for a single night.
  Almost certainly a minimum stay. It was recommended as part of a split stay and
  then dropped once this surfaced.
- Hostería Pehoé was $390 for Jan 3 and $500 for Jan 4. The agent quoted the Jan 3
  price, then the plan moved Pehoé to Jan 4. A per-stay price doesn't carry over
  when the night changes.
- Las Torres Francés showed meal plans as "Unavailable" while Central had them for
  the same dates.

### 5. Feasibility errors the agent only caught because it happened to know

- **Las Torres Francés is walk-in only** (mid-W-Trek: catamaran + 2.5 h hike). The
  user selected it for all three nights. Arriving Jan 2 at 16:21 in Punta Arenas
  and flying out of PNT at 13:00 on Jan 5 makes that impossible. Nothing in the
  booking engine says so.
- Neruda's houses close Mondays, so Valparaíso had to move to the Sunday. This came
  from model memory, unverified.
- Self-transfer at SCL: international arrival → domestic departure on separate
  tickets needs time for immigration, bag claim and re-check. The agent used
  roughly 3 h as a judgment call. No rule backed it.

### 6. Distance and time were hard to see until there was a map

The user asked "Casa Kauken seems very far from the park?" It isn't farther than
anywhere else in Puerto Natales; the whole base is 2–2.5 h from the trailheads.
OSRM gave 132–162 min per leg, which made the park days 13–14 hours door to door.
That was the real problem, and it pushed the plan toward nights inside the park.
The user later asked for a map highlighting where they'd be on each day. Spatial
context should come first, not last.

### 7. Facts of very different reliability were presented in the same voice

Live-fetched (Google Flights fares, Kayak car prices, Booking.com rates, Las Torres
package prices) sat next to things the agent recalled or estimated:

- Awasi rates, park entry (~$100 for two), fuel (~$120), Grey Glacier boat (~$100+ pp)
- pasesparques.cl as the park ticket site; whether Base Torres needs a reservation
- Neruda Monday closures, El Morado gate times, whether trail streams are drinkable
- Drive-time ranges mixing OSRM output with "OSRM is slow on gravel"
- Whether the rental quote includes the one-way drop-off fee

The agent flagged some of these in prose. This repo already makes "quote vs
estimate" a type distinction for fares (`FareQuote` vs `PriceEstimate`). Nothing like
that exists for lodging, cars, opening hours or logistics.

### 8. Tooling friction ate a lot of the session

- Kayak car URL with city slugs resolved to "Glen Flora → Monticello" (US towns).
  Airport codes (`/cars/PUQ/PNT/...`) worked.
- Python `urllib` failed TLS against OSRM; `curl` worked.
- Overpass API returned 406 without a `User-Agent`.
- Cookie banners, calendar widgets with hidden "next" arrows, SPAs that never finish
  loading. Many screenshots and clicks for little result.
- The desktop app told the user several times that the agent had gone quiet while
  it fought these.

### 9. The itinerary only existed in chat until the end

Every change (budget, arrival time, a new screenshot) meant re-deriving the day
plan, the booking list and the totals in prose. The user then asked for:
1. A shareable page for their spouse.
2. A **meal-plan selector that updates the totals**. Totals should be derived from
   choices, not restated.
3. A map with the routes highlighted per day.

So the user wanted the product: a live itinerary model with derived prices, shared
with a travel partner.

### 10. Responses were long

Most replies were a few tables plus several paragraphs. The project's own rule
("a table, then one to three sentences") would have helped. Long answers also made
it harder for the user to notice when an assumption was wrong.

## What the product should do

Ordered by how much time each would have saved in this session.

1. **A trip brief, captured first and stored as data.** Fixed anchors (booked
   flights with times and ticket boundaries, event dates, venue), free window,
   origin, party size, budget **per category**, style. Ask the 2–3 questions that
   change the most before searching anything. When an anchor changes, re-validate
   everything downstream automatically (e.g. arrival time → connection feasibility).

2. **Show lodging tiers side by side** (budget / mid / splurge) with real prices,
   instead of leading with one tier. Or ask budget first whenever tiers span 5x+.

3. **A feasibility checker that runs before anything is recommended:**
   - Self-transfer minimum connection time (international → domestic, bag recheck)
   - Drive times on real roads, with a surface factor for gravel and daylight hours
   - Access mode per property (road / boat / walk-in) and ferry or catamaran times
   - Minimum stays, per-night price changes, check-in and check-out times
   - Opening days for attractions
   Each check returns pass / fail / unknown with a source.

4. **Typed provenance for every fact, not just fares.** Extend the
   `FareQuote` / `PriceEstimate` split to lodging, cars, entry fees and logistics:
   `fetched` (source + timestamp), `user_provided` (e.g. from a screenshot), or
   `recalled` (model memory, shown as an estimate and never formatted like a quote).

5. **Coverage for direct-sell inventory.** Adapters for the booking engines that
   matter in a destination, starting with park concessions (book.lastorres.com,
   Vertice). Where an adapter isn't possible, use the human-in-the-loop pattern
   from the award-points work (#4): build the deep link, have the user check it,
   and accept a **screenshot back as structured input**. Parse rates, meal plans
   and "Unavailable" flags from it.

6. **Distinguish "not listed" from "sold out" from "minimum stay".** The Booking.com
   tool's single "no availability" error caused two wrong turns.

7. **A split-stay optimizer.** Given candidate nights in town and in the park, pick
   the combination that fits the budget and minimizes driving. This session did it
   by hand three times (all Natales → Natales + Pehoé → Natales + Central + Pehoé).

8. **A living, shareable itinerary.** Map with per-day highlights, day plan, booking
   checklist in priority order (scarcest first: "only 5 cars"), and a budget derived
   from choices such as meal plans. Shared with the travel partner, synced to the
   Google Sheet this repo already writes.

9. **Fix the known adapter gotchas** before relying on them: airport-code URLs for
   Kayak, a `User-Agent` on Overpass/OSRM, `curl`-equivalent TLS.

## Questions to resolve before building

- How much should be asked up front vs inferred? The user gave a vague first message
  and seemed happy to iterate. Three focused questions would probably have been fine.
- Is a screenshot-in, structured-data-out flow acceptable as a primary path for
  direct-sell inventory, or only a fallback?
- What is the source of truth for drive times and access mode in parks? OSRM
  doesn't know about catamarans or walk-in camps.
- Per-viewer vs shared state for the trip page: should the meal plan be one shared
  decision or each person's own scenario?

## Addendum: firm pricing (later on Oct 7)

The user's main concern after the session: **fear of hallucinated availability and
stale prices or estimates.** Two findings.

### PdWkend's own flight tool wasn't used, and that is a dogfooding result in itself

`search_flight_fares` was connected all session. The agent never called it and
scraped Google Flights in the browser instead. Why:

1. **A stale memory note.** On Oct 4 the agent saved "the pdwkend flight tool returns
   GBP, so use Google Flights with `curr=USD` in the browser". Commit `ff74874` fixed
   the currency default a few hours later. The note was never updated, and the agent
   followed it without checking.
2. **The agent didn't check which project tools it had.** Nothing in the session
   prompted it to prefer the product's own tools over generic browsing.

Result: every flight price on the trip page went out without `fetched_at`, which is
exactly the failure the contracts package exists to prevent. Re-pricing with the tool
later moved SCL→PUQ from $126 to $123 and PNT→SCL from $194 to $193.

When it was used, it worked as designed: `fetched_at` and `session_id` on every
quote, curated to 3–5 options, `fee_confidence: "unconfirmed"` with a "before fees"
note about bags.

**Gap found in the tool:** called with `adults: 2`, the quote doesn't say whether
`total_price` is per person or for the whole party. (Comparing with a 1-adult search,
it's per person.) A firm-price contract needs an explicit `price_basis`
(`per_person` | `party_total`) and passenger count on every quote.

### Only flights had firm-pricing protection

| Item | How it was priced | Protection |
|---|---|---|
| Domestic flights | PdWkend tool (after the fix above) | `FareQuote`, timestamped, before-fees label |
| Hotels (Hostal America, Pehoé, Weskar) | Booking.com MCP | Live, but no timestamp and no freshness gate |
| Las Torres tent and meal plans | User's screenshots | None; a human read it off the screen |
| Rental car | Kayak in the browser | Live, but one-way drop-off fee not confirmed |
| Park entry, fuel, glacier boat, Awasi | Model memory or arithmetic | None; estimates shown beside quotes |

### What to build

- **Generalize the quote contract beyond fares:** lodging, car, park and activity
  quotes, each with `fetched_at`, `source_url` and fee rules for their own traps:
  one-way drop-off fees, minimum stays, per-night price changes (Pehoé was $390 on
  Jan 3 and $500 on Jan 4), per-person meal plans.
- **Typed availability results** instead of one "no availability" error:
  `available`, `sold_out`, `not_listed`, `min_stay_violated`, `not_yet_bookable`.
- **A third provenance kind between quote and estimate:** `user_provided`, for
  screenshots and existing bookings, stamped with when the user captured it.
- **Show provenance in the UI.** Trip page v4 now does this as a prototype:
  every price carries a Live / From you / Estimate badge and a source, live flight
  prices show their age and flag "re-check before booking" after 15 minutes (the
  contracts' `DEFAULT_TTL_MS`), estimates are colored differently, and flights are
  a separate block below the sub-total before the grand total.
- **Make the product's own tools the default.** The project prompt or skill should
  say: for any price, try the PdWkend tool first; browser scraping only when no tool
  covers the item, and label it.
