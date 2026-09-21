import { describe, expect, it } from "vitest";

import {
  DEFAULT_SOURCE_REPOSITORY_URL,
  OUTBOUND_LICENSE_ID,
  OUTBOUND_LICENSE_NAME,
  OUTBOUND_LICENSE_URL,
  SOURCE_COMMIT_ENV_VARS,
  SOURCE_REPOSITORY_ENV_VAR,
  buildSourceOffer,
  normalizeSourceCommit,
  normalizeSourceRepositoryUrl,
  parseSourceOffer,
  shortenSourceCommit,
} from "./source-offer.js";

const FULL_SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

describe("OUTBOUND_LICENSE_ID", () => {
  // #1296 chose `-only` deliberately: `-or-later` hands a future FSF version
  // authority over these terms. A drift to `-or-later` here would silently
  // re-delegate that, so the exact string is asserted rather than pattern-matched.
  it("is AGPL-3.0-only, not -or-later", () => {
    expect(OUTBOUND_LICENSE_ID).toBe("AGPL-3.0-only");
    expect(OUTBOUND_LICENSE_ID).not.toMatch(/or-later/);
  });

  it("carries a human name and a canonical URL", () => {
    expect(OUTBOUND_LICENSE_NAME).toBe("GNU Affero General Public License v3.0 only");
    expect(OUTBOUND_LICENSE_URL).toBe("https://www.gnu.org/licenses/agpl-3.0.html");
  });
});

describe("normalizeSourceCommit", () => {
  it("accepts a full 40-character sha and lowercases it", () => {
    expect(normalizeSourceCommit(FULL_SHA.toUpperCase())).toBe(FULL_SHA);
  });

  it("accepts an abbreviated sha of at least 7 characters", () => {
    expect(normalizeSourceCommit("0a1b2c3")).toBe("0a1b2c3");
  });

  it("trims surrounding whitespace, which a shell-captured sha commonly carries", () => {
    expect(normalizeSourceCommit(`  ${FULL_SHA}\n`)).toBe(FULL_SHA);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace only", "   "],
    ["six characters — too short to identify a commit", "0a1b2c"],
    ["forty-one characters", `${FULL_SHA}0`],
    ["non-hex", "not-a-sha-at-all"],
    ["a sha with a trailing suffix", `${FULL_SHA}-dirty`],
    ["a branch name", "main"],
    // The value reaches an `href` in the UI footer. Anything that is not a bare
    // hex sha must be refused BEFORE it can be interpolated into a URL, or an
    // operator-supplied (or build-supplied) string becomes the link target.
    ["a javascript: scheme", "javascript:alert(1)"],
    ["a path traversal", "../../etc/passwd"],
    ["an embedded URL", "https://evil.example/x"],
    ["a quote breakout", 'abc1234" onmouseover="x'],
  ])("rejects %s", (_label, raw) => {
    expect(normalizeSourceCommit(raw as string | undefined)).toBeNull();
  });
});

describe("normalizeSourceRepositoryUrl", () => {
  it("accepts an https URL", () => {
    expect(normalizeSourceRepositoryUrl("https://example.com/org/repo")).toBe(
      "https://example.com/org/repo",
    );
  });

  it("strips a trailing slash so URL joins never double up", () => {
    expect(normalizeSourceRepositoryUrl("https://example.com/org/repo/")).toBe(
      "https://example.com/org/repo",
    );
  });

  it("strips a trailing .git so the derived tree and archive URLs resolve", () => {
    expect(normalizeSourceRepositoryUrl("https://example.com/org/repo.git")).toBe(
      "https://example.com/org/repo",
    );
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    // http is refused, not upgraded: a source offer served over plaintext is
    // tamperable, and silently rewriting an operator's scheme hides the problem.
    ["plaintext http", "http://example.com/org/repo"],
    ["a javascript: scheme", "javascript:alert(1)"],
    ["a data: scheme", "data:text/html,<script>x</script>"],
    ["an ssh remote", "git@example.com:org/repo.git"],
    ["a relative path", "/org/repo"],
    ["a protocol-relative URL", "//example.com/org/repo"],
    ["unparseable junk", "https://"],
    // The value is interpolated into an `href`. These are the shapes that would
    // break out of the attribute or carry markup if the validator only checked
    // the scheme.
    ["a quote breakout in the path", 'https://example.com/a" onmouseover="x'],
    ["angle brackets in the path", "https://example.com/<script>"],
    ["whitespace inside the URL", "https://example.com/a b"],
    ["a newline inside the URL", "https://example.com/a\nb"],
    ["a backslash in the path", "https://example.com\\@evil.example"],
  ])("rejects %s", (_label, raw) => {
    expect(normalizeSourceRepositoryUrl(raw as string | undefined)).toBeNull();
  });
});

