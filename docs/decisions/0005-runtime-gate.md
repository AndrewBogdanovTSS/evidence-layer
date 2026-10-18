---
id: DEC-0005
status: accepted
date: 2026-10-18
supersedes: null
invariants:
  - The hook command exits 0 on every path and says every decision in the host's own protocol, so no exit code of this package is read as a host decision; enforced by `pnpm test`.
  - Nothing under `src/core/` imports `src/hosts/`, and `src/hosts/` imports only Node builtins, the core and its own contract; enforced by `pnpm test`.
  - A predicate with an unknown key or a fragment that does not parse, a VERIFIED bracket that is not an address, and two different blocks under one id are each an error, never dropped or downgraded; enforced by `pnpm test`.
  - Text read from a review, a receipt or a host's input never reaches a shell - git is called with an argument array; enforced by `pnpm test`.
  - Writing the review under check, the bundle copy or the gate's own state never moves the source fingerprint, editing any other non-ignored file always does, and computing it leaves the real index byte-identical; enforced by `pnpm test`.
  - A gather that failed, or whose own steps changed the tree, is never published as the current sealed run; enforced by `pnpm test`.
  - No gate decision that checked nothing is journalled as a pass, and an exhausted retry episode is journalled as an error; enforced by `pnpm test`.
  - Every host adapter has recorded inputs it is tested against, and the README names as supported only hosts with an adapter; enforced by `pnpm check:docs`.
review_by: 2027-10-18
enforce_owner: Andrii Bohdanov
---

# DEC-0005: the checks run when the agent stops, not after a person reads

## Context

Every check in this package ran where DEC-0003 put it: in CI, after the
change and its account were written and usually after someone had started
reading them. An agent that wrote "the suite passes" over a run it never
finished, or over a run from before its last three edits, was caught - by a
red check on a pull request a person had already opened. The cheapest moment
to fix a claim is before anyone reads it, and that moment belongs to the agent
that wrote it.

Coding agents now expose that moment. Claude Code runs a hook when a session
starts, before each tool call and when the agent tries to stop, and a Stop
hook can refuse the stop with a reason the agent reads and acts on. The design
for using it went through four revisions and two independent reviews in
`docs/plans/` - [`runtime-gate.md`](../plans/runtime-gate.md),
[`runtime-gate-revision-4.md`](../plans/runtime-gate-revision-4.md),
[`runtime-gate-open-questions.md`](../plans/runtime-gate-open-questions.md) and
the answers in [`runtime-gate-decisions.md`](../plans/runtime-gate-decisions.md).

Doing it surfaced one problem that was not about agents at all: `receipt`
concatenated a review's target branch and Sample integrity paths into a shell
string, so a review carrying `$(...)` ran that command on the machine checking
it. A gate that runs the checks on text an agent just wrote cannot ship on top
of that, and neither can CI on a pull request from a fork.

## Decision

1. **Git without a shell.** `git()` and `gitCapture()` in `proc.ts` take an
   argument array; every call that passes a value from a review, a receipt or a
   caller goes through them.
2. **Predicates.** `VERIFIED[id: exit=0, passed>=71]` names the facts on the
   cited block a claim rests on, from a closed vocabulary read off the block,
   so it checks the same way locally and in CI. Anything the checker cannot
   evaluate is an error, never dropped.
3. **The seal.** Every gather publishes an immutable run into the checkout's
   git directory - bundle, canonical block hashes, and a content fingerprint of
   the source - and makes it current only once complete. `claims --seal` holds
   cited blocks to it and the code to the source it saw.
4. **The gate.** `core/gate.ts` decides session start, pre-write and stop
   without knowing any host; `hosts/claude-code.ts` speaks Claude Code's
   protocol; `evidence-layer hook` connects them and always exits 0;
   `evidence-layer init claude` and the plugin in `plugins/evidence-layer/`
   install it. Retry episodes, fail-open by default and a journal that never
   counts an unchecked allow as a pass keep it from becoming a trap.

## Threat model

The seal and the gate catch the **default** failure - a block typed in by hand,
output edited, a run from before the last edit, an agent editing the ledger
with a file-write tool. They do not stop a writer who means to fake it: the
ledger lives where the same agent can write through a shell, and nothing local
is signed. CI, which gathers its own evidence, stays the independent party, and
a local seal is never presented to it as proof.

Freshness covers what git sees: tracked and non-ignored files. Ignored files,
installed dependencies, the environment and the toolchain are outside it, and
an untracked file too large to hash is compared by size and mtime and makes the
verdict `unverifiable`. Two equal observations mean the tree was the same at
those two moments, not in between.

## What stayed a deferred decision, not a step

- **Other hosts.** Codex and others get an adapter once their hook protocol is
  documented well enough to write fixtures against, and not before.
- **Git-native hooks** (`init git`, pre-commit over staged review bytes).
  Staged review bytes are not staged source, and the two need one design.
- **A JSON protocol and bundle for third-party producers**, from
  [`evidence-layer-development-strategy.md`](../plans/evidence-layer-development-strategy.md).
  Worth it when a third party asks to produce evidence; until then it would be a
  second format beside the markdown grammar with no one to read it.

## Consequences

- Two new commands, `hook` and `init`, and a plugin in this repository; the
  published tarball is unchanged in shape (DEC-0003).
- A gather now writes into `.git/` by default (`seal: false` turns it off), and
  a step that writes into the tree makes the gather unsealed - visible in the
  bundle, not silent.
- `receipt` no longer runs anything a review says, which is a security fix for
  every earlier version.
