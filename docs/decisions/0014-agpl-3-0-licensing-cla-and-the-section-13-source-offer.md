# 14. AGPL-3.0-only, a relicensing CLA, and a §13 source offer that is code rather than a file

- **Status:** Accepted
- **Date:** 2026-09-20
- **Issues:** [#1296](https://github.com/openzigs/metis-private/issues/1296),
  [#1301](https://github.com/openzigs/metis-private/issues/1301),
  [#1390](https://github.com/openzigs/metis-private/issues/1390) (the licence half of
  [#1302](https://github.com/openzigs/metis-private/issues/1302)); epic
  [#1293](https://github.com/openzigs/metis-private/issues/1293)
- **Supersedes** the Apache-2.0 direction recorded in the original text of #1296, and
  the open-core rationale for a CLA in the original text of #1301
  ([#1294](https://github.com/openzigs/metis-private/issues/1294), closed as superseded).

## Context

METIS had **no `LICENSE` file at all**. Absent one, the work is all-rights-reserved by
default: publishing the repository as it stood would have left every visitor legally
unable to use it. Ten `package.json` files declared no `license` field. There was no
`CONTRIBUTING.md`, no CLA, and no mechanism by which a remote user of a deployment
could obtain its source.

This ADR records seven decisions made together, because they are not separable: the
CLA's text has to agree with the outbound licence, and the contributor documentation
has to explain both.

## Decision 1 — `AGPL-3.0-only`

Apache-2.0 was the earlier direction, on the premise that revenue would come from
self-hosted licences and there was therefore no cloud-resale threat. That premise is
withdrawn. Apache-2.0 explicitly grants the right to sell and host the software, so it
cannot satisfy the requirement that no one fork METIS and monetise it.

No licence that forbids commercial use can be called open source — OSD clause 6 forbids
discriminating against fields of endeavour — so "open source but no commercial use" was
never on the table.

AGPL-3.0 is the strongest protection that remains genuinely open source and
OSI-approved. A competitor may legally offer a hosted METIS, but §13 obliges them to
publish every modification to anyone interacting with it over a network. That removes
most of the commercial incentive without an outright ban.

**The cost, recorded rather than left to be rediscovered:** some enterprises maintain
AGPL ban lists and will refuse to adopt METIS on those grounds. That is the price of
the protection.

## Decision 2 — `-only`, not `-or-later`

`-or-later` lets any future AGPL version published by the Free Software Foundation
govern these terms. That is a delegation of authority over the licence to a third
party, made in advance and irrevocably. `-only` keeps the choice with the copyright
holder, which is consistent with wanting to relicense on our own schedule — the same
motivation as Decision 4.

The distinction is enforced mechanically, not by convention:
`scripts/lib/license-metadata-core.mjs` treats `AGPL-3.0-or-later` as
`wrong-license`, not as a near-enough spelling, and the gate runs in `pnpm lint`.

## Decision 3 — copyright to Zylos Labs LLC; the repository lives in `openzigs`

`NOTICE` attributes copyright to **Zylos Labs LLC**. The repository is hosted in the
`openzigs` GitHub organisation. These are deliberately different things — where the
code is hosted is not who owns it — and conflating them in a copyright line would
misstate the holder.

## Decision 4 — a CLA, for relicensing freedom and nothing else

Contributors sign [`CLA.md`](../../CLA.md). The reason is narrow and is stated in those
terms in `CONTRIBUTING.md`: **to preserve the ability to change METIS's licence in
future.**

Relicensing requires permission from every copyright holder in the codebase. Once
outside contributions land without a grant of those rights, the option is gone
permanently — contributors change employers, become unreachable, or decline. A DCO
does not solve this: it asserts the contributor *had the right to submit* their work
and grants no right to redistribute it under different terms. A DCO is right for a
project that has settled its licence forever. This one has not.

It is **not** protecting a revenue stream. There is no paid tier (#1294 closed as
superseded), and describing the CLA as protecting revenue would be false.

**The cost is stated in `CONTRIBUTING.md` without euphemism**, because the honest
answer — "so the owner can change the licence later" — is one some contributors will
read as "so the owner can close this later", and a contributor who discovers that after
signing is a worse outcome than one who declines up front.

### 4a — the Apache ICLA needed a substantive change, not just a find-and-replace

The Apache ICLA v2.2 was the starting point, as the issue anticipated. Reviewing it
against a **copyleft** outbound licence surfaced a real defect, not a cosmetic one.

ICLA clauses 2 and 3 grant a copyright and patent licence "to the Foundation **and to
recipients of software distributed by the Foundation**". That downstream grant is
correct under a permissive outbound licence, where recipients were going to get broad
rights anyway. Under AGPL-3.0 it is corrosive: the ICLA's own grant to recipients —
reproduce, prepare derivative works, publicly display, publicly perform, sublicense,
distribute — carries **no copyleft conditions at all**. A recipient could take a
contributor's work on those terms instead of on AGPL-3.0's, and the network-copyleft
would simply not reach it.

`CLA.md` therefore grants to Zylos Labs LLC **only**, and clause 4 says so explicitly:
recipients get their rights from the outbound licence, not from the contributor. This
is the one clause where adopting the Apache text verbatim would have quietly undermined
the licence chosen in Decision 1.

Two smaller adaptations: clause 2 states the relicensing right in terms rather than
leaving it implied by "sublicense", since that right is the entire reason the agreement
exists; and the ASF's reciprocal undertaking (not to use contributions contrary to the
public benefit or its non-profit status) has no analogue for an LLC and was removed
rather than reworded into something unenforceable.

### 4b — a Corporate CLA is also needed

Yes. In most jurisdictions and most employment contracts, work an employee produces in
the course of employment belongs to the employer. An individual signature in that case
grants rights the signer does not hold, and ICLA clause 5 is exactly where a
well-intentioned contributor can be wrong. Most contributors to a project like this
have an employer in the background, so [`CLA-CORPORATE.md`](../../CLA-CORPORATE.md)
ships now rather than being deferred until the first time it is needed.

### 4c — the perpetuity commitment is NOT made here

#1301 suggests considering a commitment that existing releases stay AGPL-3.0 in
perpetuity, noting that "a CLA plus a credible promise reads very differently from a
CLA alone". That is a substantive legal commitment and only the owner can make it. It
is **not** made by this ADR and remains open.

What `CONTRIBUTING.md` and `CLA.md` state instead is a *checkable fact* rather than a
promise: AGPL-3.0 §2 makes rights already received irrevocable while their conditions
are met, so a future relicence changes the terms of future distribution and cannot
withdraw a licence somebody already holds. That is true whether or not a perpetuity
commitment is ever made, and it costs nothing to say.

### 4d — existing contributions

Everything in the repository to date is first-party and ownership was confirmed by the
owner (#1322 A5). There are no third-party contributions whose rights need gathering
before the CLA takes effect.

### 4e — the bot's signature store, and the two inputs that break it

`contributor-assistant/github-action` stores signatures in a JSON file on a branch.
Three configuration facts, each of which was got wrong once and is cheap to get wrong
again:

**Never set `remote-organization-name` or `remote-repository-name`.** They read like
"which repository is this" and mean the opposite: *store the signature file in a
DIFFERENT repository*. Setting **either** — even to this repository's own org and name
— makes `isRemoteRepoOrOrgConfigured()` true, which routes every signature read and
write through `getPATOctokit()`, which calls `core.setFailed("Please add a personal
access token…")` when `PERSONAL_ACCESS_TOKEN` is absent. Verified in the pinned action
at `ca4a40a7d1004f18d9960b404b97e5f30a505a08` (`src/persistence/persistence.ts`,
`src/octokit.ts`) and in the `dist/index.js` it actually executes. Same-repository
storage is the default, so the correct configuration is to set neither. Adding a token
instead would be strictly worse: a long-lived personal token on a `pull_request_target`
workflow, for no benefit.

The failure mode is what makes this worth an ADR entry and a gate rather than a
comment: **nothing surfaces it until a real outside contributor tries to sign.** No
lint, typecheck, test or CI job exercises the signing path, and in a first-party
repository the first attempt may be months after the change that broke it.
`scripts/verify-cla-workflow.mjs` runs in `pnpm lint` and fails on either input unless
a token really is supplied — phrased as the genuine precondition, so a maintainer who
later wants remote storage is told what to add rather than told "no".

**The `cla-signatures` branch is created ahead of the first signature.** The action
creates the signature *file* but not the *branch*: `createOrUpdateFileContents` targets
a ref that must already exist. The branch was seeded with
`signatures/version1/cla.json` containing `{"signedContributors": []}` and a README
explaining what it is. It must stay unprotected — the action commits with the
workflow's `GITHUB_TOKEN`.

**The copyright holder is on the allowlist.** The CLA grants rights *to* Zylos Labs
LLC; a grant from the receiving party to itself conveys nothing, so `mgcronin` has
nothing to sign. Without the allowlist entry the check is permanently red on the
maintainer's own pull requests, which is how a team learns to stop reading the check
column. Bot accounts (`dependabot[bot]`, `renovate[bot]`, `github-actions[bot]`) are
allowlisted for the different reason that no human can sign for them.

## Decision 5 — no per-file licence headers

**No.** Recorded here so it is not revisited quarterly.

AGPL-3.0 does not require them; `LICENSE` plus `NOTICE` licenses the work. This tree
has 4,000-plus files, so adding headers would be a large mechanical diff that conflicts
with everything in flight and then has to be maintained on every new file forever. The
benefit — a reader learning the licence from a file rather than from the repository
root — is small when the repository root is one click away.

`CONTRIBUTING.md` asks contributors not to add them and points here.

## Decision 6 — the §13 offer is code, and it has a consumer

This is the AGPL obligation with no Apache-2.0 equivalent and the one most likely to be
missed. Because METIS is offered over a network, remote users must be able to obtain
the source of **the running version**. A `LICENSE` file in the repository does not
discharge that: it says nothing about which commit the process in front of the user was
built from. The FSF's own application notes name the expected shape — a "Source" link
in the interface leading to an archive of the code.

Three pieces, one definition:

| Piece | Where | What it is |
|---|---|---|
| The offer, as data | `packages/shared/src/source-offer.ts` | Pure. Reads the commit and repository from the environment; validates both; derives the tree and archive URLs |
| The machine-readable half | `server/src/routes/source.ts` | Unauthenticated `GET /source` and `GET /api/source` |
| The human half | `ui/src/components/layout/source-offer-footer.tsx` | A footer on every page, including sign-in |

Four properties worth recording because each was a decision:

**Unauthenticated.** §13 says *all* users interacting remotely, not all signed-in
users. It leaks nothing — the repository is public and the commit is the thing we are
obliged to hand over on request anyway.

**Mounted on the sign-in page too.** An unauthenticated visitor sees only that page, so
an offer confined to the authenticated shell would miss exactly the users least able to
get the source another way.

**The footer renders before the fetch resolves, and survives its failure.** It is built
from build-time values first and only *upgraded* when `/api/source` answers. An
affordance that appears only when an API call succeeds vanishes exactly when the
deployment is unhealthy, and a licence obligation does not pause for an outage.

**Both inputs are validated before they reach an `href`.** The commit must be a bare
7-to-40-character hex sha and the repository an absolute `https:` URL; anything else
degrades the offer rather than propagating. These are environment variables that end up
as link targets, so an unvalidated one turns a build variable into a scheme. The
footer additionally re-derives every URL from the response's `commit` and
`repositoryUrl` via `parseSourceOffer`, so a response cannot supply an `href` at all.

**No rate limiter, and that is a decision rather than an omission.** The handler reads
one environment variable and serialises a fixed-shape object: no database access, no
file I/O, no upstream call, no per-caller state. There is nothing behind it to protect
and nothing to enumerate — the one value it discloses is a commit sha in a public
repository, which §13 obliges us to disclose. A limiter would add a failure mode to an
endpoint whose entire purpose is to answer, and `429` is not a lawful answer to a §13
request. Recorded here so a later security sweep reads it as a decision.

**Operators must set `METIS_SOURCE_COMMIT`**, and a fork must set
`METIS_SOURCE_REPOSITORY_URL` to its own repository — otherwise its users are pointed
at our source, which is not the source of the program they are using. Both are
documented in `NOTICE` and `CONTRIBUTING.md`.

### 6a — the repository ships the wiring, not just the reader

Review of the first cut of this change found the defect that matters most here: the
endpoint, the footer and the shared derivation were all correct, and **nothing in the
repository's own deploy artifacts set `METIS_SOURCE_COMMIT`**. It appeared in no
`.env.example`, no Dockerfile and no compose file, so every deployment built from this
tree answered "this deployment's exact commit is not identified" — the degraded offer,
on exactly the axis §13 cares about, and silently. Every test passed.

The two halves need different mechanisms, and confusing them is how this stays broken
while looking fixed:

- the **server** reads the variable at request time, so `Dockerfile.server` bakes it in
  as a runtime `ENV` (overridable at deploy) and `docker-compose.prod.yml` passes it
  through `environment:`;
- the **UI** has its value inlined by Next.js at `next build`, so `Dockerfile.ui` takes
  it as a build `ARG` and maps it to `NEXT_PUBLIC_METIS_SOURCE_COMMIT` *before* the
  build step. A runtime environment variable on the UI container is read too late and
  is ignored without complaint.

One compose detail is worth recording because it undoes the whole thing while looking
correct: in `docker-compose.prod.yml` the runtime entries are written
`METIS_SOURCE_COMMIT:` with **no value** — compose's pass-through form, which omits the
variable when the operator has not exported it. The natural-looking
`METIS_SOURCE_COMMIT: ${METIS_SOURCE_COMMIT:-}` renders as `""` instead (verified with
`docker compose config`), and an empty runtime value *shadows* the `ENV` the image
baked in at build time. A correctly built image would then serve a degraded offer at
`up` time because of the very line meant to supply the commit. Build `args:` are
exempt: an empty value there is identical to the Dockerfile's own `ARG ...=""` default.

`server/tests/source-offer-deploy-wiring.test.ts` asserts all of it against the
constants exported by `@metis/shared` rather than against string literals, so renaming
`SOURCE_COMMIT_ENV_VARS` fails the suite and points at the deploy artifacts that have
to move with it. Both Dockerfiles also carry
`org.opencontainers.image.revision` / `.licenses` / `.source` labels, so `docker
inspect` can answer "which commit is this image" without unpacking it — which is what a
§13 request turns into for someone holding only an image.

## Decision 7 — every package stays `private: true`, reviewed one at a time

#1296 asked for `private` to be reviewed per package and explicitly forbade a blanket
change across ten manifests. The review was done and the answer happens to be the same
for all ten, but the *reasons* differ and are recorded per package in
`PUBLICATION_POLICY` in `scripts/lib/license-metadata-core.mjs`.

The common thread: nothing in this repository is distributed through npm. METIS is
distributed as source under AGPL-3.0 and as container images, and the licence obliges
no particular channel. An accidental `npm publish` is close to irreversible — npm
blocks unpublish after 72 hours — and for an AGPL project it would put a package under
our name on a registry whose consumers overwhelmingly expect permissive terms.

The gate that keeps this honest is written along the **identity** axis rather than the
value axis, which is the lesson from #1168's family of gates that passed because their
default meant "nothing to check". A manifest with no register entry fails
(`unreviewed`); a register entry with no manifest fails (`stale-policy`); a register
entry that records a decision without a reason fails (`unreasoned`). So the eleventh
package, six weeks from now, cannot arrive unreviewed.

## Dependency findings

`pnpm licenses list` over 1,129 production packages and 1,460 including development
dependencies:

- **No `GPL-2.0-only` dependency**, which would have been genuinely incompatible with
  AGPL-3.0. Verified, not assumed. No AGPL, SSPL or BSL dependency either.
- **`jszip`** is dual `(MIT OR GPL-3.0-or-later)`. **The MIT arm is elected**, recorded
  in `NOTICE`. Both arms are compatible with AGPL-3.0, so the election costs nothing,
  but an unrecorded election has to be re-derived by every reader.
- **`@img/sharp-libvips-*`** is LGPL-3.0-or-later and compatible; the dynamic-linking
  question a permissive outbound licence would have raised does not arise under a
  copyleft core.
- **`@github/copilot@1.0.60` is proprietary and is in the production tree.** It arrives
  transitively via `@github/copilot-sdk` (MIT), which `server/` and
  `server/copilot-svc/` declare. `pnpm licenses list` reports it as `Unknown` because
  its manifest says `SEE LICENSE IN LICENSE.md`. It does not conflict with AGPL-3.0 —
  its section 2 says in terms that it does not restrict our choice of licence — but it
  carries redistribution conditions that bind anyone shipping a METIS bundle with
  resolved `node_modules`. Recorded in `NOTICE`.

  This corrects a correction. An earlier audit called `@github/copilot` "Unknown" and
  the largest licence fact in the tree; the correction was that the real dependency is
  `@github/copilot-sdk`, which is MIT. Both are half right: the SDK is MIT and is what
  METIS imports, *and* it depends on a proprietary CLI that is in the production tree.
  `pnpm why @github/copilot` shows the edge.
- **`buffers@0.1.1`** declares no licence and ships no licence file, five levels down
  via `exceljs` → `unzipper` → `binary`. Not a conflict with AGPL-3.0 — an absence of
  a grant, pre-existing and not resolved by this change. Recorded in `NOTICE` so it is
  not mistaken for a cleared item.

## Consequences

- METIS can be published. It could not have been before: with no `LICENSE`, visitors
  had no rights at all.
- A hosted competitor must publish its modifications. Some enterprises will decline to
  adopt METIS. Both were chosen.
- Outside contributors face CLA friction and some will decline. The reasoning is stated
  up front so that declining happens before the work, not after.
- Deployments must set `METIS_SOURCE_COMMIT`, and forks must set
  `METIS_SOURCE_REPOSITORY_URL`, to discharge §13 fully.
- `pnpm lint` grows two pre-ESLint gates, taking it to four. A new package now
  requires a `PUBLICATION_POLICY` entry with a reason, and the CLA workflow may not
  reintroduce the `remote-*` inputs, or lint fails.
- Still open, deliberately: `SECURITY.md` (needs a monitored disclosure address),
  the support-expectation commitment, the `README` rewrite, `CODE_OF_CONDUCT.md`, and
  what ships from `docs/` — all on #1302. The perpetuity commitment (4c) is the
  owner's to make or decline.
