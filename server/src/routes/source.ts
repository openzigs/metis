/**
 * #1296 — **the AGPL-3.0 §13 network source offer.**
 *
 * §13 obliges a network-served version of an AGPL program to "prominently offer all
 * users interacting with it remotely through a computer network ... an opportunity to
 * receive the Corresponding Source of your version". The FSF's own application notes
 * spell out the expected shape: *"if your program is a web application, its interface
 * could display a 'Source' link that leads users to an archive of the code."*
 *
 * This route is the machine-readable half of that. The human half is the footer in
 * `ui/src/components/layout/source-offer-footer.tsx`, which fetches this document and
 * renders the link. Both derive every field from `buildSourceOffer` in
 * `@metis/shared`, so the page and the endpoint cannot disagree about which commit is
 * running.
 *
 * ## Three deliberate choices
 *
 * **Unauthenticated.** §13 says *all* users interacting remotely. An offer behind a
 * login is not offered to the people most likely to want it. It leaks nothing: the
 * repository is public and the commit is the one whose source we are obliged to hand
 * over on request anyway.
 *
 * **Two mount points.** `/source` is what a person or a tool guesses, and it sits
 * beside `/healthz` at the top level rather than under the API prefix. `/api/source`
 * is what the browser reaches through the Next.js proxy. One handler, two paths, one
 * test suite over both.
 *
 * **Read per request, `no-store`.** The commit is read from the environment on every
 * call and the response forbids caching. A §13 answer that was computed at module
 * load, or cached by a CDN, keeps naming the previous deployment's commit after a
 * roll — which is precisely the wrong answer, and one that nothing would surface.
 */
import { Router, type RequestHandler } from "express";
import { type SourceOffer, buildSourceOffer } from "@metis/shared";

/**
 * Serve the §13 offer for this process.
 *
 * Never fails: `buildSourceOffer` returns a complete document for any environment,
 * degrading to "repository known, commit unknown" rather than erroring. An endpoint
 * whose job is to discharge a licence obligation must not have a 500 path.
 */
export const sourceHandler: RequestHandler = (_req, res) => {
  const offer: SourceOffer = buildSourceOffer(process.env);
  res.set("Cache-Control", "no-store, max-age=0");
  res.json(offer);
};

/** Router form, for mounting under the `/api` prefix. */
export function sourceRouter(): Router {
  const r = Router();
  r.get("/", sourceHandler);
  return r;
}
