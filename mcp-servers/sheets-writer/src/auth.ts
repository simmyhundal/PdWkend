import { readFileSync } from "node:fs";
import { google } from "googleapis";

/**
 * The JWT type is inferred from `google.auth` rather than imported from
 * `google-auth-library` directly: googleapis-common ships its own nested copy of
 * that package, and the two declarations are structurally incompatible, so an
 * explicit import produces a type error at the `google.sheets({ auth })` call.
 */
type JWT = InstanceType<typeof google.auth.JWT>;

/**
 * Service-account auth with the full `spreadsheets` scope.
 *
 * The scope matters more than it looks. The earlier prototype used a connector
 * limited to `drive.readonly`/`drive.file`, which can list a spreadsheet and even
 * create new ones, but cannot add a tab or write cells to a file the user already
 * owns — so "update the sheet" silently degraded to "here's a table, paste it in".
 * `spreadsheets` is the scope that permits writing to an existing file by ID.
 */
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export class SheetsAuthError extends Error {
  readonly code = "SHEETS_AUTH";
  constructor(message: string) {
    super(message);
    this.name = "SheetsAuthError";
  }
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function loadKey(): ServiceAccountKey {
  const inline = process.env.PDWKEND_SA_KEY_JSON;
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? process.env.PDWKEND_SA_KEY_FILE;

  let raw: string;
  if (inline) {
    raw = inline;
  } else if (path) {
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      throw new SheetsAuthError(
        `Couldn't read the service-account key at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    throw new SheetsAuthError(
      "No Google credentials configured. Set GOOGLE_APPLICATION_CREDENTIALS to the path of a " +
        "service-account key JSON file (or PDWKEND_SA_KEY_JSON to its contents), then share your " +
        "spreadsheet with the service account's email as an Editor.",
    );
  }

  let parsed: Partial<ServiceAccountKey>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccountKey>;
  } catch {
    throw new SheetsAuthError("The service-account key is not valid JSON.");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new SheetsAuthError(
      "The service-account key is missing client_email or private_key — is it a service-account " +
        "key rather than an OAuth client secret?",
    );
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

let cached: { client: JWT; email: string } | undefined;

export function getAuth(): { client: JWT; email: string } {
  if (cached) return cached;
  const key = loadKey();
  const client = new google.auth.JWT({
    email: key.client_email,
    // Keys pasted through env vars arrive with literal \n sequences.
    key: key.private_key.replace(/\\n/g, "\n"),
    scopes: [SHEETS_SCOPE],
  });
  const resolved = { client, email: key.client_email };
  cached = resolved;
  return resolved;
}

export function isConfigured(): boolean {
  return Boolean(
    process.env.PDWKEND_SA_KEY_JSON ??
      process.env.GOOGLE_APPLICATION_CREDENTIALS ??
      process.env.PDWKEND_SA_KEY_FILE,
  );
}

/** The address the user has to share their spreadsheet with. */
export function serviceAccountEmail(): string {
  return getAuth().email;
}
