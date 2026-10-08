/**
 * Human-in-the-loop award checks (issue #4).
 *
 * No program offers an award-search API we can use, and automating their logged-in
 * sites risks their terms of service. So this module fetches nothing: it builds
 * links to each program's own award search and tells the user what to enter. The
 * user reads the live points price themselves. There is deliberately no points
 * figure anywhere in here (hard requirement #1).
 *
 * Prefill URL formats are NOT verified against the live sites. A program with
 * `prefill: "unverified"` gets a best-known deep link, labelled as such in the
 * output; flip it to "verified" once confirmed in a browser. Programs with no known
 * prefill link to their search page and list the values to enter.
 */

export const AWARD_PROGRAMS = ["flying_blue", "united", "delta", "american", "alaska"] as const;
export type AwardProgram = (typeof AWARD_PROGRAMS)[number];

export const AWARD_CABINS = ["economy", "premium_economy", "business", "first"] as const;
export type AwardCabin = (typeof AWARD_CABINS)[number];

export const PROGRAM_LABELS: Record<AwardProgram, string> = {
  flying_blue: "Flying Blue",
  united: "United MileagePlus",
  delta: "Delta SkyMiles",
  american: "AAdvantage",
  alaska: "Alaska Atmos Rewards",
};

export interface AwardCheckQuery {
  origin: string;
  destination: string;
  /** YYYY-MM-DD. */
  date: string;
  adults: number;
  cabin: AwardCabin;
}

export type PrefillStatus = "verified" | "unverified" | "none";

export interface AwardCheckLink {
  program: AwardProgram;
  label: string;
  url: string;
  prefill: PrefillStatus;
  /** What the user should enter by hand when the link doesn't prefill it. */
  enter: string;
}

const LANDING: Record<AwardProgram, string> = {
  flying_blue: "https://www.klm.com/search/advanced",
  united: "https://www.united.com/en/us/book-flight/united-awards",
  delta: "https://www.delta.com/flight-search/book-a-flight",
  american: "https://www.aa.com/booking/find-flights",
  alaska: "https://www.alaskaair.com/search",
};

const UNITED_CABIN: Record<AwardCabin, string> = {
  economy: "7",
  premium_economy: "7",
  business: "9",
  first: "9",
};

/** Airport/city text goes in as-is; programs resolve codes, so uppercase 3-letter codes. */
function place(s: string): string {
  const t = s.trim();
  return /^[A-Za-z]{3}$/.test(t) ? t.toUpperCase() : t;
}

const ALASKA_CABIN_NOTE = "Select the cabin on the results page.";

function enterText(q: AwardCheckQuery): string {
  const cabin = q.cabin.replace("_", " ");
  return `${place(q.origin)} → ${place(q.destination)}, ${q.date}, ${q.adults} adult${q.adults > 1 ? "s" : ""}, ${cabin}, one way, pay with miles/points`;
}

const BUILDERS: Record<AwardProgram, (q: AwardCheckQuery) => { url: string; prefill: PrefillStatus }> = {
  // KLM's advanced search page (Flying Blue miles are spent on klm.com / airfrance.com).
  // Cannot be deep-linked: after a search the results URL is a bare
  // https://www.klm.com/search/flights/0 and the query lives in the session.
  flying_blue: () => ({ url: LANDING.flying_blue, prefill: "none" }),
  delta: () => ({ url: LANDING.delta, prefill: "none" }),
  american: () => ({ url: LANDING.american, prefill: "none" }),
  united: (q) => {
    const params = new URLSearchParams({
      f: place(q.origin),
      t: place(q.destination),
      d: q.date,
      tt: "1",
      sc: UNITED_CABIN[q.cabin],
      px: String(q.adults),
      taxng: "1",
      clm: UNITED_CABIN[q.cabin],
      // tqp=R with mm=1 is the "Money + Miles" search (confirmed in a browser for
      // economy, one way). tqp=A did not switch the results to miles.
      tqp: "R",
      mm: "1",
    });
    // Only the economy mapping has been checked; other cabins' sc/clm codes are guesses.
    return {
      url: `https://www.united.com/en/us/fsr/choose-flights?${params}`,
      prefill: q.cabin === "economy" ? "verified" : "unverified",
    };
  },
  alaska: (q) => {
    const params = new URLSearchParams({
      A: String(q.adults),
      C: "0",
      L: "0",
      O: place(q.origin),
      D: place(q.destination),
      OD: q.date,
      RT: "false",
      ShoppingMethod: "onlineaward",
    });
    // Confirmed in a browser: lands on a one-way award search (cabin is chosen on the results page).
    return { url: `https://www.alaskaair.com/search/results?${params}`, prefill: "verified" };
  },
};

export function buildAwardCheckLinks(
  query: AwardCheckQuery,
  programs: readonly AwardProgram[] = AWARD_PROGRAMS,
): AwardCheckLink[] {
  return programs.map((program) => {
    const { url, prefill } = BUILDERS[program](query);
    return {
      program,
      label: PROGRAM_LABELS[program],
      url,
      prefill,
      enter:
        enterText(query) +
        (program === "alaska" ? `. ${ALASKA_CABIN_NOTE}` : "") +
        (program === "flying_blue"
          ? ". Log in to your Flying Blue account on KLM first, then switch on \"Book with my … Miles\" before searching. Results show miles + cash per person, and the date strip lets you compare nearby days"
          : ""),
    };
  });
}

export function renderAwardCheckTable(links: AwardCheckLink[]): string {
  const rows = links.map((l) => {
    const how =
      l.prefill === "none"
        ? `Search page only — enter: ${l.enter}`
        : l.prefill === "unverified"
          ? "Prefilled link (format unverified — if it doesn't land on an award search, use the search page and enter the details by hand)"
          : "Prefilled";
    return `| ${l.label} | [Open award search](${l.url}) | ${how} |`;
  });
  return ["| Program | Link | How |", "|---|---|---|", ...rows].join("\n");
}

export const AWARD_CHECK_GUIDANCE =
  "No points prices were fetched. Open each link and read the live price there. An award is " +
  "points plus cash taxes/surcharges, both per person: compare both, and confirm there are seats " +
  "for the whole party before relying on it.";
