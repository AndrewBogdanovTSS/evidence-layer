---
id: DEC-0002
status: accepted
date: 2026-09-06
supersedes: null
invariants:
  - Every VERIFIED[id] claim addresses a real artifact collected at the commit the review is about; enforced by `pnpm check:claims`.
  - A review citing a file backs it with that file's own verbatim first line, not any file's; enforced by `pnpm check:receipt`.
  - A check's own findings and any bug that got past a clean review accumulate in journal.jsonl from the day this record was ratified, not before; enforced by `pnpm check:all`.
  - An expired governance exception is a finding on every run, printed even at zero; enforced by `pnpm check:all`.
  - A fingerprint mismatch is never classified as flaky, regardless of the journal's flaky policy; enforced by `pnpm fingerprint`.
review_by: 2027-09-06
enforce_owner: Andrii Bohdanov
bare_verified_deprecation: 2026-12-06
---

# DEC-0002: the honest path has to be cheaper than the convenient one

## Context

[DEC-0001](0001-evidence-layer.md) built six checks and left one property
unnamed: two of its own design choices - gathering evidence before generation
starts, and requiring the receipt above the verdict - already worked because
they made the honest answer cheaper to produce than a guess, not because they
made lying harder to get away with. An external review of the shipped layer
(`docs/phase0-audit.md` reconciles it against the code) named that property and
used it as the single criterion the six improvements below are graded against:

> The honest path must be cheaper than the convenient one - measured in tokens,
> in separate decisions, and in distance from the trajectory the author is
> already on, because a model has no reward at inference time to make "cheaper"
> a motivational metaphor rather than a literal one.

Measured on the shipped fixtures before this record: the honest version of a
grounded review (`demo/reviews/good-claims.md`) cost **2.16x** the characters
of the unbacked one (`demo/reviews/bad-claims.md`) in the section that matters.
That number is this record's baseline, not a rhetorical one.

## Decision

Six changes, in the order they were built because three of them depend on the
ones before them:

1. **Addressable artifacts.** `VERIFIED` alone only proved a block was nearby;
   `VERIFIED[id]` proves a claim points at a specific, real, commit-matched
   run. Shipped with a **mandatory** skeleton generator
   (`pnpm evidence` writes ids already substituted into `evidence.local.md`),
   because addressing without one would make citing evidence more expensive
   than a bare tag - the one change this record refuses to ship without its
   cost-reducing half. Bare `VERIFIED` remains valid with a deprecation warning
   until **2026-12-06** (`bare_verified_deprecation` above), after which it is
   an error.
2. **A fourth outcome, `flaky`.** A check that flips from pass to fail at a
   commit it already passed is not the same claim as a regression, and
   collapsing the two into one `error` teaches people to reach for
   `--no-verify` the first time noise looks like signal. Escalates back to a
   real error after three flags, so leniency has a counter, not just a name.
   `pnpm fingerprint` explicitly never uses it: an engine-determinism mismatch
   is a more serious finding than an ordinary failure, not a lesser one.
3. **The findings-and-misses journal** (`journal.jsonl`, committed, one schema
   for both ends). Started now, on the day this record lands, because none of
   it can be reconstructed retroactively - the whole reason it is Phase 0's
   first output rather its last.
4. **Per-file sample quotes.** A single "files opened" quote proved a file was
   opened, not the files the review's own claims were about; the cheapest file
   in a thirty-file diff satisfied it. Now one quote is required per file a
   citation actually names.
5. **Governance exceptions**, required before `--enforce` means anything: an
   exception with no expiry is invalid, and an expired one is a finding on
   every run - printed even at zero, so a considered exception and a forgotten
   one cannot look the same from the outside.
6. **Extraction to `packages/evidence-layer`**, mirroring `packages/tetris-core`.
   Requested directly rather than deferred to last, on the reasoning that
   building the other five changes *inside* the new package from the start
   costs less than building them once and moving them later.

## What stayed a deferred decision, not a step

Whether six checks are more than this project needs is a real question and,
today, an unanswerable one: the layer is a week old, and answering from
demo-fixture behaviour alone would be exactly the kind of guess `check:claims`
tags UNVERIFIED. It is deferred with a trigger, not indefinitely: at **30 runs
recorded against real changes** (`journal.jsonl`, excluding fixtures), review
`pnpm journal:report`'s per-check real/false/untagged split. **Andrii
Bohdanov** owns that call, named now rather than when the threshold arrives
and nobody is holding it.

## Consequences

- A copied-in-the-wrong-place artifact block, which passed proximity checking
  before this record, now fails addressed checking - see
  `demo/reviews/mismatched-artifact.md`, `phantom-artifact.md`,
  `shotgun-artifact.md`.
- `check:claims` and `check:receipt` cost more to satisfy honestly only when
  the reviewer skips the tool that makes them cheap. Run through
  `pnpm evidence`'s skeleton, addressing and per-file quoting are copy-paste,
  not lookup.
- The layer's own usefulness claim now has a clock (`journal.jsonl`) where it
  previously had none - the same gap `check:docs` closed for the README's test
  count, one level up.
- Acceptance test for this record and everything under it, unchanged from the
  roadmap that proposed it: the honest path takes no more characters and no
  more separate decisions than the convenient one, and the gap between a
  model's `high` and `max` effort on these checks should shrink, not stay
  constant - a rule that still needs generous effort to satisfy is a rule
  whose overhead was never actually removed.
