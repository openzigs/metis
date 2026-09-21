/**
 * #1296 — the AGPL-3.0 §13 network source offer, served.
 *
 * §13 obliges a network-served modified version to offer its remote users the
 * Corresponding Source of the RUNNING version. These arms hold the three properties
 * that make the endpoint discharge that rather than merely exist:
 *
 *   1. it is reachable **without authentication** — a §13 offer that requires a
 *      login is not offered to "all users interacting with it remotely";
 *   2. it is reachable at **both** mount points, `/source` (the conventional,
 *      guessable path a stranger tries) and `/api/source` (the path the UI footer
 *      goes through the Next.js proxy to reach);
 *   3. it names the deployed commit when the environment says so, and degrades to
 *      the repository — never to an error, and never to a fabricated commit — when
 *      it does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn(async () => ({ id: "user_admin" })) },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

import request from "supertest";
import { buildSourceOffer } from "@metis/shared";
import { createApp } from "../src/app.js";

const FULL_SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";
const MOUNT_POINTS = ["/source", "/api/source"] as const;

let app: ReturnType<typeof createApp>;
const SAVED = {
  METIS_SOURCE_COMMIT: process.env.METIS_SOURCE_COMMIT,
  GIT_COMMIT: process.env.GIT_COMMIT,
  SOURCE_COMMIT: process.env.SOURCE_COMMIT,
  METIS_SOURCE_REPOSITORY_URL: process.env.METIS_SOURCE_REPOSITORY_URL,
};

function clearSourceEnv(): void {
  for (const key of Object.keys(SAVED)) delete process.env[key];
}

beforeEach(() => {
  clearSourceEnv();
  app = createApp();
});

afterEach(() => {
  clearSourceEnv();
  for (const [key, value] of Object.entries(SAVED)) {
    if (value !== undefined) process.env[key] = value;
  }
});

describe.each(MOUNT_POINTS)("GET %s", (path) => {
  it("answers 200 with no credentials of any kind", async () => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("names the outbound licence", async () => {
    const res = await request(app).get(path);
    expect(res.body.license).toBe("AGPL-3.0-only");
    expect(res.body.licenseUrl).toBe("https://www.gnu.org/licenses/agpl-3.0.html");
  });

  it("offers the repository even with nothing configured", async () => {
    const res = await request(app).get(path);
    expect(res.body.repositoryUrl).toBe("https://github.com/openzigs/metis");
    expect(res.body.sourceUrl).toBe("https://github.com/openzigs/metis");
    expect(res.body.commit).toBeNull();
    expect(res.body.commitKnown).toBe(false);
  });

  it("names the deployed commit and links to its tree and archive", async () => {
    process.env.METIS_SOURCE_COMMIT = FULL_SHA;
    const res = await request(app).get(path);
    expect(res.body.commit).toBe(FULL_SHA);
    expect(res.body.commitShort).toBe("0a1b2c3");
    expect(res.body.commitKnown).toBe(true);
    expect(res.body.commitUrl).toBe(`https://github.com/openzigs/metis/tree/${FULL_SHA}`);
    expect(res.body.archiveUrl).toBe(
      `https://github.com/openzigs/metis/archive/${FULL_SHA}.tar.gz`,
    );
    expect(res.body.sourceUrl).toBe(res.body.commitUrl);
  });

  // The whole point of reading env per request rather than once at module load: a
  // process restarted onto a new build must offer the NEW commit. Caching the offer
  // at import time would make a long-lived module serve a stale §13 answer, and
  // nothing in a normal test run would notice.
  it("re-reads the environment on every request rather than caching at import", async () => {
    process.env.METIS_SOURCE_COMMIT = "aaaaaaa";
    expect((await request(app).get(path)).body.commit).toBe("aaaaaaa");
    process.env.METIS_SOURCE_COMMIT = "bbbbbbb";
    expect((await request(app).get(path)).body.commit).toBe("bbbbbbb");
  });

  it("refuses a commit that is not a bare sha instead of putting it in a URL", async () => {
    process.env.METIS_SOURCE_COMMIT = 'abc1234" onmouseover="alert(1)';
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body.commit).toBeNull();
    expect(res.body.sourceUrl).toBe("https://github.com/openzigs/metis");
    expect(JSON.stringify(res.body)).not.toContain("onmouseover");
  });

  it("refuses a non-https repository override instead of serving it as a link", async () => {
    process.env.METIS_SOURCE_REPOSITORY_URL = "javascript:alert(1)";
    const res = await request(app).get(path);
    expect(res.body.repositoryUrl).toBe("https://github.com/openzigs/metis");
    expect(JSON.stringify(res.body)).not.toContain("javascript:");
  });

  it("honours an https repository override so a fork offers ITS source", async () => {
    process.env.METIS_SOURCE_REPOSITORY_URL = "https://git.example.com/fork/metis";
    process.env.METIS_SOURCE_COMMIT = FULL_SHA;
    const res = await request(app).get(path);
    expect(res.body.repositoryUrl).toBe("https://git.example.com/fork/metis");
    expect(res.body.commitUrl).toBe(`https://git.example.com/fork/metis/tree/${FULL_SHA}`);
  });

  // A cached §13 offer is a wrong §13 offer the moment the deployment rolls. The
  // header is asserted because a CDN in front of this endpoint is the likely place
  // for it to go stale, and nothing else would reveal that.
  it("forbids caching, so a rolled deployment cannot serve the previous commit", async () => {
    const res = await request(app).get(path);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });
});

// The endpoint's payload and the UI footer's expectations are the same object
// because both come from `buildSourceOffer`. This asserts that rather than
// restating the shape by hand — a hand-copied literal is exactly how a consumer
// drifts from the producer it reads.
describe("the served document is buildSourceOffer's output verbatim", () => {
  it.each(MOUNT_POINTS)("%s matches the shared builder", async (path) => {
    process.env.METIS_SOURCE_COMMIT = FULL_SHA;
    const res = await request(app).get(path);
    expect(res.body).toEqual(buildSourceOffer({ METIS_SOURCE_COMMIT: FULL_SHA }));
  });

  it("is not wrapped in the internal success/data envelope", async () => {
    // The offer is a public, machine-readable document that a stranger may fetch
    // with curl. Wrapping it in METIS's internal API envelope would make a §13
    // consumer parse our conventions to find the licence.
    const res = await request(app).get("/api/source");
    expect(res.body).not.toHaveProperty("success");
    expect(res.body).not.toHaveProperty("data");
    expect(res.body).toHaveProperty("license");
  });
});