describe("shortenSourceCommit", () => {
  it("abbreviates a full sha to seven characters", () => {
    expect(shortenSourceCommit(FULL_SHA)).toBe("0a1b2c3");
  });

  it("leaves an already-short sha alone", () => {
    expect(shortenSourceCommit("0a1b2c3")).toBe("0a1b2c3");
  });

  it("returns null for an unknown commit", () => {
    expect(shortenSourceCommit(null)).toBeNull();
  });
});

describe("buildSourceOffer — a known commit", () => {
  const offer = buildSourceOffer({ METIS_SOURCE_COMMIT: FULL_SHA });

  it("names the outbound licence", () => {
    expect(offer.license).toBe("AGPL-3.0-only");
    expect(offer.licenseName).toBe(OUTBOUND_LICENSE_NAME);
    expect(offer.licenseUrl).toBe(OUTBOUND_LICENSE_URL);
  });

  it("names the commit, long and short", () => {
    expect(offer.commit).toBe(FULL_SHA);
    expect(offer.commitShort).toBe("0a1b2c3");
    expect(offer.commitKnown).toBe(true);
  });

  it("derives the commit tree and source-archive URLs from the repository", () => {
    expect(offer.commitUrl).toBe(`${DEFAULT_SOURCE_REPOSITORY_URL}/tree/${FULL_SHA}`);
    expect(offer.archiveUrl).toBe(`${DEFAULT_SOURCE_REPOSITORY_URL}/archive/${FULL_SHA}.tar.gz`);
  });

  // §13 asks for the Corresponding Source of the RUNNING version. When the commit
  // is known, the single link a UI renders must point at that commit — not at the
  // repository's default branch, which is a different and possibly newer program.
  it("points sourceUrl at the commit, not at the default branch", () => {
    expect(offer.sourceUrl).toBe(offer.commitUrl);
    expect(offer.sourceUrl).not.toBe(offer.repositoryUrl);
  });
});

describe("buildSourceOffer — an unknown commit", () => {
  const offer = buildSourceOffer({});

  it("still offers the repository, because a degraded offer beats none", () => {
    expect(offer.repositoryUrl).toBe(DEFAULT_SOURCE_REPOSITORY_URL);
    expect(offer.sourceUrl).toBe(DEFAULT_SOURCE_REPOSITORY_URL);
  });

  it("does not invent a commit or a commit URL", () => {
    expect(offer.commit).toBeNull();
    expect(offer.commitShort).toBeNull();
    expect(offer.commitUrl).toBeNull();
    expect(offer.archiveUrl).toBeNull();
    expect(offer.commitKnown).toBe(false);
  });

  it("still names the licence", () => {
    expect(offer.license).toBe("AGPL-3.0-only");
  });
});

