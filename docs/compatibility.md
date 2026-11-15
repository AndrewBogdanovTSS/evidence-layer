# Compatibility

What a project using `evidence-layer` may build on before 1.0, and what a
release owes it when one of those things changes. Until this page existed the
answer was "read every release note": eighteen minor releases in two months,
135 exports, and nothing saying which of them was a promise.

## What does not change without a major version

- **Exit codes.** 0 clean, 1 at least one error, 2 bad usage, 3 flaky.
  `evidence-layer hook` always exits 0 and speaks the host's protocol.
- **The five levels**: `pass`, `warning`, `error`, `unverifiable`, `flaky`.
  None is added, removed or folded into another.
- **A released reason code.** It is never removed and never given a new
  meaning; a rule whose meaning changes gets a new code
  ([DEC-0006](decisions/0006-reason-codes.md), held by `test/codes.test.ts`).
- **The artifact block grammar** a released version wrote: a block that
  parsed keeps parsing, and the hash half of its id - the six hex digits -
  is the same for the same command, commit and output.

## What may change in a minor release, with a note

A minor release may do any of these. When it does, its notes open with
**What you may have to do**, before anything else:

- **Turn a run that passed into one that fails** - a new rule, or a rule made
  stricter. New rules arrive as `warning` or `unverifiable` where they can,
  and become errors in a later release.
- **Change the kind half of an artifact id** (`cmd-a3f91c` to `tests-a3f91c`)
  when a command was classified wrongly. A review citing the old id is told
  the new one by the finding's `fix`.
- **Bump the JSON report's `schema`.** Within one schema number no field is
  removed or changes meaning; adding a field bumps it too, so a reader that
  checks `schema` is never surprised.
- **Remove a CLI flag or an export** that a previous minor release marked
  deprecated in its notes.

## What may change in any release

- **The wording** of a finding's `claim`, `detail` and `fix`. Match on `code`.
- **The seal's layout** under `<git-dir>/evidence-layer/`. It is this
  package's own ledger; read it through `claims --seal`, not from disk.
- **The gate's journal entries** beyond the fields `journal report` prints.
- **The text the gate hands an agent** at session start and in a block.

## The library

Everything `src/index.ts` exports can be imported, and most of it is there
because the CLI is built from it - not because it was designed to be called.
What is meant to be called, and is held to the rules above:

`lintClaims`, `downgradeClaims`, `gradeMix`, `parseReceipt`, `checkReceipt`,
`gatherEvidence`, `stepFailed`, `readBundle`, `checkBundle`, `CODES`, `EXIT`,
`exitCodeFor`, `report`, `formatArtifact`, `artifactId`, and the summarisers
in `evidence-layer/adapters/test-reports` and `adapters/node-default`.

Any other export may change in a minor release, and the notes say when one
does. The full list is pinned in `test/fixtures/exports.json`: adding to it
is a line someone writes on purpose, and removing from it fails the suite
until the fixture - and the release notes - say so.

A patch release changes none of the above.
