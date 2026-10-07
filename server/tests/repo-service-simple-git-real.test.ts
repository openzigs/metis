/**
 * Runs the repo connector's REAL simple-git client (not the `__setSimpleGitFactory`
 * fake every other connector test uses) against a local `file://` repository.
 *
 * Why this exists (#903): simple-git 4 added an environment guard that REJECTS any
 * `GIT_*` key passed through `.env()` unless it is also named in `allowEnvironment`.
 * The fake-git tests assert the env we BUILD and stay green, while every real
 * authenticated clone and pull would throw `Use of "GIT_CONFIG_COUNT" is blocked by
 * the environment guard`. Only an execution against real simple-git and real git
 * catches that, so that is what this file does.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  __defaultGitForTest as defaultGit,
  authenticatedGitEnv,
  SIMPLE_GIT_ALLOWED_ENV,
} from "../src/lib/connectors/repo/repo-service.js";

type RealGit = Awaited<ReturnType<typeof defaultGit>> & {
  raw(args: string[]): Promise<string>;
  pull(remote: string, branch: string, opts: string[]): Promise<{ files: string[] }>;
};

const TOKEN = "test-token-903";
const EXPECTED_HEADER = `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;

let base: string;
let origin: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "ignore",
  });
}

async function authed(cwd: string): Promise<RealGit> {
  const g = await defaultGit(cwd);
  return g.env!(authenticatedGitEnv(TOKEN)) as RealGit;
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "metis-903-git-"));
  origin = join(base, "origin");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "a.txt"), "one\n");
  git(origin, "add", ".");
  git(origin, "commit", "-qm", "one");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("repo connector — real simple-git client (#903)", () => {
  it("allows every guarded GIT_* key the authenticated env carries", () => {
    const guarded = Object.keys(authenticatedGitEnv(TOKEN)).filter((k) => k.startsWith("GIT_"));
    expect(guarded.length).toBeGreaterThan(0);
    expect([...SIMPLE_GIT_ALLOWED_ENV].sort()).toEqual(expect.arrayContaining(guarded.sort()));
  });

  it("clones with the shallow-clone args and hands git the auth header via env config", async () => {
    const target = join(base, "clone");
    await (
      await authed(base)
    ).clone(`file://${origin}`, target, [
      "--depth=1",
      "--single-branch",
      "--branch=main",
      "--filter=blob:limit=1000000",
      "--no-tags",
    ]);
    expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("one\n");

    const header = await (await authed(target)).raw(["config", "--get", "http.extraHeader"]);
    expect(header.trim()).toBe(EXPECTED_HEADER);
  });

  it("pulls --ff-only with the same env", async () => {
    writeFileSync(join(origin, "b.txt"), "two\n");
    git(origin, "add", ".");
    git(origin, "commit", "-qm", "two");

    const result = await (await authed(join(base, "clone"))).pull("origin", "main", ["--ff-only"]);
    expect(result.files).toEqual(["b.txt"]);
  });
});