describe("buildSourceOffer — commit environment precedence", () => {
  it("prefers METIS_SOURCE_COMMIT", () => {
    const offer = buildSourceOffer({
      METIS_SOURCE_COMMIT: "aaaaaaa",
      GIT_COMMIT: "bbbbbbb",
      SOURCE_COMMIT: "ccccccc",
    });
    expect(offer.commit).toBe("aaaaaaa");
  });

  it("falls back to GIT_COMMIT, then SOURCE_COMMIT", () => {
    expect(buildSourceOffer({ GIT_COMMIT: "bbbbbbb", SOURCE_COMMIT: "ccccccc" }).commit).toBe(
      "bbbbbbb",
    );
    expect(buildSourceOffer({ SOURCE_COMMIT: "ccccccc" }).commit).toBe("ccccccc");
  });

  // A build that sets METIS_SOURCE_COMMIT to a template that never expanded
  // (`$GIT_SHA`, `unknown`, `""`) must not suppress a correct GIT_COMMIT beside
  // it. Precedence is over VALID values, not over set-ness — otherwise one typo
  // silently removes the §13 commit from a deployment that had it available.
  it("skips a higher-precedence variable whose value is not a sha", () => {
    const offer = buildSourceOffer({
      METIS_SOURCE_COMMIT: "$GIT_SHA",
      GIT_COMMIT: FULL_SHA,
    });
    expect(offer.commit).toBe(FULL_SHA);
  });

  it("exposes the variable names it reads, in precedence order", () => {
    expect([...SOURCE_COMMIT_ENV_VARS]).toEqual([
      "METIS_SOURCE_COMMIT",
      "GIT_COMMIT",
      "SOURCE_COMMIT",
    ]);
  });
});

describe("buildSourceOffer — repository override", () => {
  it("honours a valid override so a modified deployment offers ITS source", () => {
    const offer = buildSourceOffer({
      [SOURCE_REPOSITORY_ENV_VAR]: "https://git.example.com/fork/metis.git",
      METIS_SOURCE_COMMIT: FULL_SHA,
    });
    expect(offer.repositoryUrl).toBe("https://git.example.com/fork/metis");
    expect(offer.commitUrl).toBe(`https://git.example.com/fork/metis/tree/${FULL_SHA}`);
  });

  // The override is operator-supplied and lands in an `href`. A rejected value
  // must fall back to the known-good default rather than propagate.
  it("falls back to the default when the override is not an https URL", () => {
    const offer = buildSourceOffer({
      [SOURCE_REPOSITORY_ENV_VAR]: "javascript:alert(1)",
    });
    expect(offer.repositoryUrl).toBe(DEFAULT_SOURCE_REPOSITORY_URL);
    expect(offer.sourceUrl.startsWith("https://")).toBe(true);
  });

  it("never yields a non-https link, whatever the environment says", () => {
    for (const bad of ["http://x.example", "data:text/html,x", "//x.example", "", "   "]) {
      const offer = buildSourceOffer({
        [SOURCE_REPOSITORY_ENV_VAR]: bad,
        METIS_SOURCE_COMMIT: FULL_SHA,
      });
      expect(offer.sourceUrl.startsWith("https://")).toBe(true);
      expect(offer.repositoryUrl).toBe(DEFAULT_SOURCE_REPOSITORY_URL);
    }
  });
});

describe("buildSourceOffer — purity and defaults", () => {
  // The offer must come from the environment it was HANDED, never from the ambient
  // one, so that a test cannot pass off the host process and a browser bundle has
  // nothing to read.
  //
  // What this arm catches is the realistic shape: an ambient-env FALLBACK inside
  // the lookup (`env[name] ?? process.env[name]`), which it turns red. What it
  // cannot catch is a PARAMETER DEFAULT (`env: SourceOfferEnv = process.env`),
  // because a default never fires for an explicitly-passed `{}` — measured, it
  // survives this test. The arity assertion below is what catches that one inside
  // the suite; `tsc` catches it a second time (`@metis/shared` compiles against
  // `lib: ["ES2023"]` with no Node types, so `process` here is `error TS2591`).
  // Three gates over one property, named here so none is mistaken for another.
  it("takes the environment as a REQUIRED parameter", () => {
    // `Function.length` counts parameters before the first one with a default, so
    // adding `= process.env` takes this to 0. That is the exact mutation review
    // found surviving the suite, and this is the arm that turns it red without
    // waiting for a typecheck.
    expect(buildSourceOffer).toHaveLength(1);
  });

  it("does not fall back to the ambient process environment", () => {
    const previous = process.env.METIS_SOURCE_COMMIT;
    process.env.METIS_SOURCE_COMMIT = FULL_SHA;
    try {
      expect(buildSourceOffer({}).commit).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.METIS_SOURCE_COMMIT;
      else process.env.METIS_SOURCE_COMMIT = previous;
    }
  });

  it("is well-formed for an empty environment", () => {
    const offer = buildSourceOffer({});
    expect(offer.license).toBe(OUTBOUND_LICENSE_ID);
    expect(offer.sourceUrl.startsWith("https://")).toBe(true);
  });

  it("points at the openzigs repository by default", () => {
    expect(DEFAULT_SOURCE_REPOSITORY_URL).toBe("https://github.com/openzigs/metis");
  });
});

