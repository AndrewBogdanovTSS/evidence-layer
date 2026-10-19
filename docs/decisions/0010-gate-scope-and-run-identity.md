---
id: DEC-0010
status: proposed
date: 2026-10-19
supersedes: null
invariants: []
review_by: null
enforce_owner: Andrii Bohdanov
---

# DEC-0010: what a stop checks, which runs a claim may cite, and what a fence label means

Draft. Nothing here is implemented. It records the changes an independent
review of the runtime gate and the gather path (at 159d5cc, 2026-10-19)
proposed that alter the gate's semantics rather than fix a bug - C1, C3, C4
and C5 in that review - so the choice is made once, on purpose. The review's
bug fixes ship in 0.10.0 without waiting for this record.

## Context

The rule this package is graded against is that the honest path must be
cheaper than the convenient one. The review's point is that the gate keeps the
rule for the first citation - the skeleton turns citing into leaving a block in
place - and inverts it after the first edit:

| Moment in a session | What the honest path costs | The silent alternative |
| --- | --- | --- |
| After any code edit | Re-run every gather step, re-copy every block and id - ids change even when nothing changed (F3) | Restate in prose, or drop the claim lines |
| After committing | The same re-run: the evidence reads as collected at the wrong commit, though its content is identical (F4) | The same |
| A later, unrelated turn | Refresh the old review, or take two blocks and then a warning (F1, F2) | Delete the review |

Four findings come from the design, and from OQ-01 and OQ-05 in
`docs/plans/runtime-gate-decisions.md`:

- **F1 - a review that passed earlier blocks later, unrelated turns.** A stop
  re-checks every review whose bytes differ from the session-start snapshot,
  freshness included. A clean review, then an unrelated code edit and a reply
  with no claim: the stop is blocked twice for something the agent did not
  report this turn.
- **F3 - re-gathering mints new ids even when nothing changed.** An id hashes
  the full output, and test output carries timings. Gathering again is the
  honest answer to `seal/stale`, and it turns every citation in the review into
  `seal/not-gathered` - although the previous run is still on disk and saw the
  same files. (OQ-01: "the run `current.json` names, and nothing else".)
- **F4 - gathering before committing fails, while the seal says the code is
  unchanged.** Gather on an uncommitted edit, commit exactly that content, cite
  it under a receipt for the new commit: `claims/wrong-commit` (the fence says
  the old head) next to `seal/fresh` (the content is identical) in one report.
- **F5, in part - every way out is free.** 0.10.0 journals an episode that ends
  with nothing left to check (`closed-unchecked`); what to do about success
  claims written as prose is C7's question, not this record's.

What 0.10.0 already changed, so the options below start from it: an exhausted
episode speaks once while its inputs and findings stay the same; a stop with
nothing to check closes an open episode, journalled as `closed-unchecked`;
`seal/not-gathered` names the kept run an id came from and the current id for
the same command.

## Options

### C1 - check what changed since the last check, not since the session started (F1)

The session file records each review's hash at its last check (`checked`), the
reviews whose last check had errors (`pending`), and the tree at which a
review's staleness was last reported (`staleNotified`). A stop splits today's
"changed since session start" into:

- **due**: reviews changed since their last check, plus every pending review -
  the full check and blocking, as today. Keeping pending reviews due means a
  block cannot be escaped by leaving the review untouched.
- **earlier**: reviews written this session, clean at their last check and
  untouched since - only the seal's freshness for the ids they cite.

A stale earlier review is handled by a policy, `staleReview`: `notify` (a
`systemMessage` once per source tree, journalled as a new outcome
`stale-notice`), `block-once` (one block naming the review, the changed paths
and the refresh command, then notify), or `block` (today, implied by
`--strict`). Default `notify` until C4 ships, `block-once` after it.

Gain: an unrelated turn is no longer blocked over an old review - the noise
most likely to get the gate switched off. Cost: under `notify`, a stale review
can stay in the tree and be committed stale, and CI has no seal to catch it;
the agent never sees a `systemMessage`, so it learns nothing until it touches
the review (a per-turn context hook would carry the notice); three policies
and three session fields.

### C3 - accept a citation from any kept run that saw the current files (F3)

