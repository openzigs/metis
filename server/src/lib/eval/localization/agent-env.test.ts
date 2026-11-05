import { describe, expect, it } from "vitest";
import { agentArmsRequested, bindMaterializedEnv } from "./agent-env.js";
import { materializeLayout } from "./materialize.js";

describe("agent-arm environment (#1755)", () => {
  it("binds only when --arms names an agent arm", () => {
    expect(agentArmsRequested(["--arms", "a0, a3a"])).toBe(true);
    expect(agentArmsRequested(["--arms", "A0,A3N"])).toBe(true);
    expect(agentArmsRequested(["--arms", "A0,A13"])).toBe(false);
    expect(agentArmsRequested(["--arms"])).toBe(false);
    expect(agentArmsRequested(["--merge", "dir"])).toBe(false);
  });

  it("points the database, clones and vectors at the materialized layout", () => {
    const layout = materializeLayout("/tmp/eval-root");
    const env: NodeJS.ProcessEnv = { DATABASE_URL: "file:/dev.db" };
    bindMaterializedEnv(env, layout);
    expect(env).toEqual({
      DATABASE_URL: "file:/tmp/eval-root/eval.db",
      REPO_CLONE_DIR: "/tmp/eval-root/clones",
      LANCEDB_PATH: "/tmp/eval-root/lancedb",
    });
  });
});
