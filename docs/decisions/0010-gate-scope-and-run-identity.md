---
id: DEC-0010
status: proposed
date: 2026-10-19
supersedes: null
invariants: []
review_by: null
enforce_owner: Andrii Bohdanov
---

# DEC-0010: what a stop checks, and which runs a claim may cite

Draft. Nothing here is implemented; it records three findings of the
independent review of 0.8.0's runtime gate, gather and seal path that change
the design rather than fix a bug, so the choice is made once, on purpose,
before any code moves. The bug fixes from the same review ship in 0.10.0
without waiting for this record.

## Context

The review found twelve issues in the path Canvas does not use yet: the gate
(`src/core/gate.ts`), the gatherer (`src/core/gather.ts`) and the seal
(`src/core/seal.ts`). Seven are bugs with a fix that keeps today's model. Three
question the model itself:

1. **Scope is the session, not the turn.** A stop checks every review whose
   bytes moved since the session started. Once a review is written, every later
   stop in that session checks it again - including stops in turns about
   something else - and an episode opened by an old review keeps the gate
   speaking about it. 0.10.0 stops the repeats (an exhausted episode with
   unchanged inputs says nothing) and closes an episode when a stop has
   nothing to check, but the scope is still the session.
2. **Only the current run counts.** A cited id must be in the run
   `current.json` names (OQ-01 in `docs/plans/runtime-gate-decisions.md`). A
   gather that adds a step, or re-runs one, gives every block a new id even
   when the source did not change, so a review written against the previous
   run fails `seal/not-gathered` although its evidence describes today's code
   exactly. 0.10.0 makes that finding name the kept run the block came from and
   the current id for the same command; it does not accept the old block.
3. **A run id is the identity, not the content.** `seal/not-gathered`,
   `seal/edited` and the bundle lookup for a final message all key on which run
   produced a block. Two runs over the same source, producing byte-identical
   output for a command, still carry different run ids, and the second one
   invalidates citations of the first.

All three come from OQ-01's answer - "the run `current.json` names, and nothing
else" - which was chosen because it needs no state machine and no lock. The
review's point is that the price of that simplicity is paid by the honest
author, which `AGENTS.md` says a feature must not do.

## Options

### Finding 1 - what a stop checks

- **A. Keep session scope** (today, plus 0.10.0's silence on unchanged input).
  Cheapest; the remaining cost is a re-check per stop of a review nobody is
  editing.
- **B. Turn scope.** Snapshot review hashes at each `UserPromptSubmit` and
  check only what moved since then. Needs a fourth hook event in both hosts'
  adapters and `init`, and a review written in turn 3 and cited unchanged in
  turn 7 is never re-checked against a newer run - a stale-evidence hole the
  session scope does not have.
- **C. Session scope, turn-scoped speech.** Check what moved since session
  start, as now, but block only on findings whose inputs changed this turn;
  findings carried over from an earlier turn ride along in a `systemMessage`.
  No new hook event if the gate keeps the last verdict's inputs per review,
  which 0.10.0 already stores for the whole stop.

### Finding 3 - which runs a claim may cite

- **A. Current run only** (today).
- **B. Any kept run whose source fingerprint equals today's.** A block from an
  older run is accepted when that run's `seal.source` is `sameSource` with the
  tree now; freshness is then judged against that run, not the current one.
  `RUNS_KEPT` (5) bounds the lookup. Adds a `restamp` command that rewrites a
  review's cited blocks to the current run's ids where the command and output
  are unchanged, for authors who want one run per review.
- **C. `restamp` alone.** Keep OQ-01, and make moving a review to the current
  run one command instead of a hand edit.

### Finding 4 - what identifies a block

- **A. Run id + short id** (today).
- **B. Content.** Identify a sealed artifact by `command` + `outputSha256` +
  source tree id. A citation is valid when some kept run sealed that exact
  triple; which run did so stops mattering. The short id in `VERIFIED[...]`
  stays an address into the document, not an identity.

## Proposed outcome

To be decided by the maintainer. The draft leans towards **1C, 3B with
`restamp`, and 4B**, because together they make "my evidence still describes
this code" the only question a citation has to answer, which is the question a
reader cares about. 3B and 4B are one change seen from two sides: 4B is the
rule, 3B is the lookup that implements it within `RUNS_KEPT`.

What would argue against it:

- 4B weakens OQ-01's "never pair one run's bundle with another's seal" only if
  the lookup reads a bundle from one run and a seal from another; the lookup
  must stay per run.
- A kept run can be deleted by the next gather (`RUNS_KEPT`), so 3B turns a
  valid citation into `seal/not-gathered` five gathers later. `restamp` is the
  answer to that, which is why 3B ships with it or not at all.
- 1C needs a per-review record of the last verdict's inputs; if that record is
  lost (session file corrupt), the gate must fall back to blocking, as today.

## Invariants (once accepted)

To be written with the decision. Candidates, each to be enforced by
`pnpm test`:

- A block whose command, output and source tree equal a kept run's sealed
  artifact is accepted, whichever run is current.
- A block no kept run sealed is `seal/not-gathered`, naming the current id for
  the same command when there is one.
- A stop blocks only on findings whose inputs changed since the previous
  verdict in the session.
