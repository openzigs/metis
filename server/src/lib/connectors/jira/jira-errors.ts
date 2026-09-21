/**
 * Jira connector error type.
 *
 * Lifted out of `jira-client.ts` in #1054 so the SSRF-hardened raw-resource
 * fetcher (`raw-fetch.ts`) can throw it without creating an import cycle back
 * into the client. `jira-client.ts` re-exports it, so every existing
 * `import { JiraApiError } from "./jira-client.js"` keeps working.
 */

/** Jira-specific error with HTTP status and response body. */
export class JiraApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}
