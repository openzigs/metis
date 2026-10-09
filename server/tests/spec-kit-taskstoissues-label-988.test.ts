/**
 * #988 — GitHub caps a label name at 50 characters, and METIS feature slugs run
 * to 84 (`NNN-` + 80). The export's `speckit:<slug>` label must fit, and a 422
 * must name the field GitHub rejected instead of blaming the token.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const {
  githubLabel,
  GITHUB_LABEL_MAX_LENGTH,
  GITHUB_TITLE_MAX_LENGTH,
  issueTitle,
  renderIssueBody,
} = await import("../src/lib/spec-kit/commands/taskstoissues.js");
const { createGitHubIssueClient, invalidFieldsOf } =
  await import("../src/lib/spec-kit/commands/taskstoissues-github.js");

/** The 80-character word part the walkthrough's real feature produced. */
const LONG = "001-mark-all-entries-as-read-older-than-n-days-miniflux-4478-let-a-user-mark";
const SLUG_80 = `${LONG}-mark`.slice(0, 80);

const chars = (s: string) => [...s].length;

describe("githubLabel", () => {
  it("is 50", () => {
    expect(GITHUB_LABEL_MAX_LENGTH).toBe(50);
  });

  it("leaves a label that fits unchanged", () => {
    expect(githubLabel("speckit:", "003-marked-read-count")).toBe("speckit:003-marked-read-count");
    const exactly50 = "a".repeat(50 - "speckit:".length);
    expect(githubLabel("speckit:", exactly50)).toBe(`speckit:${exactly50}`);
  });

  it("bounds an 80-character slug to 50, keeping its number and a hash of the whole slug", () => {
    expect(chars(SLUG_80)).toBe(80);
    const label = githubLabel("speckit:", SLUG_80);
    expect(chars(label)).toBeLessThanOrEqual(50);
    expect(label).toMatch(/^speckit:001-mark-all-entries-as-read-olde-[0-9a-f]{8}$/);
    expect(chars(label)).toBe(50);
  });

  it("bounds the walkthrough's 84-character label", () => {
    const label = githubLabel("speckit:", LONG);
    expect(chars(`speckit:${LONG}`)).toBe(84);
    expect(chars(label)).toBeLessThanOrEqual(50);
  });

  it("gives two long slugs that share a head distinct labels, and is stable", () => {
    const a = `${"001-" + "a".repeat(60)}-one`;
    const b = `${"001-" + "a".repeat(60)}-two`;
    expect(githubLabel("speckit:", a)).not.toBe(githubLabel("speckit:", b));
    expect(githubLabel("speckit:", a)).toBe(githubLabel("speckit:", a));
  });

  it("does not leave a dangling hyphen before the hash", () => {
    // The cut falls right after a hyphen: `NNN-aaaa…-` then the hash.
    const room = 50 - "speckit:".length - 1 - 8;
    const slug = `${"b".repeat(room - 1)}-${"c".repeat(30)}`;
    expect(githubLabel("speckit:", slug)).not.toMatch(/--/);
  });

  it("counts characters, not UTF-16 units, for a story heading", () => {
    const story = "🙂".repeat(60);
    const label = githubLabel("story:", story);
    expect(chars(label)).toBeLessThanOrEqual(50);
    expect(label.startsWith("story:🙂")).toBe(true);
  });

  it("keeps the full slug in the issue body", () => {
    const body = renderIssueBody(
      {
        id: "T01",
        title: "x",
        parallelizable: false,
        files: [],
        dependsOn: [],
        userStorySlug: null,
        storyPoints: null,
        notes: "",
        satisfies: [],
        text: "",
      },
      SLUG_80,
    );
    expect(body).toContain(`Source: specs/${SLUG_80}/tasks.md#T01`);
  });
});

