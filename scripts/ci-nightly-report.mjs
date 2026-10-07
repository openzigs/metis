#!/usr/bin/env node
/**
 * #848 — the `nightly-report` job's entrypoint in `ci.yml`. Opens, updates or
 * closes the `ci-nightly` tracking issue for this scheduled run. The rules and
 * their reasoning live in `lib/ci-nightly-report-core.mjs`.
 *
 * Env:
 *   NEEDS_JSON          `${{ toJSON(needs) }}` — every other job's result
 *   GH_TOKEN            the job's `GITHUB_TOKEN` (issues: write, actions: read)
 *   GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SERVER_URL, GITHUB_API_URL, GITHUB_SHA,
 *   GITHUB_STEP_SUMMARY (all set by Actions)
 *
 * Exits 1 only when the report itself could not be made (bad input or an API
 * error), so a broken reporter is visible as a red job rather than silent.
 */

import { appendFileSync } from "node:fs";

import {
  createGitHubClient,
  failingJobNames,
  reportNightly,
} from "./lib/ci-nightly-report-core.mjs";

const env = process.env;

try {
  const needs = JSON.parse(env.NEEDS_JSON ?? "");
  const repository = env.GITHUB_REPOSITORY ?? "";
  const runId = env.GITHUB_RUN_ID ?? "";
  const serverUrl = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  const runUrl = `${serverUrl}/${repository}/actions/runs/${runId}`;

  const client = createGitHubClient({
    token: env.GH_TOKEN ?? "",
    repository,
    apiUrl: env.GITHUB_API_URL || undefined,
  });

  // The per-shard names are a nicety: a jobs-API failure falls back to `needs` ids.
  /** @type {string[] | null} */
  let detailedJobs = null;
  try {
    detailedJobs = failingJobNames(await client.listRunJobs(runId));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`::warning::could not list this run's jobs (${detail}); using needs ids`);
  }

  const result = await reportNightly({
    needs,
    runUrl,
    sha: env.GITHUB_SHA,
    detailedJobs,
    client,
  });

  const summary =
    result.action === "none"
      ? "Nightly green; no open `ci-nightly` issue."
      : `Nightly ${result.failed.length === 0 ? "green" : "red"}: ${result.action} issue #${result.issue}.`;
  console.log(summary);
  if (result.failed.length > 0) console.log(`failed: ${result.failed.join(", ")}`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### Nightly report (#848)\n\n${summary}\n`);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.log(`::error title=nightly report failed::${detail}`);
  process.exitCode = 1;
}