`readRuns()` reads every kept run, each validated as `readCurrentRun`
validates the current one. A cited id is accepted from the current run as
today; from an earlier run whose source equals the current fingerprint
(`sameSource`) as a pass under a new code `seal/earlier-run`, naming the run;
from an earlier run with a different source as `seal/stale`, naming the paths;
from no kept run as `seal/not-gathered`. Freshness is judged against the run
the block came from. Two same-source runs whose artifacts for one command
disagree (exit code, stop reason, work summary) give `seal/disagreeing-runs`
at level `flaky`. The gate's final-message lookup searches every same-source
run's bundle.

Gain: re-gathering "to be safe" stops breaking citations when the code did not
change, and two sessions in one checkout stop invalidating each other. Cost:
gives up OQ-01's single authoritative run; an agent can cite an older green run
while a newer run of the same command is red - `flaky` blocks only under
`--strict`, and making it an error blocks genuinely flaky suites; a citation
expires after `RUNS_KEPT` (5) newer gathers.

### C4 - `evidence-layer restamp <review.md>` (F3 when the code did change)

Gather records each artifact's step on the seal. `restamp` finds, for each
cited block, the kept run and step that produced it and the current run's
artifact for the same step (falling back to the same command), replaces the
block byte for byte from the current bundle, and rewrites `VERIFIED[<old id>`
to the new id in grade tags only - never in prose or inside fences. It never
rewrites a claim sentence, and it runs `claims --seal` on its own output, so a
predicate the new run no longer meets stays an error. `--dry-run` writes
nothing.

Gain: the honest fix after a code change becomes "gather, then one command".
It cannot fabricate evidence - every block it writes comes from a sealed run.
Cost: a command that rewrites the author's file; a claim without predicates
moved onto a different passing block is not caught; steps whose command embeds
a changed file list, or that were renamed, are left unmatched.

### C5 - content as the identity of evidence (F4)

`restamp --to-head`: when HEAD differs from the run's head, compute HEAD's tree
minus the run's exclusions through a throwaway index. If it equals the run's
source tree and coverage is complete, publish a relabelled run - the same
bundle with each fence's `@<old head>` rewritten to `@<HEAD>`, block hashes
recomputed, `relabelledFrom` recorded - and rewrite the review's fences the
same way. When the trees differ, refuse and name the paths.

The ids are kept. Nothing recomputes an id but `gather`, so
`claims/wrong-commit` passes on the new label and every tag stays as written.
The alternative - hashing the output alone into the id - changes every future
id and rewrites every tag, and is not proposed. `claims/wrong-commit` itself
does not become content-aware: without a seal, in CI, it cannot, and a review
would pass locally and fail there. Session start compares the current
fingerprint with the run's source, under a time budget, instead of comparing
commits.

Gain: gather, then commit, no longer forces a full re-run. Cost: a relabelled
block's id no longer equals `artifactId(command, label, output)` - the
documented property narrows to "deterministic at the commit it was gathered
on"; one more way for a run to come into existence.

## Proposed outcome

To be decided by the maintainer. The review's order, which this draft adopts:
**C3, then C4, then C5, then C1**, under this one record - C1 defaulting to
`block-once`, because by then C4 has made the fix one command. C3 and C4 share
`readRuns`; C5 shares C4's review rewriting.

Two smaller points for the same decision:

- **Who tags the journal.** 0.10.0 keeps entry ids out of every reason the
  agent reads, so an agent is never handed `journal tag <id> false` for the
  block that stopped it. An agent with a shell can still run `journal report`
  and tag. The review's further step - `journal tag` refuses to run without a
  terminal unless `--yes` is given, and records who tagged - stops casual use
  and also scripted tagging.
- **A silent repeat in the journal.** 0.10.0 journals nothing when an exhausted
  episode stays silent. The review proposed a journal entry with
  `gate.repeatOf: <entry id>`, counted apart from degraded allows, so the
  journal shows how long a failing review was carried.

## Invariants (once accepted)

To be written with the decision. Candidates, each enforced by `pnpm test`:

- A review blocks only when it changed since its last check or is still
  failing; staleness of an untouched review is reported rather than blocked
  unless the policy says otherwise.
- A cited block is accepted only from a kept run whose source fingerprint
  equals the current one.
- `restamp` writes only blocks copied from a sealed run, and never a claim
  sentence.
- A run is relabelled only when HEAD's tree, minus the run's exclusions,
  equals the run's source and its coverage is complete.
