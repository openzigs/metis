/**
 * #1296 — **does anything this repository ships actually SET the commit?**
 *
 * `source-route.test.ts` proves `/source` answers correctly for a given environment.
 * `packages/shared/src/source-offer.test.ts` proves the offer is derived correctly.
 * Neither can see the defect that review found: at the point those two shipped,
 * nothing in the repository's own deploy artifacts set `METIS_SOURCE_COMMIT` at all,
 * so every deployment built from this tree answered
 * "this deployment's exact commit is not identified" — the degraded offer, on exactly
 * the axis AGPL-3.0 §13 cares about, failing silently and passing every test.
 *
 * That is the "write reports success while the read cannot see it" shape, at the
 * configuration layer: the endpoint worked, and the value it needed never arrived.
 *
 * So this file asserts the WIRING, and it asserts it against the constants in
 * `@metis/shared` rather than against string literals. If `SOURCE_COMMIT_ENV_VARS` is
 * ever renamed, these fail and point at the deploy artifacts that must move with it —
 * which is the failure the runtime would otherwise absorb in silence.
 *
 * Two different mechanisms, because the two halves are genuinely different:
 *
 *   * the SERVER reads the variable at request time, so a runtime `ENV` is enough;
 *   * the UI has its value inlined by Next.js at `next build`, so `NEXT_PUBLIC_*`
 *     must arrive as a build `ARG`. A runtime environment variable on the UI
 *     container is read too late and is silently ignored — which is the single
 *     easiest way to "fix" this and still be broken.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SOURCE_COMMIT_ENV_VARS, SOURCE_REPOSITORY_ENV_VAR } from "@metis/shared";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** The variable a deployment is expected to set — first in precedence order. */
const PRIMARY_COMMIT_VAR = SOURCE_COMMIT_ENV_VARS[0];

/** The build-time twin Next.js inlines. */
const PUBLIC_COMMIT_VAR = `NEXT_PUBLIC_${PRIMARY_COMMIT_VAR}`;

const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const envExample = read(".env.example");
const dockerfileServer = read("Dockerfile.server");
const dockerfileUi = read("Dockerfile.ui");
const composeBase = read("docker-compose.yml");
const composeProd = read("docker-compose.prod.yml");

describe(".env.example", () => {
  it(`documents ${PRIMARY_COMMIT_VAR}`, () => {
    expect(envExample).toContain(`${PRIMARY_COMMIT_VAR}=`);
  });

  it(`documents ${PUBLIC_COMMIT_VAR}, the build-time twin`, () => {
    expect(envExample).toContain(`${PUBLIC_COMMIT_VAR}=`);
  });

  it(`mentions ${SOURCE_REPOSITORY_ENV_VAR} for modified deployments`, () => {
    // §13 obliges a modified deployment to offer ITS source, not ours. An operator
    // who never learns this variable exists cannot comply.
    expect(envExample).toContain(SOURCE_REPOSITORY_ENV_VAR);
  });

  it("ships no hardcoded commit value", () => {
    // A checked-in sha would be wrong for every build, and wrong-with-confidence is
    // worse than the honest unknown the offer degrades to.
    const assignment = new RegExp(`^${PRIMARY_COMMIT_VAR}=(.*)$`, "m").exec(envExample);
    expect(assignment).not.toBeNull();
    expect(assignment?.[1].trim()).toBe("");
  });
});

describe("Dockerfile.server", () => {
  it(`accepts ${PRIMARY_COMMIT_VAR} as a build argument`, () => {
    expect(dockerfileServer).toMatch(new RegExp(`^ARG ${PRIMARY_COMMIT_VAR}=`, "m"));
  });

  it(`bakes it into the runtime environment, where the request-time read finds it`, () => {
    expect(dockerfileServer).toMatch(
      new RegExp(`^ENV ${PRIMARY_COMMIT_VAR}=\\$\\{${PRIMARY_COMMIT_VAR}\\}`, "m"),
    );
  });

  it("declares the image's licence and source in OCI labels", () => {
    expect(dockerfileServer).toContain('org.opencontainers.image.licenses="AGPL-3.0-only"');
    expect(dockerfileServer).toContain("org.opencontainers.image.source=");
  });
});

describe("Dockerfile.ui", () => {
  it(`accepts ${PRIMARY_COMMIT_VAR} as a build argument`, () => {
    expect(dockerfileUi).toMatch(new RegExp(`^ARG ${PRIMARY_COMMIT_VAR}=`, "m"));
  });

  it(`maps it to ${PUBLIC_COMMIT_VAR} BEFORE the build step that inlines it`, () => {
    const envLine = dockerfileUi.search(
      new RegExp(`^ENV ${PUBLIC_COMMIT_VAR}=\\$\\{${PRIMARY_COMMIT_VAR}\\}`, "m"),
    );
    const buildLine = dockerfileUi.search(/pnpm --filter @metis\/ui build/);
    expect(envLine).toBeGreaterThan(-1);
    expect(buildLine).toBeGreaterThan(-1);
    // Ordering is the whole point: set after `next build`, the value is never inlined
    // and the footer is permanently degraded while the Dockerfile looks correct.
    expect(envLine).toBeLessThan(buildLine);
  });

  it("declares the image's licence and source in OCI labels", () => {
    expect(dockerfileUi).toContain('org.opencontainers.image.licenses="AGPL-3.0-only"');
    expect(dockerfileUi).toContain("org.opencontainers.image.source=");
  });
});

describe("compose", () => {
  it("passes the commit to the UI image as a BUILD arg, not a runtime variable", () => {
    expect(composeBase).toMatch(
      new RegExp(`args:[\\s\\S]{0,200}${PRIMARY_COMMIT_VAR}: \\$\\{${PRIMARY_COMMIT_VAR}:-\\}`),
    );
  });

  it("gives the production server the commit at runtime", () => {
    expect(composeProd).toMatch(new RegExp(`environment:[\\s\\S]{0,900}${PRIMARY_COMMIT_VAR}:`));
  });

  it("uses compose's PASS-THROUGH form at runtime, never an empty default", () => {
    // `METIS_SOURCE_COMMIT: ${METIS_SOURCE_COMMIT:-}` renders as `""` when the
    // operator has not exported it — verified with `docker compose config` — and an
    // empty runtime value SHADOWS the value Dockerfile.server baked in at build
    // time. A correctly built image would then serve a degraded §13 offer, silently,
    // because of the line that was supposed to supply the commit. The bare
    // `METIS_SOURCE_COMMIT:` form omits the variable instead.
    //
    // Build `args:` are exempt: there an empty value is identical to the
    // Dockerfile's own `ARG ...=""` default, so it shadows nothing.
    const runtimeBlock = composeProd.slice(composeProd.indexOf("environment:"));
    for (const name of [PRIMARY_COMMIT_VAR, SOURCE_REPOSITORY_ENV_VAR]) {
      expect(runtimeBlock).toContain(`${name}:\n`);
      expect(runtimeBlock).not.toContain(`${name}: \${${name}:-}`);
    }
  });

  it("passes the commit to the production server build as well", () => {
    expect(composeProd).toMatch(
      new RegExp(`dockerfile: Dockerfile.server[\\s\\S]{0,200}${PRIMARY_COMMIT_VAR}:`),
    );
  });
});
