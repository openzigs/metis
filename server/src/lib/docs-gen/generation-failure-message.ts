/**
 * #52 — the user-facing reason a documentation generation failed.
 *
 * A failed generation used to persist `String(err)` on the row, and
 * `GET /projects/:projectId/docs/:docId` returned it verbatim: provider response
 * bodies, file paths, SQL error text. The socket path already sent only a
 * generic message (#254); the REST detail payload bypassed that rule.
 *
 * Every message a client can now see is one of the fixed strings below. A
 * failure is classified by its HTTP status (when the error carries one) and by
 * a few well-known phrases in its message — never echoed. The raw error stays
 * in the server log, where `generateDocumentAsync` already writes it.
 */
import { GENERATION_INTERRUPTED_MESSAGE } from "./interrupted-generations.js";
import { sectionFailedWarning } from "./grounding/degraded-warnings.js";

export const GENERATION_FAILED_MESSAGE =
  "Document generation failed. The details are in the server log; regenerate the document to try again.";

export const GENERATION_PROVIDER_BALANCE_MESSAGE =
  "The AI provider refused the request: 402 Insufficient Balance. Top up the provider account, then regenerate the document.";

export const GENERATION_BUDGET_EXCEEDED_MESSAGE =
  "This project's monthly token budget is used up. Raise the budget or wait for next month, then regenerate the document.";

export const GENERATION_PROVIDER_RATE_LIMITED_MESSAGE =
  "The AI provider rate-limited the request (429 Too Many Requests). Wait a few minutes, then regenerate the document.";

export const GENERATION_PROVIDER_AUTH_MESSAGE =
  "The AI provider rejected the configured credentials (401/403). Check the AI provider settings, then regenerate the document.";

/**
 * #98 — the most common real failure in local use: the provider host (a local
 * Ollama server, say) is down or unreachable, and undici throws only
 * `TypeError: fetch failed` with the OS error under `.cause`.
 */
export const GENERATION_PROVIDER_UNREACHABLE_MESSAGE =
  "The AI provider could not be reached (connection failed). Check that the provider host — for example a local Ollama server — is running and reachable from the METIS server, then regenerate the document.";

/** Every string a client may receive as a failed generation's `errorMessage`. */
const SAFE_MESSAGES: ReadonlySet<string> = new Set([
  GENERATION_INTERRUPTED_MESSAGE,
  GENERATION_FAILED_MESSAGE,
  GENERATION_PROVIDER_BALANCE_MESSAGE,
  GENERATION_BUDGET_EXCEEDED_MESSAGE,
  GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
  GENERATION_PROVIDER_AUTH_MESSAGE,
  GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
]);

// An HTTP status named as one: "returned 402", "status 429", "HTTP 401",
// "(403)", or a message that starts with it ("402 Insufficient Balance", the
// OpenAI SDK's form). A bare number elsewhere in a message is not a status.
// Literal patterns, one per status set (a RegExp built from a string is a
// Semgrep finding even when the string is a constant).
const STATUS_402 =
  /(?:returned|status(?: code)?|HTTP|code)[:\s]*402\b|\(402\)|^(?:\w*Error:\s*)?402\b/i;
const STATUS_429 =
  /(?:returned|status(?: code)?|HTTP|code)[:\s]*429\b|\(429\)|^(?:\w*Error:\s*)?429\b/i;
const STATUS_401_403 =
  /(?:returned|status(?: code)?|HTTP|code)[:\s]*(?:401|403)\b|\((?:401|403)\)|^(?:\w*Error:\s*)?(?:401|403)\b/i;

function readStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

function readCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

// Connection-establishment failures only: the host refused, does not resolve,
// has no route, or never answered the connect. A reset mid-response is not
// "unreachable" and stays generic.
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const UNREACHABLE_TEXT =
  /(?:^|[^\w])fetch failed\b|\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)\b|\bconnect ETIMEDOUT\b/;

/**
 * True when `err` says the provider host could not be connected to. undici
 * nests the OS error under `.cause`, so both levels are read.
 */
export function isProviderUnreachable(err: unknown): boolean {
  const cause =
    err && typeof err === "object" && "cause" in err
      ? (err as { cause?: unknown }).cause
      : undefined;
  for (const e of [err, cause]) {
    const code = readCode(e);
    if (code !== undefined && UNREACHABLE_CODES.has(code)) return true;
    if (UNREACHABLE_TEXT.test(readMessage(e))) return true;
  }
  return false;
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "";
}

/**
 * The user-safe message to persist for a generation that threw `err`. Accepts a
 * stored string too, so a row written before #52 can be classified on read.
 */
