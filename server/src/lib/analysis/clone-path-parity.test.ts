/**
 * #777 — PARITY PIN: the analysis side and the ingest pipeline MUST resolve a
 * connector's clone to the SAME directory.
 *
 * This test IS the bug. Before the fix:
 *   - ingest  wrote to `<tmpdir>/metis-repo-clones/<id>`  (or resolveDataDir(REPO_CLONE_DIR))
 *   - analysis read from `./data/repos/<id>`               (cwd-relative string concat)
 *
 * so `read_file_slice` / `list_files` failed on EVERY call — the agentic code agent
 * could query the code graph but never read a line of source. Post-#773 those failures
 * drove `code-retrieval-degraded`, collapsing every requirement to `could-not-verify`.
 *
 * If someone re-derives the clone path independently on either side, this test fails.
 * Do not "fix" it by duplicating the logic — route both sides through
 * `server/src/lib/connectors/repo/clone-path.ts`.
 */
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRepoCloneRoot, resolveRepoClonePath } from "../connectors/repo/clone-path.js";
import { cloneDirPath } from "./clone-availability.js";

const CONNECTOR_ID = "cmrbvw85j000hfj9kitujps5u";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#777 clone-path parity — analysis must look where ingest writes", () => {
  it("agrees with the ingest pipeline when REPO_CLONE_DIR is UNSET (the default)", () => {
    vi.stubEnv("REPO_CLONE_DIR", "");

    // What the analysis side will read from...
    const analysisPath = cloneDirPath(CONNECTOR_ID);
    // ...must be exactly what the ingest pipeline writes to.
    const ingestPath = resolveRepoClonePath(CONNECTOR_ID);

    expect(analysisPath).toBe(ingestPath);

    // And it must be the tmpdir-anchored root ingest actually uses — NOT `./data/repos`.
    const expectedRoot = path.resolve(path.join(os.tmpdir(), "metis-repo-clones"));
    expect(resolveRepoCloneRoot()).toBe(expectedRoot);
    expect(analysisPath).toBe(path.join(expectedRoot, CONNECTOR_ID));
    expect(analysisPath).not.toContain("data/repos");
  });

  it("agrees with the ingest pipeline when REPO_CLONE_DIR is SET", () => {
    vi.stubEnv("REPO_CLONE_DIR", "custom-clones");

    expect(cloneDirPath(CONNECTOR_ID)).toBe(resolveRepoClonePath(CONNECTOR_ID));
  });

  it("always returns an ABSOLUTE path (a cwd-relative path drifts per process)", () => {
    vi.stubEnv("REPO_CLONE_DIR", "");
    expect(path.isAbsolute(cloneDirPath(CONNECTOR_ID))).toBe(true);

    vi.stubEnv("REPO_CLONE_DIR", "custom-clones");
    expect(path.isAbsolute(cloneDirPath(CONNECTOR_ID))).toBe(true);
  });
});
