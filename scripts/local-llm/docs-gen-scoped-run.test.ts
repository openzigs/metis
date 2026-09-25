import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createClient,
  parseArgs,
  resolveOptions,
  run,
  sectionHeadings,
  summarizeDocument,
} from "./docs-gen-scoped-run.mjs";

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe("resolveOptions", () => {
  it("applies defaults and splits --paths", () => {
    const o = resolveOptions(
      parseArgs(["--project", "p1", "--paths", "packages/fit/, packages/domain/"]),
      {},
    );
    expect(o).toMatchObject({
      base: "http://localhost:4000/api",
      project: "p1",
      doc: null,
      paths: ["packages/fit/", "packages/domain/"],
      docType: "business-requirements",
      username: "admin",
      password: "password",
      pollMs: 30_000,
      maxMs: 12 * 3_600_000,
      wait: true,
    });
  });

  it("reads env and flags", () => {
    const o = resolveOptions(
      parseArgs([
        "--project",
        "p1",
        "--doc",
        "d1",
        "--poll",
        "5",
        "--no-wait",
        "--doc-type",
        "architecture",
      ]),
      { METIS_API_BASE: "http://x:4000/api/", METIS_USERNAME: "u", METIS_PASSWORD: "pw" },
    );
    expect(o).toMatchObject({
      base: "http://x:4000/api",
      doc: "d1",
      paths: [],
      docType: "architecture",
      username: "u",
      password: "pw",
      pollMs: 5000,
      wait: false,
    });
  });

  it("rejects missing or invalid input", () => {
    expect(() => resolveOptions({}, {})).toThrow(/--project/);
    expect(() => resolveOptions({ project: "p1" }, {})).toThrow(/--paths/);
    expect(() => resolveOptions({ project: "p1", paths: "a/", "doc-type": "x" }, {})).toThrow(
      /doc-type/,
    );
    expect(() => resolveOptions({ project: "p1", paths: "a/", poll: "0" }, {})).toThrow(/poll/);
  });
});

describe("sectionHeadings", () => {
  it("lists H2s outside code fences", () => {
    expect(sectionHeadings("# T\n## A\n```\n## not\n```\n### sub\n## B\n")).toEqual(["A", "B"]);
    expect(sectionHeadings(undefined)).toEqual([]);
  });
});

describe("summarizeDocument", () => {
  it("prints status, chars, sections, warnings and provenance", () => {
    const text = summarizeDocument({
      id: "d1",
      title: "BR [scope: packages/fit/]",
      status: "degraded",
      content: "# BR\n\n## Business Rules\n\n## Calculations\n",
      warnings: [
        { kind: "section-failed", severity: "error", section: "Calculations", message: "boom" },
        { kind: "section-failed", severity: "error", message: "again" },
      ],
      versions: [
        {
          provenanceManifest: JSON.stringify({
            document: { pathPrefixes: ["packages/fit"] },
            selectedEvidence: { primary: [{}, {}] },
            sections: [
              {
                sectionLabel: "Business Rules",
                providerKind: "local",
                model: "laguna",
                factsSourceIds: ["a"],
                groundingSourceIds: ["b", "c"],
              },
            ],
            generation: { model: { phase1: { model: "p1m" }, phase2: { model: "p2m" } } },
          }),
        },
      ],
    });
    expect(text).toContain("Status:   degraded");
    expect(text).toContain("Chars:    41");
    expect(text).toContain("Sections (2):\n  - Business Rules\n  - Calculations");
    expect(text).toContain("by kind: section-failed=2");
    expect(text).toContain("[error] section-failed (Calculations): boom");
    expect(text).toContain("Scope:    packages/fit/");
    expect(text).toContain("Provenance: 1 section record(s), 2 selected evidence source(s)");
    expect(text).toContain("Business Rules: local/laguna, facts 1, grounding 2");
    expect(text).toContain("phase1=p1m phase2=p2m");
  });

  it("copes with a failed doc and no manifest", () => {
    const text = summarizeDocument({
      id: "d1",
      status: "failed",
      errorMessage: "nope",
      versions: [],
    });
    expect(text).toContain("Error:    nope");
    expect(text).toContain("Provenance: none recorded");
    expect(summarizeDocument({ versions: [{ provenanceManifest: "{bad" }] })).toContain(
      "none recorded",
    );
    expect(summarizeDocument({ versions: [{ provenanceManifest: "{}" }] })).toContain(
      "full project (no path scope)",
    );
  });
});