describe("issueTitle (#993)", () => {
  it("is `[id] title` when it fits GitHub's 256 characters", () => {
    expect(GITHUB_TITLE_MAX_LENGTH).toBe(256);
    expect(issueTitle({ id: "T01", title: "Change `f(x)` (a.go:1)" })).toBe(
      "[T01] Change `f(x)` (a.go:1)",
    );
    const exactly = "a".repeat(256 - "[T01] ".length);
    expect(issueTitle({ id: "T01", title: exactly })).toBe(`[T01] ${exactly}`);
  });

  it("bounds a longer title to 256 characters ending in an ellipsis", () => {
    const title = issueTitle({ id: "T01", title: "🙂".repeat(300) });
    expect(chars(title)).toBe(256);
    expect(title.startsWith("[T01] 🙂")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("invalidFieldsOf", () => {
  const httpError = (data: unknown) =>
    Object.assign(new Error("Validation Failed"), { status: 422, response: { data } });

  it("names the rejected resource and field from GitHub's errors", () => {
    expect(
      invalidFieldsOf(
        httpError({
          message: "Validation Failed",
          errors: [
            { value: "speckit:secret-ish", resource: "Label", field: "name", code: "invalid" },
          ],
        }),
      ),
    ).toEqual(["invalid Label name"]);
  });

  it("never echoes a value, and drops words that are not GitHub enum words", () => {
    const out = invalidFieldsOf(
      httpError({
        errors: [
          { resource: "Issue", field: "title", code: "missing_field", value: "ghp_x" },
          { resource: "Issue", field: "title", code: "missing_field" },
          { resource: "Label <script>", field: "name", code: "invalid" },
          { code: "custom", message: "body is too long (maximum is 65536 characters)" },
          null,
        ],
      }),
    );
    expect(out).toEqual(["missing_field Issue title", "invalid name"]);
    expect(JSON.stringify(out)).not.toMatch(/ghp_x|script|65536/);
  });

  it("is null when there is no errors array", () => {
    expect(invalidFieldsOf(httpError({ message: "Validation Failed" }))).toBeNull();
    expect(invalidFieldsOf(httpError({ errors: [{ code: "custom" }] }))).toBeNull();
    expect(invalidFieldsOf(new Error("socket hang up"))).toBeNull();
    expect(invalidFieldsOf(null)).toBeNull();
  });
});

describe("createGitHubIssueClient — a 422 on create", () => {
  function clientThrowing(err: unknown) {
    return createGitHubIssueClient({
      request: async () => {
        throw err;
      },
    } as never);
  }
  const create = (err: unknown) =>
    clientThrowing(err).create("openzigs", "flux-v2", { title: "t", body: "b", labels: ["l"] });

  it("names the rejected label field and does not send the user to the token", async () => {
    const err = Object.assign(new Error("Validation Failed ghp_leak"), {
      status: 422,
      response: {
        data: {
          message: "Validation Failed",
          errors: [
            { value: "speckit:too-long", resource: "Label", field: "name", code: "invalid" },
          ],
        },
      },
    });
    const failure = (await create(err).catch((e: unknown) => e)) as Error & { code?: string };
    expect(failure).toMatchObject({ status: 502, code: "GITHUB_REQUEST_FAILED" });
    expect(failure.message).toContain("rejected invalid Label name");
    expect(failure.message).toContain("HTTP 422");
    expect(failure.message).toContain("50 characters");
    expect(failure.message).toContain("not the vault secret");
    expect(failure.message).not.toContain("Check that the vault secret");
    expect(failure.message).not.toMatch(/ghp_leak|too-long/);
  });

  it("omits the label hint when another field was rejected", async () => {
    const err = Object.assign(new Error("x"), {
      status: 422,
      response: {
        data: { errors: [{ resource: "Issue", field: "title", code: "missing_field" }] },
      },
    });
    const failure = (await create(err).catch((e: unknown) => e)) as Error;
    expect(failure.message).toContain("rejected missing_field Issue title");
    expect(failure.message).not.toContain("50 characters");
  });

  it("keeps the token hint for a 422 that names no field, and for a 403", async () => {
    for (const status of [422, 403]) {
      const err = Object.assign(new Error("x"), { status, response: { data: {} } });
      const failure = (await create(err).catch((e: unknown) => e)) as Error;
      expect(failure.message).toBe(
        `GitHub refused the request to create an issue (HTTP ${status}). Check that the vault secret can create issues in the publish target.`,
      );
    }
  });
});
