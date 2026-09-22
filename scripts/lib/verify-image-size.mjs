/**
 * Cross-platform `verify:image-size` helper (Issue #189 / Epic #183).
 *
 * Port of `scripts/verify-image-size.sh`: builds the metis-server / metis-ui /
 * metis-embeddings images (unless `--no-build`) and asserts metis-ui stays under
 * `MAX_IMAGE_MB` (default 350) and metis-server under its own measured budget,
 * `MAX_SERVER_IMAGE_MB` (default 900, #34). The embeddings sidecar is measured
 * for visibility but exempt from the budget (Issue #145).
 *
 * Runs on Windows, macOS, and Linux: `docker` is invoked via
 * `child_process.execFileSync` with an ARGUMENT ARRAY (never a shell string),
 * so no untrusted input can ever reach a shell — OWASP command-injection safe.
 *
 * Pure helpers (`bytesToMb`, `isOverBudget`, `parseBudgetMb`, `evaluateSizes`)
 * are split out so the budget logic is unit-tested without Docker.
 *
 * Exit codes match the original script:
 *   0  both gated images present and within their budgets
 *   1  an image exceeds the limit OR is missing
 *   2  invalid invocation / docker not available
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

export const DEFAULT_MAX_IMAGE_MB = 350;

/**
 * `metis-server`'s own budget, in MB, measured on a GitHub-hosted amd64 runner (#34).
 *
 * 900 MB is the measured amd64 size (821 MB) plus ~10% headroom, and it is
 * PROVISIONAL: two of the largest contributors — the Oracle Instant Client and
 * LanceDB's native library, ~237 MB together — do not load in this image (#39),
 * and three `@napi-rs/canvas` copies and tesseract's unused WASM variants are
 * still reducible. Re-measure once #39 lands. The breakdown is in
 * docs/OPERATIONS.md > "Container Image Sizes". This is a REGRESSION gate:
 * measured size plus modest headroom, never a number raised until CI goes green.
 * `MAX_SERVER_IMAGE_MB` overrides it.
 */
export const DEFAULT_MAX_SERVER_IMAGE_MB = 900;

/** @typedef {{ tag: string, mb: number | null, exempt: boolean, budgetMb?: number }} ImageSize */

/**
 * Convert a byte count to MB using the decimal convention `docker images`
 * displays (bytes / 1000 / 1000), rounded to one decimal.
 *
 * @param {number} bytes
 * @returns {number}
 */
export function bytesToMb(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / 1000 / 1000) * 10) / 10;
}

/**
 * Parse the `MAX_IMAGE_MB` env value, falling back to {@link DEFAULT_MAX_IMAGE_MB}
 * for absent / blank / non-numeric / non-positive input.
 *
 * @param {string | undefined} raw
 * @returns {number}
 */
export function parseBudgetMb(raw) {
  if (raw == null || raw.trim().length === 0) return DEFAULT_MAX_IMAGE_MB;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_IMAGE_MB;
}

/**
 * True when a measured size exceeds the budget.
 *
 * @param {number} mb
 * @param {number} budgetMb
 * @returns {boolean}
 */
export function isOverBudget(mb, budgetMb) {
  return mb > budgetMb;
}

/**
 * The budget one image is held to (#34). An image that declares its own budget
 * takes its env override when that is set and valid, else its documented default —
 * never the general budget, which would silently re-impose 350 MB on the server.
 * An image with no budget of its own takes the general budget.
 *
 * @param {{ budgetEnv?: string, defaultBudgetMb?: number }} image
 * @param {number} generalBudgetMb
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function resolveImageBudget(image, generalBudgetMb, env) {
  if (image.defaultBudgetMb == null) return generalBudgetMb;
  const raw = image.budgetEnv ? env[image.budgetEnv] : undefined;
  if (raw == null || raw.trim().length === 0) return image.defaultBudgetMb;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : image.defaultBudgetMb;
}

/**
 * Evaluate measured image sizes against the budget. Pure: no Docker, no I/O.
 *
 * A gated image FAILS when it is missing (`mb == null`) or over budget. Exempt
 * images (the embeddings sidecar) never fail the gate but are reported.
 *
 * @param {ImageSize[]} sizes
 * @param {number} budgetMb
 * @returns {{ ok: boolean, failures: string[] }}
 */
