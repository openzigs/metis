# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.** A public issue
discloses the problem to everyone — including people who would use it — before there is
a fix.

Two private routes, either is fine:

1. **GitHub private vulnerability reporting (preferred).** Use the **Report a
   vulnerability** button on this repository's [Security
   tab](https://github.com/openzigs/metis/security). The report becomes a private draft
   advisory visible only to you and the maintainers, and you can optionally open a
   temporary private fork to work on a fix with us before anything is public.
2. **Email `openzigs@gmail.com`** — for reporters without a GitHub account, or if you
   would simply rather use mail.

### What helps

Include whatever you have; none of it is mandatory.

- What the issue is, and what an attacker could achieve with it
- The version, commit, or deployment you found it on — the running commit is available
  at the `/source` endpoint of any METIS deployment
- Steps to reproduce, or a proof of concept
- Any suggested fix, if you have one in mind

### What to expect

- **Acknowledgement within 5 business days.** If you have not heard anything by then,
  assume the message went astray and send it again — silence is a failure on our side,
  not a decision.
- An assessment of whether we agree it is a vulnerability, and if so a rough severity.
- Progress updates while we work on a fix, rather than silence until it ships.
- Credit in the advisory when the fix is published, unless you would prefer not to be
  named.

We ask for a reasonable period to ship a fix before public disclosure. The customary 90
days is a fine default; if the issue is being actively exploited, tell us and we will
treat it accordingly.

## Supported versions

METIS is **pre-1.0** and has published no tagged releases. There are no version branches
and no backports: security fixes land on `main`, and the only supported version is the
current `main`.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Anything else | No — there is nothing else yet |

This table will change when the project cuts its first tagged release. Until then,
running METIS means running a commit from `main`, and updating means moving to a newer
one.

## Scope

In scope: anything in this repository — the server, the web UI, the shared packages, the
sidecars, the container images, the Helm chart, and the CI workflows.

Out of scope, because they are not ours to fix:

- Vulnerabilities in third-party dependencies with no METIS-specific exploit path.
  Report those upstream; if METIS is affected in a way the upstream advisory does not
  cover, we do want to hear about it.
- Findings against a deployment you do not operate or have permission to test.
- Reports from automated scanners with no demonstrated impact.

## A note on self-hosted deployments

METIS is self-hosted. If you run it, its security posture is partly yours: the secrets
you supply, the network you place it on, and the identity provider you wire it to are
outside our control. We will tell you about defaults that are unsafe, and we would like
to hear about them if you find one.