export function generationFailureMessage(err: unknown): string {
  if (typeof err === "string" && SAFE_MESSAGES.has(err)) return err;
  const status = readStatus(err);
  const message = readMessage(err);

  if (readCode(err) === "BUDGET_EXCEEDED" || /monthly budget exceeded/i.test(message)) {
    return GENERATION_BUDGET_EXCEEDED_MESSAGE;
  }
  if (
    status === 402 ||
    STATUS_402.test(message) ||
    /insufficient[_\s-]*(?:balance|funds|credits?|quota)/i.test(message)
  ) {
    return GENERATION_PROVIDER_BALANCE_MESSAGE;
  }
  if (
    status === 429 ||
    readCode(err) === "AI_RATE_LIMITED" ||
    STATUS_429.test(message) ||
    /rate[_\s-]?limit|too many requests|ThrottlingException/i.test(message)
  ) {
    return GENERATION_PROVIDER_RATE_LIMITED_MESSAGE;
  }
  if (
    status === 401 ||
    status === 403 ||
    STATUS_401_403.test(message) ||
    /invalid[_\s-]*api[_\s-]*key|incorrect api key|authentication[_\s-]*error/i.test(message)
  ) {
    return GENERATION_PROVIDER_AUTH_MESSAGE;
  }
  if (isProviderUnreachable(err)) return GENERATION_PROVIDER_UNREACHABLE_MESSAGE;
  return GENERATION_FAILED_MESSAGE;
}

/**
 * The `errorMessage` a client may see for a generated document.
 *
 * #86 — a non-`failed` row's message used to pass through VERBATIM on the
 * reasoning that a legacy `degraded` row carries pre-#252 warning JSON "which
 * METIS wrote itself". METIS *formatted* that blob, but the pre-#67
 * `sectionFailedWarning(label, String(err))` embedded the exception inside it,
 * and the UI's `resolveDocWarnings` legacy fallback parses and renders it — so
 * the exposure #52 closed for a `failed` row, and #67 closed for the `warnings`
 * column, survived here for every document generated before #252.
 *
 * Both arms now go through the fixed vocabulary:
 *
 * - a `failed` row's message → {@link generationFailureMessage}, as since #52;
 * - anything else → {@link legacyWarningJson}, which re-derives the detail of
 *   the embedded warnings through {@link publicDocWarnings} and collapses any
 *   other content to a fixed message.
 */
export function publicGenerationErrorMessage(
  status: string,
  errorMessage: string | null | undefined,
): string | null {
  if (errorMessage == null) return null;
  if (status !== "failed") return legacyWarningJson(errorMessage);
  return generationFailureMessage(errorMessage);
}

/**
 * #86 — sanitise the legacy `errorMessage` blob of a non-`failed` row.
 *
 * The shape is re-derived rather than trusted: pre-#252 rows hold `DocWarning[]`
 * JSON, which is handed to {@link publicDocWarnings} so each `section-failed`
 * warning's detail is re-classified exactly as the `warnings` column's is —
 * keeping the array parseable by the UI's legacy fallback, which drops any entry
 * without a string `message`. Anything else in that column (a raw exception
 * string a pre-#52 row left behind, a JSON object, `"null"`) is not a warning
 * list and cannot be repaired into one, so it collapses to the fixed vocabulary.
 */
function legacyWarningJson(errorMessage: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorMessage);
  } catch {
    return generationFailureMessage(errorMessage);
  }
  if (!Array.isArray(parsed)) return generationFailureMessage(errorMessage);
  return JSON.stringify(publicDocWarnings(parsed));
}

/**
 * #67 — the `warnings` a client may see for a generated document.
 *
 * A `section-failed` warning built before #67 appended up to 300 characters of
 * `String(err)` to its message, and that column is returned verbatim by
 * `GET /projects/:projectId/docs/:docId` and rendered by the UI banner — the
 * same exposure {@link publicGenerationErrorMessage} closes for a *failed*
 * row's `errorMessage`, on the *degraded* path. Those rows are still in the
 * database, so the read path re-derives their detail through
 * {@link generationFailureMessage}: a provider 402 stays recognisable as a
 * balance problem, anything unrecognised collapses to the generic message.
 *
 * A warning built by {@link sectionFailedWarning} carries `detailSafe`, so a
 * post-#67 warning is passed through with its METIS-authored detail intact
 * (the DB-schema synthesizer's "N of M tables described" text, for one). The
 * flag is the discriminator precisely because no pre-#67 row can have it.
 *
 * Every other warning kind is returned untouched: none of them is ever built
 * from an exception. The value is typed `unknown` because it comes off a Prisma
 * `Json?` column, and anything that is not an array of objects — `null`, the
 * pre-#252 string form — passes straight through.
 */
export function publicDocWarnings(warnings: unknown): unknown {
  if (!Array.isArray(warnings)) return warnings;
  return warnings.map((warning) => {
    if (warning == null || typeof warning !== "object" || Array.isArray(warning)) return warning;
    const w = warning as Record<string, unknown>;
    if (w.kind !== "section-failed" || w.detailSafe === true) return warning;
    const section = typeof w.section === "string" ? w.section : "Document";
    const raw = typeof w.message === "string" ? w.message : "";
    // Only the vocabulary's own output reaches the message; the legacy text is
    // read solely to CLASSIFY it, never echoed.
    const { message, detailSafe } = sectionFailedWarning(section, generationFailureMessage(raw));
    return { ...w, message, detailSafe };
  });
}