describe("parseSourceOffer", () => {
  it("rebuilds an offer from a well-formed document", () => {
    const served = buildSourceOffer({ METIS_SOURCE_COMMIT: FULL_SHA });
    expect(parseSourceOffer(JSON.parse(JSON.stringify(served)))).toEqual(served);
  });

  // The whole point of re-deriving rather than trusting: a body may arrive with a
  // hostile `sourceUrl`/`commitUrl` from anything sitting between the browser and
  // the server. Those fields are recomputed from `commit` + `repositoryUrl`, so a
  // tampered link cannot reach an `href`.
  it("ignores sourceUrl, commitUrl and archiveUrl in the document and recomputes them", () => {
    const parsed = parseSourceOffer({
      commit: FULL_SHA,
      repositoryUrl: DEFAULT_SOURCE_REPOSITORY_URL,
      sourceUrl: "javascript:alert(1)",
      commitUrl: "javascript:alert(2)",
      archiveUrl: "javascript:alert(3)",
      license: "MIT",
    });
    expect(parsed?.sourceUrl).toBe(`${DEFAULT_SOURCE_REPOSITORY_URL}/tree/${FULL_SHA}`);
    expect(parsed?.commitUrl).toBe(`${DEFAULT_SOURCE_REPOSITORY_URL}/tree/${FULL_SHA}`);
    expect(parsed?.archiveUrl).toBe(`${DEFAULT_SOURCE_REPOSITORY_URL}/archive/${FULL_SHA}.tar.gz`);
    expect(JSON.stringify(parsed)).not.toContain("javascript:");
  });

  // A served `license` field is not authority over what THIS build is licensed
  // under. The constant wins, so a downgraded or spoofed licence string cannot be
  // displayed to a user as the terms they are being offered.
  it("never lets the document override the licence", () => {
    expect(parseSourceOffer({ license: "MIT", commit: FULL_SHA })?.license).toBe("AGPL-3.0-only");
  });

  it("degrades a hostile repositoryUrl to the default", () => {
    const parsed = parseSourceOffer({ repositoryUrl: "javascript:alert(1)", commit: FULL_SHA });
    expect(parsed?.repositoryUrl).toBe(DEFAULT_SOURCE_REPOSITORY_URL);
  });

  it("accepts a document with no commit and offers the repository", () => {
    const parsed = parseSourceOffer({ repositoryUrl: DEFAULT_SOURCE_REPOSITORY_URL });
    expect(parsed?.commit).toBeNull();
    expect(parsed?.sourceUrl).toBe(DEFAULT_SOURCE_REPOSITORY_URL);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "AGPL-3.0-only"],
    ["a number", 7],
    ["an array", [{ license: "AGPL-3.0-only" }]],
  ])("returns null for %s", (_label, value) => {
    expect(parseSourceOffer(value)).toBeNull();
  });

  it("tolerates non-string commit and repositoryUrl fields", () => {
    const parsed = parseSourceOffer({ commit: 12345, repositoryUrl: { evil: true } });
    expect(parsed?.commit).toBeNull();
    expect(parsed?.repositoryUrl).toBe(DEFAULT_SOURCE_REPOSITORY_URL);
  });
});
