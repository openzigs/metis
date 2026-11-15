/**
 * #2560 — `read_file_slice`'s per-call line cap. Production keeps 200 lines a
 * call; `createReadFileSliceTool(n)` gives the eval's explorer arm (A20) the
 * same tool with a cap of n, so it can read a whole file in one call.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadFileSliceTool, MAX_LINES, readFileSliceTool } from "./read-file-slice.js";

const LINES = 450;
let clone: string;

beforeAll(async () => {
  clone = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-2560-slice-")));
  const body = Array.from({ length: LINES }, (_, i) => `line ${i + 1}`).join("\n");
  await fs.writeFile(path.join(clone, "big.go"), body);
});

afterAll(async () => {
  await fs.rm(clone, { recursive: true, force: true });
});

const ctx = () => ({ projectId: "p1", cloneDir: clone });

describe("#2560 — read_file_slice's line cap", () => {
  it("production's tool still cuts an open-ended read at 200 lines and names the next range", async () => {
    expect(MAX_LINES).toBe(200);
    const out = await readFileSliceTool.execute({ filePath: "big.go" }, ctx());
    expect(out.truncated).toBe(true);
    expect(out.content).toContain(`big.go (lines 1-200 of ${LINES})`);
    expect(out.content).toContain("[Cut at 200 lines per call: request lines 201-400 next.]");
    expect(out.resultCount).toBe(200);
  });

  it("a wider cap reads the whole file in one call", async () => {
    const tool = createReadFileSliceTool(1000);
    expect(tool.name).toBe("read_file_slice");
    expect(tool.description).toMatch(/Omit startLine and endLine to read the whole file; max 1000/);
    const out = await tool.execute({ filePath: "big.go" }, ctx());
    expect(out.isError).toBeUndefined();
    expect(out.truncated).toBe(false);
    expect(out.resultCount).toBe(LINES);
    expect(out.content).toContain(`big.go (lines 1-${LINES} of ${LINES})`);
    expect(out.content).toContain(`${LINES}| line ${LINES}`);
    expect(out.content).not.toContain("[Cut at");
  });

  it("a cap smaller than the file cuts there and pages by its own size", async () => {
    const out = await createReadFileSliceTool(100).execute(
      { filePath: "big.go", startLine: 50 },
      ctx(),
    );
    expect(out.resultCount).toBe(100);
    expect(out.content).toContain("[Cut at 100 lines per call: request lines 150-249 next.]");
    const explicit = await createReadFileSliceTool(100).execute(
      { filePath: "big.go", startLine: 1, endLine: 300 },
      ctx(),
    );
    expect(explicit.resultCount).toBe(100);
    expect(explicit.truncated).toBe(true);
  });

  it("states the default end line its cap implies, and keeps production's schema at 200", () => {
    const wide = createReadFileSliceTool(1000).parameters as {
      properties: Record<string, { description: string }>;
    };
    expect(wide.properties.endLine!.description).toMatch(/startLine \+ 999/);
    expect(createReadFileSliceTool(MAX_LINES).parameters).toBe(readFileSliceTool.parameters);
  });

  it("keeps the containment check", async () => {
    const out = await createReadFileSliceTool(1000).execute(
      { filePath: "../../etc/passwd" },
      ctx(),
    );
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Path traversal detected/);
  });

  it("refuses a cap that is not a positive integer", () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(() => createReadFileSliceTool(bad)).toThrow(/maxLines must be a positive integer/);
    }
  });
});
