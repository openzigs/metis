import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createClient,
  MAX_UNREACHABLE_POLLS,
  parseArgs,
  pathScopeOf,
  RequestFailedError,
  resolveOptions,
  run,
  sectionHeadings,
  summarizeDocument,
  UnreadableResponseError,
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
  it("prints status, chars, sections, warnings and the path scope", () => {
    const text = summarizeDocument({
      id: "d1",
      title: "BR [scope: packages/fit/]",
      status: "degraded",
      scope: "full",
      scopeFilter: JSON.stringify({
        docType: "business-requirements",
        pathPrefixes: ["packages/fit"],
      }),
      content: "# BR\n\n## Business Rules\n\n## Calculations\n",
      warnings: [
        { kind: "section-failed", severity: "error", section: "Calculations", message: "boom" },
        { kind: "section-failed", severity: "error", message: "again" },
      ],
    });
    expect(text).toContain("Status:   degraded");
    expect(text).toContain("Chars:    41");
    expect(text).toContain("Sections (2):\n  - Business Rules\n  - Calculations");
    expect(text).toContain("by kind: section-failed=2");
    expect(text).toContain("[error] section-failed (Calculations): boom");
    expect(text).toContain("Scope:    packages/fit/");
  });

  it("never reads the version provenance manifests (#190 moves them off the detail route)", () => {
    const text = summarizeDocument({
      status: "ready",
      scopeFilter: "{}",
      versions: [{ provenanceManifest: JSON.stringify({ document: { pathPrefixes: ["x"] } }) }],
    });
    expect(text).toContain("full project (no path scope)");
    expect(text).not.toContain("Provenance");
  });

  it("copes with a failed doc and a missing or unreadable scope filter", () => {
    const text = summarizeDocument({ id: "d1", status: "failed", errorMessage: "nope" });
    expect(text).toContain("Error:    nope");
    expect(text).toContain("full project (no path scope)");
  });
});

