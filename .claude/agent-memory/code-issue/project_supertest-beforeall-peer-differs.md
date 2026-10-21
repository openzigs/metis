---
name: supertest-beforeall-peer-differs
description: A supertest request from beforeAll leaves from 127.0.0.1 but one from a test from ::1, so a peer-keyed rate-limit spend in beforeAll never counts; spend in beforeEach or the test
metadata:
  type: project
---

`server/tests/setup.ts` installs `isolateSupertestLoopback` (a spy rewriting
supertest's `127.0.0.1` to `[::1]`) in a `beforeEach`, and `vi.restoreAllMocks()`
drops it after every test. A `beforeAll` that runs after an earlier test in the file
therefore has no spy: its request reaches the app from `127.0.0.1` (IPv4), while
the test's own requests come from `::1` (IPv6). Any limiter keyed on the TCP peer
counts them in different buckets.

**Measured on #1117:** a test that spent the peer bucket in `beforeAll` failed
every first attempt (200 where 401 was expected) and passed on vitest's retry,
because the failed attempt's own requests had spent the `::1` bucket. The
adversarial panel's test-falsifiability voter found it with `--retry=0`.

**How to apply:** spend a peer-keyed budget in `beforeEach` or inside the test,
never in `beforeAll`, and run every new suite once with `--retry=0` (#964).
