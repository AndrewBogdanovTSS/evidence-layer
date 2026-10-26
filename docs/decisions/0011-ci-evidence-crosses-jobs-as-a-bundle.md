---
id: DEC-0011
status: accepted
date: 2026-10-25
supersedes: null
invariants:
  - A block a review cites passes `claims --bundle` only when it is canonically the block the bundle carries under that id, and a bundle file that is not there is bad usage, exit 2; enforced by `pnpm test`.
  - A gather reports how every planned step ended, and the gather scripts in this repository and its example exit 1 when a step failed, after writing the bundle; enforced by `pnpm test`.
  - The action refuses `bundle` for an installed package that does not declare `claimsAgainst` `bundle`, rather than passing a review nothing held to the bundle; enforced by `pnpm test`.
review_by: 2027-10-25
enforce_owner: Andrii Bohdanov
---

# DEC-0011: CI's evidence crosses jobs as a bundle file

## Context

DEC-0005 and DEC-0007 both rest on CI being the independent party: it gathers
its own evidence, so a review is held to runs its author did not make. Nothing
made that possible in a workflow where the review is written after the gather,
in another job - the layout a model review in CI needs, and the cheapest one,
since the model then reads what ran instead of running it:

- **The seal holds in one checkout.** It lives in `.git/evidence-layer`, with a
  fingerprint and exclusions that describe that working directory. A job on
  another runner has none, and `claims --seal` there is `seal/no-run` -
  `unverifiable`, which a workflow reads as not failing.
- **`claims` alone cannot tell a gathered block from a typed one.** An id
  hashes the command, the commit and the full output; the block shows the
  output trimmed from the middle, so the id cannot be recomputed from it. A
  well-formed block under an invented id passes.
- **The gather could not be the test run.** It wrote a failing step's block
  and exited 0, and returned nothing a caller could read the outcome from. A
  workflow that gathered had to run the suite a second time to fail the job.

## Decision

1. `gatherEvidence` returns `steps`, each planned step's exit code and stop
   reason or the reason it was skipped, and `stepFailed` reads one. A failing
   step still gets its block. `pnpm evidence` and the example's
   `scripts/evidence.mjs` exit 1 when a step failed, after writing the bundle.
2. `claims --bundle <file>` holds every cited block to a bundle file: the id
   must be one the bundle carries, and the block canonically identical to it
   (`bundle/not-gathered`, `bundle/edited`, `bundle/provenance`; a file that is
   not a bundle is `bundle/broken`). The commit under review falls back to the
   bundle's `- Head:` line after `--sha` and the receipt.
3. The action takes `bundle` and `sha` inputs, and refuses `bundle` for an
   installed package whose `evidenceLayer.claimsAgainst` does not list it - the
   rule it already follows for `outputFormats`.
4. The example's workflow is laid out as gather, then review, then the review
   held to the bundle the gather job uploaded; this repository's CI runs that
   handoff across two runners.

## Why not

- **Carry the seal between jobs.** Its fingerprint is of one working directory,
  and it sits in a hidden directory `actions/upload-artifact` leaves out unless
  told otherwise - so the likeliest failure is a seal that silently did not
  arrive, which reads as `unverifiable`. A missing bundle is bad usage instead.
- **Make ids recomputable** by printing whole outputs. The bundle exists to be
  read by a model; a test run's full output is the token cost the trimming
  avoids, and every released id would change.
- **A gather step in the action.** Still DEC-0007's answer: what to run is the
  project's own script.
- **Run the steps in parallel inside `gatherEvidence`.** The gather
  fingerprints the source between steps so it can name the step that wrote
  into the files it was checking; concurrent steps would lose that, and steps
  sharing one working tree can race. Parallelism belongs to the workflow - the
  jobs that are not evidence run beside the gather.

## Consequences

- A bundle is as trustworthy as where it came from. Downloaded from the gather
  job's artifact in the same workflow run, it is CI's; committed beside the
  review, it is the author's, and `--bundle` then checks nothing the author
  could not have written. The bundle carries no source fingerprint, so
  freshness is `--sha`'s job, not this check's.
- Required status checks are a repository setting no file can make; the
  example's README says which jobs to require, and `governance` still only
  reads that a workflow runs a command.
- The example's invariant now names `npm run evidence`, the command that runs
  the suite in its CI; npm's `npm test` shorthand stays covered by
  `test/governance.test.ts`.