describe("pathScopeOf", () => {
  it("reads scopeFilter as a JSON string or an object", () => {
    expect(pathScopeOf({ scopeFilter: '{"pathPrefixes":["a","b/c"]}' })).toEqual(["a", "b/c"]);
    expect(pathScopeOf({ scopeFilter: { pathPrefixes: ["a"] } })).toEqual(["a"]);
  });

  it("returns null when unscoped or unreadable", () => {
    expect(pathScopeOf({ scopeFilter: "{bad" })).toBeNull();
    expect(pathScopeOf({ scopeFilter: '{"pathPrefixes":[]}' })).toBeNull();
    expect(pathScopeOf({ scopeFilter: '{"pathPrefixes":"a"}' })).toBeNull();
    expect(pathScopeOf({})).toBeNull();
    expect(pathScopeOf(null)).toBeNull();
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

describe("createClient — unreadable bodies", () => {
  const broken = (status: number) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    }) as unknown as Response;

  it("a 2xx body that is not JSON is an UnreadableResponseError, never `{}`", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(200, { data: { accessToken: "t" } }))
      .mockResolvedValueOnce(broken(200));
    const err = await createClient({ base: "b" }, fetch)
      .call("GET", "/d")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreadableResponseError);
    expect(String(err)).toContain("GET /d → 200: response body was not valid JSON");
  });

  it("a non-2xx body that is not JSON still reports the HTTP status", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(200, { data: { accessToken: "t" } }))
      .mockResolvedValueOnce(broken(502));
    await expect(createClient({ base: "b" }, fetch).call("GET", "/d")).rejects.toThrow(
      /^GET \/d → 502:/,
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

  // The crash seen at the end of a real run: the detail response for the
  // finished (large) document came back 200 with a body that was not valid
  // JSON, the client swallowed the parse error as `{}`, and the poll loop
  // read `data.status` off `undefined`.
  const unparseable = (status = 200) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    }) as unknown as Response;

  it("survives an unparseable completion response and summarises the next good one", async () => {
    const replies = [
      json(200, { data: { id: "d2", status: "generating" } }),
      unparseable(),
      json(200, {
        data: {
          id: "d2",
          title: "T [scope: packages/fit/]",
          status: "degraded",
          scope: "full",
          scopeFilter: JSON.stringify({
            docType: "business-requirements",
            pathPrefixes: ["packages/fit"],
          }),
          content: "# T\n\n## A\n",
          warnings: [{ kind: "grounding-sampled", severity: "warning", message: "spot" }],
          // PR #190 detail shape: versions carry no manifest and no content.
          versions: [{ id: "v1", version: 1, revisionId: "r1" }],
        },
      }),
    ];
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/auth/login") ? json(200, { data: { accessToken: "t" } }) : replies.shift()!,
    );
    const log = vi.fn();
    const result = await run({ ...opts, doc: "d2" }, { fetch, log, sleep: async () => {} });
    expect(result.status).toBe("degraded");
    expect(result.summary).toContain("Scope:    packages/fit/");
    expect(result.summary).toContain("by kind: grounding-sampled=1");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/unreadable detail response/));
  });

  it("a detail response without a document status is retried, not dereferenced", async () => {
    const replies = [
      json(200, {}),
      json(200, { data: null }),
      json(200, { data: { id: "d2", status: "ready", content: "" } }),
    ];
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/auth/login") ? json(200, { data: { accessToken: "t" } }) : replies.shift()!,
    );
    const result = await run(
      { ...opts, doc: "d2" },
      { fetch, log: vi.fn(), sleep: async () => {} },
    );
    expect(result.status).toBe("ready");
  });

  it("gives up with a clear error after repeated unreadable detail responses", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/auth/login") ? json(200, { data: { accessToken: "t" } }) : unparseable(),
    );
    const sleep = vi.fn(async () => {});
    await expect(run({ ...opts, doc: "d2" }, { fetch, log: vi.fn(), sleep })).rejects.toThrow(
      /doc d2: 3 unreadable detail responses in a row .*not valid JSON/,
    );
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("a good poll resets the unreadable count (only CONSECUTIVE failures give up)", async () => {
    const replies = [
      unparseable(),
      json(200, { data: { id: "d2", status: "generating" } }),
      unparseable(),
      unparseable(),
      json(200, { data: { id: "d2", status: "ready", content: "" } }),
    ];
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/auth/login") ? json(200, { data: { accessToken: "t" } }) : replies.shift()!,
    );
    const result = await run(
      { ...opts, doc: "d2" },
      { fetch, log: vi.fn(), sleep: async () => {} },
    );
    expect(result.status).toBe("ready");
  });

  it("a poll whose request fails outright (server restarting) is retried, not fatal", async () => {
    const replies: Array<Response | Error> = [
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      json(200, { data: { id: "d2", status: "generating" } }),
      new TypeError("fetch failed"),
      json(200, { data: { id: "d2", status: "ready", content: "" } }),
    ];
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/login")) return json(200, { data: { accessToken: "t" } });
      const next = replies.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const log = vi.fn();
    const result = await run({ ...opts, doc: "d2" }, { fetch, log, sleep: async () => {} });
    expect(result.status).toBe("ready");
    expect(log).toHaveBeenCalledWith(
      "detail request failed (GET /projects/p1/docs/d2: request failed (fetch failed)); retrying",
    );
  });

  it("gives up after MAX_UNREACHABLE_POLLS failed requests in a row", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/login")) return json(200, { data: { accessToken: "t" } });
      throw new TypeError("connect ECONNREFUSED");
    });
    const sleep = vi.fn(async () => {});
    await expect(run({ ...opts, doc: "d2" }, { fetch, log: vi.fn(), sleep })).rejects.toThrow(
      `doc d2: ${MAX_UNREACHABLE_POLLS} failed detail requests in a row (last: GET /projects/p1/docs/d2: request failed (connect ECONNREFUSED))`,
    );
    expect(sleep).toHaveBeenCalledTimes(MAX_UNREACHABLE_POLLS - 1);
  });

  it("a good poll resets the failed-request count (only CONSECUTIVE failures give up)", async () => {
    const down = () => Array.from({ length: MAX_UNREACHABLE_POLLS - 1 }, () => new TypeError("x"));
    const replies: Array<Response | Error> = [
      ...down(),
      json(200, { data: { id: "d2", status: "generating" } }),
      ...down(),
      json(200, { data: { id: "d2", status: "ready", content: "" } }),
    ];
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/login")) return json(200, { data: { accessToken: "t" } });
      const next = replies.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const result = await run(
      { ...opts, doc: "d2" },
      { fetch, log: vi.fn(), sleep: async () => {} },
    );
    expect(result.status).toBe("ready");
  });

  it("a failed login while polling is retried like any failed request", async () => {
    let logins = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/login")) {
        logins += 1;
        if (logins === 1) throw new TypeError("fetch failed");
        return json(200, { data: { accessToken: "t" } });
      }
      return json(200, { data: { id: "d2", status: "ready", content: "" } });
    });
    const result = await run(
      { ...opts, doc: "d2" },
      { fetch, log: vi.fn(), sleep: async () => {} },
    );
    expect(result.status).toBe("ready");
  });

  it("never retries starting a generation whose request failed", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/login")) return json(200, { data: { accessToken: "t" } });
      throw new TypeError("fetch failed");
    });
    const err = await run(opts, { fetch, log: vi.fn(), sleep: async () => {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RequestFailedError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("an HTTP error while polling is not retried", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("/auth/login")
        ? json(200, { data: { accessToken: "t" } })
        : json(404, { error: { code: "DOC_NOT_FOUND", message: "gone" } }),
    );
    await expect(
      run({ ...opts, doc: "d2" }, { fetch, log: vi.fn(), sleep: async () => {} }),
    ).rejects.toThrow(/404: DOC_NOT_FOUND gone/);
    expect(fetch).toHaveBeenCalledTimes(2);
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
