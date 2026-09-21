# Contributing to METIS

Thank you for considering it. This document covers three things: the licence you would
be contributing under, the Contributor Licence Agreement and why it exists, and how to
build and test the project.

**Read the CLA section before you write any code.** It asks something of you that some
people reasonably decline, and finding that out after doing the work is the worse
order.

---

## The licence

METIS is free software under the **GNU Affero General Public License v3.0 only**
(`AGPL-3.0-only`). The full text is in [LICENSE](LICENSE); the copyright holder is
Zylos Labs LLC, recorded in [NOTICE](NOTICE).

`-only`, not `-or-later`: METIS is offered under version 3 of the AGPL and no other.
`-or-later` would let a future version published by the Free Software Foundation govern
these terms, and that choice belongs to the copyright holder rather than being
delegated in advance.

### What AGPL-3.0 means if you deploy METIS

This is the part most worth reading before you build anything on top of METIS, because
discovering it afterwards is expensive.

AGPL-3.0 is the GPL plus **§13, the network clause**. Ordinary GPL obligations are
triggered by *distributing* software. §13 adds a second trigger: if you **modify**
METIS and let people **use it over a network** — an internal deployment counts, a
hosted product certainly counts — then you must offer those users the complete source
of the version they are talking to. Not the source you started from. Yours, including
your modifications, under AGPL-3.0.

In practice:

- **Running METIS unmodified?** Nothing to do. §13's obligation attaches to modified
  versions.
- **Running a modified METIS internally, or for customers?** You owe your users that
  version's source. See below for the affordance this repository already ships to
  discharge that.
- **Building a separate product that talks to METIS over an API?** That is normally
  not a derivative work, and normally carries no obligation. "Normally" is doing real
  work in that sentence; if it matters commercially, ask a lawyer rather than a README.

Some organisations maintain AGPL ban lists and will not adopt METIS on those grounds.
That is a real cost of this licence and it was accepted knowingly, not overlooked.

### The §13 source offer, and what you must do if you fork

METIS ships the affordance §13 asks for, so a deployment is compliant by default rather
than by remembering:

- `GET /source` and `GET /api/source` on the API server return an unauthenticated JSON
  document naming the licence, the repository and the exact commit the running process
  was built from.
- A footer on every page of the web application — including the sign-in page, so it
  reaches users who have not logged in — links to the source of the running
  deployment.

Both read the commit from `METIS_SOURCE_COMMIT` (falling back to `GIT_COMMIT`, then
`SOURCE_COMMIT`). **Set `METIS_SOURCE_COMMIT` at build or deploy time.** Without it the
offer still names the repository but cannot name your commit, which is a weaker offer
than §13 asks for.

The images and compose files in this repository are already wired for it, and the two
halves want it at different times:

```bash
export METIS_SOURCE_COMMIT=$(git rev-parse HEAD)
docker compose build            # the UI needs it HERE — Next.js inlines
                                # NEXT_PUBLIC_* at `next build`
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The server reads the variable on every request, so setting it at run time is enough for
`/source`; `Dockerfile.server` also bakes the build-time value in as a default, so an
image run with no `-e` flag still answers correctly. The **UI footer is different**: its
copy is compiled into the bundle, so a value supplied only at run time is read too late
and is ignored without any error. If the footer says "this deployment's exact commit is
not identified" while `/source` names a commit, that is the mismatch you are looking at.

**If you deploy a modified METIS, set `METIS_SOURCE_REPOSITORY_URL` to your own
repository.** Otherwise your users are pointed at our source, which is not the source
of the program they are using — and that is the obligation unmet.

---

## Why there is a CLA

Every contributor is asked to sign the [Individual CLA](CLA.md). Here is the actual
reason, stated as plainly as we can manage:

**So that Zylos Labs LLC can change METIS's licence in the future without having to
find and ask every person who ever contributed to it.**

That is the whole purpose. It is worth being precise about what it is *not*:

- It is **not** to feed a paid edition. There is no paid edition and no plan for one;
  the open-core proposal that once motivated a CLA here was closed as superseded.
- It is **not** copyright assignment. You keep the copyright in your work, and you may
  use, sell or relicense your own contribution anywhere else you like.

### Why a CLA rather than a DCO

A Developer Certificate of Origin certifies that you *had the right to submit* your
work. It grants the project no right to redistribute that work under different terms.
It is the right instrument for a project that has settled its licence permanently.
METIS has not settled its licence permanently, and pretending otherwise by shipping a
DCO would foreclose the option silently instead of asking for it openly.

Without a CLA, relicensing METIS later would require every past contributor to agree,
individually. People change employers, lose interest, become unreachable, or simply
say no. In practice that means the first outside contribution closes the option
permanently.

### The honest cost

Some contributors decline to sign CLAs on principle, and under a full-open-source
project with no paid tier the honest answer to "what is it for?" is "so the owner can
change the licence later" — which some people will read as "so the owner can close
this later". We are not going to phrase that away.

Two things are true alongside it, and both are checkable rather than promises:

- **You keep your copyright.** The CLA grants a licence; it does not transfer
  ownership.
- **Anything already released stays released on the terms it was released under.**
  This is not a commitment added here — it follows from AGPL-3.0 §2, under which the
  rights someone has already received "are irrevocable provided the stated conditions
  are met". A future relicence would change the terms of *future* distribution. It
  cannot withdraw a licence someone already holds, and it cannot un-publish a tag.

If that is not enough for you, decline. Say so on your pull request; it will be closed
without an argument and without anyone being difficult about it.

### How to sign

Open a pull request. A bot comments on it with a link to [CLA.md](CLA.md) and asks you
to reply on the pull request with:

> I have read the CLA Document and I hereby sign the CLA

Your signature is recorded once and recognised on every later pull request.

**If you are contributing as part of your employment**, your employer very likely also
needs to sign the [Corporate CLA](CLA-CORPORATE.md) — in most jurisdictions work
produced in the course of employment belongs to the employer, which means the rights
you would be granting are not yours to grant. Clause 5 of the Individual CLA is the
test.

---

## Building and testing

### Prerequisites

| Tool | Version |
|---|---|
| Node.js | `>= 22.12.0` (`.nvmrc` pins the major to 22) |
| pnpm | `>= 10.16.0` — enable with `corepack enable` |

### Install

```bash
pnpm install --frozen-lockfile --prod=false
```

`--prod=false` is not optional: the dev dependencies are what the gate runs on.

### The gate — run this before every push

```bash
pnpm lint && pnpm typecheck && pnpm test
```

This is the same set CI runs, in the same order. Three notes that save real time:

- **Never use watch mode and never background a process.** `pnpm test` fans out to each
  package's `vitest run`, which exits on its own.
- **If `pnpm typecheck` reports a missing export from `@metis/shared`, the shared build
  is stale**, not the export missing. Run `pnpm --filter @metis/shared build` and try
  again. This misdiagnosis is common enough to be worth a line here.
- `pnpm lint` chains four repository gates ahead of ESLint — a NUL-byte check, a
  company-identifier check, the licence-metadata check described below, and the
  CLA-workflow check — so a lint failure is not always an ESLint failure. Read the
  first error, not the last.

### Other useful commands

| Command | What it does |
|---|---|
| `pnpm dev` | Runs the API server and the web UI together |
| `pnpm build` | Builds every package |
| `pnpm licenses:verify` | Checks every `package.json` declares `AGPL-3.0-only` and has a reviewed publication decision |
| `pnpm cla:verify` | Checks the CLA workflow cannot be switched onto a path needing a personal access token |
| `pnpm changelog:verify` | Checks your branch added a valid changelog fragment |
| `pnpm --filter @metis/shared build` | Rebuilds the shared package (see the gotcha above) |

---

## What a pull request needs

- **Tests, and tests that can fail.** Write the test first, or at minimum break the
  implementation once and watch the test go red before you call it done. A test written
  after the fix, against the fixed code, very often passes against the unfixed code
  too, and nobody notices.
- **80% unit-test coverage on the code you touched.**
- **A changelog fragment**, if the change is user-facing: one file at
  `.changes/unreleased/<issue>-<slug>.md`. Never edit `CHANGELOG.md` directly — it is
  assembled from fragments at release, and a shared file would put every open pull
  request on the same conflicting line. `pnpm changelog:verify` checks this, and a
  fragment that does not parse counts as no fragment at all.
- **No version bumps.** Versions move only when a release is tagged.
- **A security pass over what you wrote** — the OWASP Top 10, applied to your diff. No
  SQL built by string concatenation, no user input reaching a shell, no secrets in
  code.
- **A licence field on any new `package.json`**, plus an entry in `PUBLICATION_POLICY`
  in `scripts/lib/license-metadata-core.mjs` recording whether that package publishes
  to npm and why. `pnpm licenses:verify` fails on a manifest nobody has reviewed —
  that is deliberate, and the fix is to make the decision rather than to silence the
  gate.

### Licence headers in source files

**There are none, and that is a decision, not an oversight.** AGPL-3.0 does not require
per-file headers; `LICENSE` plus `NOTICE` is sufficient to license the work. Adding
headers to 4,000-plus files would be a large mechanical diff that conflicts with
everything in flight and has to be maintained forever.

Please do not add them to files you touch, and please do not open an issue proposing
them — the reasoning is recorded in
[docs/decisions/0014-agpl-3-0-licensing-cla-and-the-section-13-source-offer.md](docs/decisions/0014-agpl-3-0-licensing-cla-and-the-section-13-source-offer.md)
so it does not get relitigated each quarter.

---

## Reporting a security issue

Please do not open a public issue for a security vulnerability — that discloses it to
everyone, including people who would use it, before there is a fix.

[`SECURITY.md`](SECURITY.md) has the full policy. In short: use the **Report a
vulnerability** button on the [Security
tab](https://github.com/openzigs/metis/security), or email `openzigs@gmail.com` if you
would rather. You can expect an acknowledgement within 5 business days.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Conduct concerns go
to the same address, `openzigs@gmail.com`.
