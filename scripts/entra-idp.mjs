#!/usr/bin/env node
/**
 * #1559 — run the Entra-profile mock SAML IdP next to a dev server and seed
 * METIS's SAML provider from it, to click through an Entra sign-in by hand.
 *
 *   pnpm saml:entra                    # in the foreground; Ctrl-C stops it
 *   make entra-up / make entra-down    # detached (scripts/saml-harness/entra-up.sh)
 *
 * Arguments: --signing=<both|assertion|response>, --port=<n>, --no-seed.
 * Environment: ENTRA_SIGNING, ENTRA_IDP_PORT, METIS_API_URL, METIS_APP_URL,
 * METIS_ADMIN_USER, METIS_ADMIN_PASSWORD, ENTRA_PROVIDER_NAME, SKIP_SEED=1.
 * See docs/auth/saml-local-testing.md and scripts/lib/entra-idp-harness.mjs.
 */
import { resolveHarnessConfig, runEntraHarness } from "./lib/entra-idp-harness.mjs";

/** @param {unknown} err */
function fail(err) {
  process.stderr.write(`  FAIL ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

try {
  const config = resolveHarnessConfig(process.env, process.argv.slice(2));
  const { idp, banner } = await runEntraHarness({
    config,
    log: (line) => process.stdout.write(`  - ${line}\n`),
  });
  const stop = () => {
    void idp.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write(banner);
} catch (err) {
  fail(err);
}