export function evaluateSizes(sizes, budgetMb) {
  /** @type {string[]} */
  const failures = [];
  for (const { tag, mb, exempt, budgetMb: ownBudgetMb } of sizes) {
    if (exempt) continue;
    if (mb == null) {
      failures.push(`${tag}: image not found or zero size`);
      continue;
    }
    const limit = ownBudgetMb ?? budgetMb;
    if (isOverBudget(mb, limit)) {
      failures.push(`${tag} = ${mb} MB exceeds ${limit} MB`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Parse a `docker image ls --format '{{.Size}}'` human-readable size (e.g.
 * "329MB", "1.2GB", "67.8 MB", "512kB") into bytes. Docker uses decimal units.
 * Returns `null` when the value is absent / unparseable / zero.
 *
 * @param {string} raw
 * @returns {number | null}
 */
export function parseHumanSizeToBytes(raw) {
  const s = String(raw ?? "")
    .split("\n")[0]
    ?.trim();
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*([kKmMgGtT]?)i?[bB]?$/);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2].toLowerCase();
  const factor = { "": 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[unit] ?? 1;
  const bytes = Math.round(value * factor);
  return bytes > 0 ? bytes : null;
}

/**
 * Inspect one image's size in bytes. Returns `null` when the image is absent or
 * reports zero size.
 *
 * Two robustness layers address the recurring image-size flake (Issue #509):
 *
 *  1. **Manifest-index / attestation tolerance.** BuildKit adds a `mode=min`
 *     provenance attestation by default, wrapping the result in an OCI image
 *     INDEX. For such a tag `docker image inspect --format '{{.Size}}'` returns
 *     EMPTY (an index has no single `.Size`) even though the image is present —
 *     the deterministic cause of `image not found or zero size`. When the
 *     inspect size is empty/zero we fall back to `docker image ls --format
 *     '{{.Size}}'`, which reports a human-readable size for index tags too.
 *  2. **Post-build race tolerance.** A single inspect immediately after a build
 *     can momentarily miss the freshly-committed image under concurrent CI load,
 *     so the whole probe is retried a few times with a short backoff.
 *
 * `run`, `retries`, and `sleepMs` are injectable so tests stay deterministic and
 * never sleep.
 *
 * @param {string} tag
 * @param {object} [deps]
 * @param {(args: string[]) => string} [deps.run] - docker runner returning stdout.
 * @param {number} [deps.retries] - extra probe attempts after the first (default 0).
 * @param {(ms: number) => void} [deps.sleepMs] - blocking sleep between attempts.
 * @returns {number | null}
 */
export function inspectImageBytes(tag, deps = {}) {
  const run =
    deps.run ??
    /* c8 ignore next 2 — real docker shell-out, covered via injected runner in tests */
    ((args) =>
      execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const rawRetries = deps.retries;
  const retries =
    typeof rawRetries === "number" && Number.isInteger(rawRetries) && rawRetries > 0
      ? rawRetries
      : 0;
  const sleepMs =
    deps.sleepMs ??
    /* c8 ignore next 4 — real blocking sleep; tests inject a no-op sleepMs */
    ((ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        /* busy-wait: keeps the helper sync + dependency-free */
      }
    });

  const inspectOnce = () => {
    let out;
    try {
      out = run(["image", "inspect", tag, "--format", "{{.Size}}"]);
    } catch {
      out = "";
    }
    const first = String(out).split("\n")[0]?.replace(/\s/g, "") ?? "";
    if (first.length > 0 && first !== "0") {
      const n = Number.parseInt(first, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    // Index/attestation tag: `{{.Size}}` is empty — fall back to `image ls`.
    let lsOut;
    try {
      lsOut = run(["image", "ls", "--format", "{{.Size}}", tag]);
    } catch {
      lsOut = "";
    }
    return parseHumanSizeToBytes(lsOut);
  };

  const attempts = retries + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const bytes = inspectOnce();
    if (bytes != null) return bytes;
    // Transient miss: back off and retry unless this was the last attempt.
    if (attempt < attempts - 1) sleepMs(500 * (attempt + 1));
  }
  return null;
}

/**
 * Tag suffix for the images this run builds/inspects.
 *
 * Issue #801 — CI used a FIXED `:test` tag on a SHARED self-hosted Docker daemon,
 * so two concurrent runs collided: run A's cleanup (`docker rmi metis-server:test`)
 * deleted run B's freshly-built image, and B's size gate then failed with
 * "image not found or zero size" — a red job with no code defect behind it. Same
 * bug class as #754 (a fixed host port 5432 on the same shared runner): on a shared
 * box, ANY globally-named resource is a race.
 *
 * CI now passes a run-scoped value (`IMAGE_TAG=ci-<run_id>`), so builds, the size
 * gate and the cleanup all address images unique to that run. Defaults to `test`
 * for local use.
 */
const IMAGE_TAG = process.env.IMAGE_TAG?.trim() || "test";

const IMAGES = Object.freeze([
  {
    tag: `metis-server:${IMAGE_TAG}`,
    dockerfile: "Dockerfile.server",
    exempt: false,
    budgetEnv: "MAX_SERVER_IMAGE_MB",
    defaultBudgetMb: DEFAULT_MAX_SERVER_IMAGE_MB,
  },
  { tag: `metis-ui:${IMAGE_TAG}`, dockerfile: "Dockerfile.ui", exempt: false },
  { tag: `metis-embeddings:${IMAGE_TAG}`, dockerfile: "Dockerfile.embeddings", exempt: true },
]);

/**
 * Run the full verification. Returns the process exit code (does not call
 * `process.exit`, so it is testable).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.noBuild]
 * @param {number} [opts.budgetMb]
 * @param {Record<string, string | undefined>} [opts.env] - environment for
 *   per-image budget overrides (defaults to `process.env`).
 * @param {number} [opts.inspectRetries] - extra inspect attempts to ride out the
 *   post-build daemon race (#509); ignored when `deps.retries` is set.
 * @param {object} [opts.deps]
 * @param {(args: string[]) => void} [opts.deps.build] - docker build runner.
 * @param {(args: string[]) => string} [opts.deps.run] - docker inspect runner.
 * @param {() => boolean} [opts.deps.hasDocker]
 * @param {(msg: string) => void} [opts.deps.log]
 * @param {(msg: string) => void} [opts.deps.err]
 * @param {number} [opts.deps.retries] - forwarded to {@link inspectImageBytes};
 *   when set, suppresses the real busy-wait so tests stay deterministic.
 * @param {(ms: number) => void} [opts.deps.sleepMs] - forwarded inspect sleep.
 * @returns {number}
 */
export function runVerify(opts = {}) {
  const budgetMb = opts.budgetMb ?? parseBudgetMb(process.env.MAX_IMAGE_MB);
  const env = opts.env ?? process.env;
  const deps = opts.deps ?? {};
  /* c8 ignore next 2 — default console loggers; tests inject spies */
  const log = deps.log ?? ((m) => console.log(m));
  const err = deps.err ?? ((m) => console.error(m));
  const hasDocker =
    deps.hasDocker ??
    /* c8 ignore start — real docker probe; tests inject hasDocker */
    (() => {
      try {
        execFileSync("docker", ["--version"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    });
  /* c8 ignore stop */

  if (!hasDocker()) {
    err("ERR: docker is not installed or not in PATH");
    return 2;
  }

  if (!opts.noBuild) {
    const build =
      deps.build ??
      /* c8 ignore next — real docker build; tests inject build */
      ((args) => execFileSync("docker", args, { stdio: "inherit" }));
    for (const img of IMAGES) {
      log(`==> Building ${img.tag}${img.exempt ? " (sidecar — exempt)" : ""}`);
      build(["build", "-f", img.dockerfile, "-t", img.tag, "."]);
    }
  }

  // Retry the inspect a few times to ride out the post-build daemon race that
  // sporadically reports a freshly-built image as missing under CI load (#509).
  // Tests inject `deps.retries`/`deps.sleepMs` (or rely on the default 0 retries
  // via a stubbed `run`) so they never sleep.
  const inspectDeps = deps.retries == null ? { ...deps, retries: opts.inspectRetries ?? 3 } : deps;

  /** @type {ImageSize[]} */
  const sizes = IMAGES.map((img) => {
    const bytes = inspectImageBytes(img.tag, inspectDeps);
    return {
      tag: img.tag,
      mb: bytes == null ? null : bytesToMb(bytes),
      exempt: img.exempt,
      budgetMb: resolveImageBudget(img, budgetMb, env),
    };
  });

  log("");
  log(`${"IMAGE".padEnd(30)} ${"SIZE (MB)".padStart(12)} ${"BUDGET (MB)".padStart(12)}`);
  for (const s of sizes) {
    const budget = s.exempt ? "exempt" : String(s.budgetMb);
    const suffix = s.exempt ? "   (sidecar)" : "";
    log(
      `${s.tag.padEnd(30)} ${String(s.mb ?? "n/a").padStart(12)} ${budget.padStart(12)}${suffix}`,
    );
  }
  log("");

  const { ok, failures } = evaluateSizes(sizes, budgetMb);
  if (!ok) {
    for (const f of failures) err(`FAIL: ${f}`);
    err("");
    err("Image size budget exceeded. See docs/OPERATIONS.md > 'Container Image Sizes'.");
    return 1;
  }
  log("OK: every gated image is within its budget");
  return 0;
}

/* c8 ignore start — CLI entrypoint, exercised via `pnpm verify:image-size` */
// CLI entrypoint.
if (process.argv[1]?.endsWith("verify-image-size.mjs")) {
  const noBuild = process.argv.includes("--no-build");
  process.exit(runVerify({ noBuild }));
}
/* c8 ignore stop */
