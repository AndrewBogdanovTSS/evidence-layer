---
id: DEC-0014
status: proposed
date: 2026-11-14
supersedes: null
invariants: []
review_by: null
decide_by: 2026-12-31
enforce_owner: Andrii Bohdanov
---

# DEC-0014: what the layer does about a result stated as prose

Draft. It records the one change in
[the roadmap](../plans/review-and-roadmap-2026-11.md) that reverses something
the README says on purpose - "prose outside a `**Claim**:` line is never
graded" - so that it is decided once, rather than arrived at one release at a
time. It is the "C7" that
[DEC-0010](0010-gate-scope-and-run-identity.md) deferred and nothing then
wrote down.

## Context

The layer checks what is written as a claim. A sentence is not one:

- In a session that changed code and never gathered, a final reply of "ran
  the full test suite and all 12 tests pass" is let through. Since 0.19.0 it
  is journalled, as `nothing-to-check`; before that it left no trace.
- A review file that says "All 71 tests pass and lint is clean" with no claim
  lines gets one warning, `claims/none`, and exits 0.
- At session start the gate tells the agent, in as many words, "Ordinary
  prose is not checked; only **Claim** lines are."

So the writer who volunteers a claim can be blocked, and the writer who says
the same thing as a sentence cannot. The rule this package is graded against
is that the honest path must be cheaper than the convenient one; here the
convenient path is the only one with no risk at all.

The limit exists for a reason. "This will be hard to maintain" is a review
comment, not a check, and a checker that grades taste gets switched off.
Whatever is done here has to leave that alone.

## What 0.20.0 does, without waiting for this record

Observation only. A sentence outside any claim that **names a kind of run and
reads as its outcome** - "all 12 tests pass", "lint is clean", "ran 71 tests"
- is `claims/unclaimed-result`:

- in a review file, a `warning` on its line, with the fix: state it as a
  claim;
- in a final reply, one finding on the stop's journal entry. Nothing is said
  to the agent and nothing is blocked.

It reuses the word lists the outcome rules already read (`kindsNamed`,
`readsAsSuccess`, the stated counts) and adds no judgement of its own. A
sentence that names no kind of run - "it works now", "much cleaner" - is not
one, and neither is one that asks, plans or instructs ("make sure the tests
pass", "the tests should pass once this lands").

It is English, and it is a pattern over prose: it will be wrong in both
directions. That is what the observation is for.

## Options

### O1 - keep observing

Leave it as 0.20.0 has it. Gain: no false block, ever. Cost: the free exit
stays open, and the journal says how often it is taken.

### O2 - tell the agent

A stop whose reply carries an unclaimed result gets a `systemMessage` with
the ready claims from the current run. Gain: nothing is blocked. Cost: the
agent does not see a `systemMessage` - DEC-0010 found the same about its
`notify` policy - so this informs the person and changes nothing the agent
does.

### O3 - block once per episode

The stop is blocked, inside the existing retry budget, with the ready claims
as the fix - a paste. `--strict` keeps blocking. Gain: the exit closes, at
the cost of one paste for a writer who had gathered. Cost: a false positive
is now a blocked stop over an ordinary sentence, which is the noise most
likely to get the gate switched off; and for a writer who had not gathered,
the fix is a gather, which after an edit is still expensive until DEC-0010's
C3 and C4 land.

### O4 - block only under `--strict`

O1 by default, O3 for whoever asked for the stricter trade.

## Proposed outcome

To be decided by the maintainer. The roadmap's order: **O1 now** (shipped),
then **O4**, then **O3** by default - and O3 only when both hold:

1. DEC-0010's C3 and C4 have shipped, so the honest fix after an edit is one
   command.
2. Thirty stops journalled with `claims/unclaimed-result` have been tagged by
   hand (`journal tag <id> real|false --gate`), and at most three are false.

Written down now, so the threshold is not chosen when the numbers are in.

## Invariants (once accepted)

Candidates, each enforced by `pnpm test`:

- A sentence that names no kind of run is never an unclaimed result.
- A question, a plan or an instruction is never an unclaimed result.
- A final reply's unclaimed result blocks a stop only under the policy this
  record sets, and never outside the retry budget.
