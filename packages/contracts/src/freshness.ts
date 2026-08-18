import { randomUUID } from "node:crypto";

/**
 * Hard requirement #1: never quote a price you haven't just fetched.
 *
 * A `fetched_at` timestamp alone doesn't get you there — the earlier prototype's
 * failure was an estimate *lingering* in the conversation and being treated as
 * confirmed later. So every price carries the identity of the fetch session that
 * produced it, and freshness is checked against two independent things:
 *
 *   1. session — was this fetched by the process currently answering?
 *   2. age     — even in-session, a fare fetched 40 minutes ago is not a quote.
 */

export const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface FetchSession {
  readonly id: string;
  readonly started_at: string;
}

let session: FetchSession | undefined;

/** The fetch session for this process. One server process = one session. */
export function currentSession(): FetchSession {
  session ??= { id: randomUUID(), started_at: new Date().toISOString() };
  return session;
}

/** Test-only: start a fresh session so suites don't leak state into each other. */
export function resetSession(): FetchSession {
  session = { id: randomUUID(), started_at: new Date().toISOString() };
  return session;
}

export interface FetchStamp {
  fetched_at: string;
  session_id: string;
}

/**
 * Call this at the moment a live response comes back off the wire — not when the
 * tool was invoked, and never when assembling a response from cached data.
 */
export function stampFetch(now: Date = new Date()): FetchStamp {
  return { fetched_at: now.toISOString(), session_id: currentSession().id };
}

export class StalePriceError extends Error {
  readonly code = "STALE_PRICE";
  constructor(
    message: string,
    readonly detail: { fetched_at: string; session_id: string; age_ms: number },
  ) {
    super(message);
    this.name = "StalePriceError";
  }
}

export interface Stamped {
  fetched_at: string;
  session_id: string;
}

export function ageMs(stamped: Stamped, now: Date = new Date()): number {
  return now.getTime() - new Date(stamped.fetched_at).getTime();
}

export interface FreshnessOptions {
  ttlMs?: number;
  now?: Date;
  /** Override the session to check against. Defaults to this process's session. */
  sessionId?: string;
}

export function isFresh(stamped: Stamped, opts: FreshnessOptions = {}): boolean {
  const { ttlMs = DEFAULT_TTL_MS, now = new Date(), sessionId = currentSession().id } = opts;
  if (stamped.session_id !== sessionId) return false;
  const age = ageMs(stamped, now);
  return age >= 0 && age <= ttlMs;
}

/**
 * Throws unless the price was fetched by this session, within the TTL.
 *
 * Every tool that *displays* a price calls this immediately before returning.
 * A price that fails here must be re-fetched or withdrawn — never softened into
 * an estimate and shown anyway.
 */
export function assertFresh(stamped: Stamped, opts: FreshnessOptions = {}): void {
  const { ttlMs = DEFAULT_TTL_MS, now = new Date(), sessionId = currentSession().id } = opts;
  const age = ageMs(stamped, now);

  if (stamped.session_id !== sessionId) {
    throw new StalePriceError(
      `Price came from a different fetch session (${stamped.session_id}); re-fetch before showing it.`,
      { fetched_at: stamped.fetched_at, session_id: stamped.session_id, age_ms: age },
    );
  }
  if (Number.isNaN(age)) {
    throw new StalePriceError(`fetched_at is not a valid timestamp: ${stamped.fetched_at}`, {
      fetched_at: stamped.fetched_at,
      session_id: stamped.session_id,
      age_ms: age,
    });
  }
  if (age < 0) {
    throw new StalePriceError(`fetched_at is in the future: ${stamped.fetched_at}`, {
      fetched_at: stamped.fetched_at,
      session_id: stamped.session_id,
      age_ms: age,
    });
  }
  if (age > ttlMs) {
    throw new StalePriceError(
      `Price is ${Math.round(age / 1000)}s old (TTL ${Math.round(ttlMs / 1000)}s); re-fetch before showing it.`,
      { fetched_at: stamped.fetched_at, session_id: stamped.session_id, age_ms: age },
    );
  }
}
