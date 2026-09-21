"use client";

import { useEffect, useState } from "react";
import {
  type SourceOffer,
  buildSourceOffer,
  parseSourceOffer,
  OUTBOUND_LICENSE_ID,
} from "@metis/shared";

/**
 * #1296 — **the AGPL-3.0 §13 source offer, in the interface.**
 *
 * §13 obliges a network-served AGPL program to *prominently offer* every remote user
 * an opportunity to receive the Corresponding Source **of the running version**. The
 * FSF's own application notes describe exactly this affordance: *"if your program is a
 * web application, its interface could display a 'Source' link that leads users to an
 * archive of the code."*
 *
 * `server/src/routes/source.ts` serves the machine-readable half at `/source` and
 * `/api/source`. This is the half a person sees, and it is the endpoint's first
 * consumer.
 *
 * ## Why it renders before the fetch resolves
 *
 * The offer is built from build-time values on the very first render and only
 * *upgraded* when `/api/source` answers. That ordering is the compliance-relevant
 * part: an affordance that appears only when an API call succeeds vanishes exactly
 * when the deployment is unhealthy, and a §13 obligation does not pause for an
 * outage. The degraded state still names the licence and still links to the
 * repository — it just cannot name the commit, and says so rather than implying
 * otherwise.
 *
 * ## Why the response is re-derived rather than read
 *
 * `parseSourceOffer` takes only `commit` and `repositoryUrl` from the body and
 * recomputes every URL. The response therefore cannot supply an `href`: a proxy, a
 * captive portal or a misrouted `/api/*` handler that returns a well-shaped body with
 * a `javascript:` `sourceUrl` in it changes nothing on screen. Validating at the
 * boundary is cheaper than escaping at every use, and there is exactly one boundary.
 *
 * ## Where it is mounted
 *
 * Twice, deliberately: in `AppShell` for every authenticated route, and on the
 * sign-in page. §13 says *all* users interacting remotely — a visitor who has not
 * signed in is one of them, and the sign-in page is the only thing they can see.
 */

/** The endpoint this footer consumes. Proxied to the Express server by Next.js. */
const SOURCE_OFFER_ENDPOINT = "/api/source";

/**
 * The offer available without any network call.
 *
 * `NEXT_PUBLIC_*` values are inlined by Next.js at build time, so they describe the
 * commit this *bundle* was built from. The endpoint's answer describes the commit the
 * *server process* is running, which is the more truthful answer to §13 and therefore
 * wins when it arrives. In a monorepo deployed as one unit the two agree; when they do
 * not, the server is the program the user is interacting with.
 *
 * @returns a complete offer built from build-time values
 */
function buildTimeOffer(): SourceOffer {
  return buildSourceOffer({
    METIS_SOURCE_COMMIT: process.env.NEXT_PUBLIC_METIS_SOURCE_COMMIT,
    METIS_SOURCE_REPOSITORY_URL: process.env.NEXT_PUBLIC_METIS_SOURCE_REPOSITORY_URL,
  });
}

/**
 * Persistent AGPL-3.0 §13 source-offer footer.
 *
 * @returns a `contentinfo` landmark naming the licence and linking to the source of
 *   the running deployment
 */
export function SourceOfferFooter() {
  const [offer, setOffer] = useState<SourceOffer>(buildTimeOffer);

  useEffect(() => {
    let cancelled = false;

    async function loadOffer(): Promise<void> {
      try {
        const response = await fetch(SOURCE_OFFER_ENDPOINT, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) return;
        const parsed = parseSourceOffer(await response.json());
        if (parsed !== null && !cancelled) setOffer(parsed);
      } catch {
        // Keep the build-time offer. A network or parse failure must not remove the
        // §13 affordance — see the note above about outages.
      }
    }

    void loadOffer();
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceLabel = offer.commitKnown
    ? `Source code for the running version, commit ${offer.commitShort}`
    : "Source code — this deployment's exact commit is not identified";

  return (
    <footer
      data-testid="source-offer-footer"
      className="border-t border-border px-4 py-3 text-xs text-muted-foreground md:px-6"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          METIS is free software, licensed under{" "}
          <a
            href={offer.licenseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {OUTBOUND_LICENSE_ID}
          </a>
          .
        </span>
        <span aria-hidden="true">·</span>
        <a
          data-testid="source-offer-link"
          href={offer.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={sourceLabel}
          className="underline underline-offset-2 hover:text-foreground"
        >
          {offer.commitKnown ? `Source (${offer.commitShort})` : "Source code"}
        </a>
        {offer.archiveUrl !== null && (
          <>
            <span aria-hidden="true">·</span>
            <a
              data-testid="source-offer-archive-link"
              href={offer.archiveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Download source archive
            </a>
          </>
        )}
      </p>
    </footer>
  );
}
