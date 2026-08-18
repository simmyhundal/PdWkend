import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { LiveFetchUnavailableError } from "@pdwkend/contracts";

/**
 * Shared headless-browser lifecycle.
 *
 * Launch costs ~1s, so the browser is kept warm across tool calls and only the
 * context is per-fetch — that keeps cookies and consent state from bleeding
 * between searches while staying fast enough to price several legs in a turn.
 */

const NAV_TIMEOUT_MS = Number(process.env.PDWKEND_NAV_TIMEOUT_MS ?? 45_000);
const HEADLESS = process.env.PDWKEND_HEADFUL !== "1";

/** Third-party noise that costs seconds and never carries a fare. */
const BLOCKED_HOST_FRAGMENTS = [
  "google-analytics",
  "googletagmanager",
  "doubleclick",
  "facebook.net",
  "hotjar",
  "optimizely",
  "segment.io",
  "adobedtm",
  "demdex",
  "qualtrics",
  "newrelic",
  "sentry.io",
  "cdn.speedcurve",
];

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

export interface PageSession {
  page: Page;
  context: BrowserContext;
  close: () => Promise<void>;
}

export class BrowserPool {
  #browser: Browser | undefined;
  #launching: Promise<Browser> | undefined;

  async #launch(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    this.#launching ??= chromium
      .launch({
        headless: HEADLESS,
        args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
      })
      .then((b) => {
        this.#browser = b;
        this.#launching = undefined;
        return b;
      })
      .catch((err) => {
        this.#launching = undefined;
        throw new LiveFetchUnavailableError(
          `Couldn't launch a browser: ${err instanceof Error ? err.message : String(err)}. ` +
            `Run \`npx playwright install chromium\`.`,
          { source: "browser", reason: "not_configured" },
        );
      });
    return this.#launching;
  }

  /**
   * A fresh, isolated page. Always call `close()` — leaked contexts pin memory
   * for the life of the server process.
   */
  async newPage(opts: { locale?: string; timezone?: string } = {}): Promise<PageSession> {
    const browser = await this.#launch();
    const context = await browser.newContext({
      locale: opts.locale ?? "en-GB",
      timezoneId: opts.timezone ?? "Europe/London",
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      serviceWorkers: "block",
    });
    context.setDefaultTimeout(NAV_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    await context.route("**/*", (route) => {
      const req = route.request();
      const url = req.url();
      if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) return route.abort();
      if (BLOCKED_HOST_FRAGMENTS.some((frag) => url.includes(frag))) return route.abort();
      return route.continue();
    });

    const page = await context.newPage();
    return {
      page,
      context,
      close: async () => {
        await context.close().catch(() => {});
      },
    };
  }

  async close(): Promise<void> {
    await this.#browser?.close().catch(() => {});
    this.#browser = undefined;
  }
}

/**
 * Wraps a scrape so any failure surfaces as LiveFetchUnavailableError rather than
 * a raw Playwright error. Requirement #1 depends on there being no path from
 * "the page didn't load" to "here's a number".
 */
export async function withPage<T>(
  pool: BrowserPool,
  source: string,
  sourceUrl: string,
  fn: (page: Page) => Promise<T>,
  opts: { locale?: string; timezone?: string } = {},
): Promise<T> {
  const session = await pool.newPage(opts);
  try {
    return await fn(session.page);
  } catch (err) {
    if (err instanceof LiveFetchUnavailableError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /timeout|Timeout|exceeded/.test(message);
    throw new LiveFetchUnavailableError(`${source} scrape failed: ${message}`, {
      source,
      reason: timedOut ? "upstream_timeout" : "parse_failed",
      source_url: sourceUrl,
    });
  } finally {
    await session.close();
  }
}

/**
 * Resolve with the body of a named GraphQL operation.
 *
 * Reading the operation's own JSON beats scraping rendered prices out of the DOM:
 * the payload carries fare class, seat counts and exact times that the page only
 * partially renders, and it doesn't move when the site is restyled.
 *
 * Register this *before* navigating, or the response can land first.
 */
export function waitForGraphQLOp<T = unknown>(
  page: Page,
  operationName: string,
  opts: { timeoutMs?: number; urlFragment?: string } = {},
): Promise<T | undefined> {
  const { timeoutMs = NAV_TIMEOUT_MS, urlFragment = "site-api.eurostar.com" } = opts;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    const onResponse = async (res: import("playwright").Response) => {
      if (!res.url().includes(urlFragment)) return;
      let op: string | undefined;
      try {
        op = JSON.parse(res.request().postData() ?? "null")?.operationName;
      } catch {
        return;
      }
      if (op !== operationName) return;
      try {
        const body = (await res.json()) as T;
        clearTimeout(timer);
        page.off("response", onResponse);
        resolve(body);
      } catch {
        // Malformed body — keep listening for a retry of the same op.
      }
    };
    page.on("response", onResponse);
  });
}

/** Best-effort cookie-banner dismissal. Never throws — a banner that isn't there is fine. */
export async function dismissConsent(page: Page, selectors: string[]): Promise<void> {
  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 2_000 })) {
        await el.click({ timeout: 3_000 });
        await page.waitForTimeout(400);
        return;
      }
    } catch {
      // Next selector.
    }
  }
}
