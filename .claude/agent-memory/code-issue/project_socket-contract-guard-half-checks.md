# The socket-contract guard only catches a wholly unused event

`packages/shared/src/socket-contract.ts` fails when a declared event is
*neither* emitted nor consumed. An event that IS emitted but whose UI listener
name is misspelled passes CI — one side using the declaration satisfies it.

Consequence: the `docs/ARCHITECTURE.md` §7.6.4 realtime event catalogue the
guard is supposed to protect drifts silently. After #83 it had no row for
`drift:detected` and still listed `requirement:drift` as removed.

Reviewing a new socket event here means checking the §7.6.4 row by hand and
confirming a unit test pins the consumer's literal event name. Filed as #91.

Related: `reconcileIssueChange` accepted an `emitDrift` dep that no caller ever
supplied — its test injected the dep itself, so a dead emit path stayed green.
An optional dep with a test that supplies it proves nothing about wiring.

Update (#110/#113, 2026-09-23): #110 added the reverse check (emitted/listened
names against the declared list), but the review showed a typo still passes when
the **correct spelling also appears** elsewhere. To prove such a guard can fail,
add a misspelled COPY next to a correct occurrence — misspelling the only
occurrence does not test it.
