---
id: DEC-0003
status: accepted
date: 2026-09-14
supersedes: null
invariants:
  - Nothing under `src/core/` imports anything but Node builtins and its own siblings, so no project's stack can leak into the portable layer; enforced by `pnpm test`.
  - The version the CLI prints is substituted from package.json at build time rather than written down a second time; enforced by `pnpm test`.
  - The published tarball carries `dist/`, the README and the licence and nothing else - no source, no tests, no fixtures; enforced by `pnpm test`.
  - Every claim this README makes about the package is checked against the package it describes; enforced by `pnpm check:docs`.
  - The package manifest and its type resolution are validated on every build, not discovered by the first person to install it; enforced by `pnpm build`.
review_by: 2027-09-14
enforce_owner: Andrii Bohdanov
---

# DEC-0003: the checks leave the project they were written for

## Context

[DEC-0001](archive/0001-evidence-layer.md) built six checks inside a Tetris
game and argued, in its own README, that none of the checking logic had
anything to do with a Tetris game. [DEC-0002](archive/0002-evidence-layer-v2.md)
added addressing, a journal and a cost baseline, and shipped a portability
fixture - `examples/plain-node-project`, a plain-JavaScript project with no
TypeScript, no framework and no workspace - specifically so the claim "this
works on any project" would have something that could prove it wrong.

That claim was still only half-checked. The fixture proved the *functions*
were portable when imported from TypeScript source by a test runner living in
the same repository. It did not prove the *package* was: a consumer like the
fixture - plain JavaScript, no TypeScript toolchain - could not have run any
of it, because the entrypoints were `.ts` files that required `tsx` to be
installed alongside them, and the only documented way to invoke a check was a
path into another project's `node_modules`.

The gap between "the logic is portable" and "the thing you install is
portable" is the same gap DEC-0001 opened with: a claim that is true when
written, trusted forever, and never given a clock.

## Decision

Extract the package into its own repository, publish it to npm as
`evidence-layer`, and close the gap with the four changes that follow from
actually shipping it:

1. **Compiled output, not TypeScript source.** The package builds to ESM with
   generated types. The fixture the portability claim rests on is plain
   JavaScript; shipping `.ts` entrypoints made that exact consumer the one
   consumer who could not use the package. `tsx` moves from something every
   consumer needed to something only this repository's own scripts use.

2. **One executable, not five.** `evidence-layer <command>` replaces five
   separate bin files. Five bins would have squatted five generic names
   (`check-claims`, `ci-summary`, `journal-report`) in every consuming
   project's `node_modules/.bin`, and none of those names says who is making
   the claim. The colon-separated script names the checks had inside the
   origin project are kept as aliases, because a migration that breaks every
   consumer's `package.json` on the same day it changes their install path
   makes the honest upgrade more expensive than pinning the old copy forever.

3. **The boundary becomes a test.** An ESLint rule at the origin workspace's
   root banned framework imports inside `src/core/`. That rule did not survive
   the move, and the property it enforced is the whole reason to install this
   rather than copy five scripts. It is restated in `test/boundary.test.ts` as
   a structural rule - builtins and siblings, nothing else - which is stronger
   than the list of one project's dependencies it replaces, and which fails in
   the same run as everything else rather than needing its own toolchain.

4. **The manifest is a claim, so it is checked.** `publint` and
   `arethetypeswrong` run on every build, not at publish time. An `exports`
   map that resolves for the author and not for the consumer is an unbacked
   claim about the package's own shape, and the person who would otherwise
   discover it is whoever installs it first.

## What stayed a deferred decision, not a step

**Whether the journal's threshold survives the move.** DEC-0002 deferred the
question of tightening `VERIFIED` to 30 recorded runs against real changes.
Those runs accumulated in the origin project's `journal.jsonl`, which does not
come with the package - a journal belongs to whichever repository is running
the checks. The threshold is not reset to zero out of convenience and it is
not carried over out of sentiment: the count that matters is this repository's
own, and the trigger stands unchanged at 30 runs here. **Andrii Bohdanov**
owns that call, as in DEC-0002.

**Whether `readInvariants` should skip superseded records.** Archiving
DEC-0001 and DEC-0002 into `docs/decisions/archive/` solves the immediate
problem - their invariants name the origin project's commands - with a
directory move rather than a code change. Teaching the scanner to read a
`status:` field would change behaviour for every consumer to fix one
repository's filing problem, which is the wrong order.

## Consequences

- A consumer installs one package and gets one command. The five wrapper
  scripts a project used to copy become five lines in `package.json`, or none
  at all if they call `npx evidence-layer` directly.
- This repository is now its own first consumer, and its own hardest test: the
  checks run against the repository that contains them, so a check that only
  worked because of something the origin project happened to have would fail
  here rather than in someone else's CI.
- The portability fixture stops being a test fixture only. It is the worked
  example a reader can clone and run the whole layer against, which is the
  cheapest possible way to find out whether any of this survives contact with
  a project nobody involved has seen.
- Anything this package cannot check about itself - that the published tarball
  on the registry is the one this repository built - moves to npm's provenance
  attestation rather than being asserted in a README. Signed by the workflow
  that built it, or not claimed at all.
