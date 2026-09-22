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

/** Every string a client may receive as a failed generation's `errorMessage`. */
const SAFE_MESSAGES: ReadonlySet<string> = new Set([
  GENERATION_INTERRUPTED_MESSAGE,
  GENERATION_FAILED_MESSAGE,
  GENERATION_PROVIDER_BALANCE_MESSAGE,
  GENERATION_BUDGET_EXCEEDED_MESSAGE,
  GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
  GENERATION_PROVIDER_AUTH_MESSAGE,
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
  return GENERATION_FAILED_MESSAGE;
}

/**
 * The `errorMessage` a client may see for a generated document. Only a
 * `failed` row's message is an error reason; a legacy `degraded` row may still
 * carry pre-#252 warning JSON the UI parses, which METIS wrote itself, so it
 * passes through.
 */
export function publicGenerationErrorMessage(
  status: string,
  errorMessage: string | null | undefined,
): string | null {
  if (errorMessage == null) return null;
  if (status !== "failed") return errorMessage;
  return generationFailureMessage(errorMessage);
}
