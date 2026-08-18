/**
 * Adapters throw these instead of degrading to a made-up number.
 *
 * There is deliberately no code path in this repo from "live fetch failed" to
 * "return a plausible price". If an adapter cannot get a real figure it says so,
 * and the agent tells the user it couldn't price that leg.
 */

export class LiveFetchUnavailableError extends Error {
  readonly code = "LIVE_FETCH_UNAVAILABLE";
  constructor(
    message: string,
    readonly detail: {
      /** Which adapter/operator couldn't answer. */
      source: string;
      /** Machine-readable cause, so the agent can phrase it correctly. */
      reason:
        | "booking_window_not_open"
        | "no_service_on_route"
        | "sold_out"
        | "upstream_error"
        | "upstream_timeout"
        | "rate_limited"
        | "not_configured"
        | "parse_failed";
      source_url?: string;
      /** For booking_window_not_open: when tickets are expected to go on sale. */
      retry_after?: string;
    },
  ) {
    super(message);
    this.name = "LiveFetchUnavailableError";
  }

  /** One-line phrasing the agent can surface verbatim without inventing a number. */
  get userMessage(): string {
    const { source, reason, retry_after } = this.detail;
    switch (reason) {
      case "booking_window_not_open":
        return `${source}: booking not open yet${retry_after ? ` (expected ${retry_after})` : ""} — no live price available.`;
      case "no_service_on_route":
        return `${source}: no service on this route/date.`;
      case "sold_out":
        return `${source}: sold out for this date.`;
      case "rate_limited":
        return `${source}: rate-limited, couldn't fetch a live price.`;
      case "not_configured":
        return `${source}: not configured (missing credentials) — no live price available.`;
      case "upstream_timeout":
        return `${source}: timed out, couldn't fetch a live price.`;
      default:
        return `${source}: couldn't fetch a live price.`;
    }
  }
}

export class FeeInclusionError extends Error {
  readonly code = "FEE_INCLUSION";
  constructor(
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FeeInclusionError";
  }
}

export class NotImplementedError extends Error {
  readonly code = "NOT_IMPLEMENTED";
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