describe("createClient", () => {
  it("logs in once, sends the bearer token, and re-logs in on a 401", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(200, { data: { accessToken: "t1" } }))
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { data: { accessToken: "t2" } }))
      .mockResolvedValueOnce(json(200, { data: { ok: 1 } }));
    const c = createClient(
      { base: "http://h/api", username: "admin", password: "password" },
      fetch,
    );
    await expect(c.call("GET", "/x")).resolves.toEqual({ data: { ok: 1 } });
    expect(fetch.mock.calls[0][0]).toBe("http://h/api/auth/login");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      username: "admin",
      password: "password",
    });
    expect(fetch.mock.calls[1][1].headers.authorization).toBe("Bearer t1");
    expect(fetch.mock.calls[3][1].headers.authorization).toBe("Bearer t2");
  });

  it("surfaces login and API errors", async () => {
    const bad = createClient(
      { base: "b" },
      vi.fn().mockResolvedValue(json(401, { error: { message: "no" } })),
    );
    await expect(bad.call("GET", "/x")).rejects.toThrow(/login failed \(401\): no/);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(200, { data: { accessToken: "t" } }))
      .mockResolvedValueOnce(json(400, { error: { code: "PATH_SCOPE_EMPTY", message: "none" } }));
    await expect(createClient({ base: "b" }, fetch).call("POST", "/g", {})).rejects.toThrow(
      "POST /g → 400: PATH_SCOPE_EMPTY none",
    );
  });
});

describe("run", () => {
  const opts = {
    base: "http://h/api",
    project: "p1",
    doc: null,
    paths: ["packages/fit/"],
    title: "T",
    docType: "business-requirements",
    username: "admin",
    password: "password",
    pollMs: 10,
    maxMs: 1000,
    wait: true,
  };

  it("posts a scoped full generation, polls to completion and summarises", async () => {
    const statuses = ["generating", "generating", "ready"];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/auth/login")) return json(200, { data: { accessToken: "t" } });
      if (init.method === "POST")
        return json(202, { data: { id: "d9", title: "T [scope: packages/fit/]" } });
      return json(200, { data: { id: "d9", status: statuses.shift(), content: "## A\n" } });
    });
    const log = vi.fn();
    const sleep = vi.fn(async () => {});
    const result = await run(opts, { fetch, log, sleep });
    const post = fetch.mock.calls.find(
      ([, init]) => init.method === "POST" && !String(init.body).includes("password"),
    );
    expect(post?.[0]).toBe("http://h/api/projects/p1/docs/generate");
    expect(JSON.parse(String(post?.[1].body))).toEqual({
      title: "T",
      scope: "full",
      docType: "business-requirements",
      pathPrefixes: ["packages/fit/"],
    });
    expect(log).toHaveBeenCalledWith(
      'Started scoped generation: doc d9 ("T [scope: packages/fit/]")',
    );
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ready");
    expect(result.summary).toContain("Sections (1):\n  - A");
  });

  it("--no-wait returns after starting; --doc watches without posting", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/auth/login")) return json(200, { data: { accessToken: "t" } });
      if (init.method === "POST") return json(202, { data: { id: "d1", title: "T" } });
      return json(200, { data: { id: "d2", status: "failed" } });
    });
    expect(await run({ ...opts, wait: false }, { fetch, log: vi.fn() })).toEqual({
      docId: "d1",
      status: "started",
      summary: null,
    });
    fetch.mockClear();
    const watched = await run({ ...opts, doc: "d2" }, { fetch, log: vi.fn() });
    expect(watched.status).toBe("failed");
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith("/generate"))).toBe(false);
  });

  it("stops waiting after --max-hours", async () => {
    let t = 0;
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/auth/login")
        ? json(200, { data: { accessToken: "t" } })
        : json(200, { data: { id: "d2", status: "generating" } }),
    );
    const result = await run(
      { ...opts, doc: "d2" },
      { fetch, log: vi.fn(), sleep: async () => {}, now: () => (t += 600) },
    );
    expect(result.status).toBe("timeout");
    expect(result.summary).toContain("still generating");
  });

  it("fails when generate returns no id", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/auth/login")
        ? json(200, { data: { accessToken: "t" } })
        : json(202, { data: {} }),
    );
    await expect(run(opts, { fetch, log: vi.fn() })).rejects.toThrow(/no document id/);
  });
});

describe("defaults and entrypoint", () => {
  it("run() uses console.log, a real timer and the clock by default", async () => {
    const statuses = ["generating", "ready"];
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/auth/login")
        ? json(200, { data: { accessToken: "t" } })
        : json(200, { data: { id: "d2", status: statuses.shift() } }),
    );
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await run(
        {
          base: "b",
          project: "p1",
          doc: "d2",
          paths: [],
          pollMs: 1,
          maxMs: 60_000,
          wait: true,
        },
        { fetch },
      );
      expect(result.status).toBe("ready");
      expect(spy).toHaveBeenCalledWith("Watching doc d2");
    } finally {
      spy.mockRestore();
    }
  });

  it("the CLI exits 1 with a usage error when --project is missing", () => {
    const script = fileURLToPath(new URL("./docs-gen-scoped-run.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--project <projectId> is required");
  });
});
