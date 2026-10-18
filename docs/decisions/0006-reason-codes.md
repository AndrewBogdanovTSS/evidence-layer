---
id: DEC-0006
status: accepted
date: 2026-10-18
supersedes: null
invariants:
  - Every finding that `claims`, `receipt`, `claims --seal` and `governance` produce carries a code from `src/core/codes.ts` - a finding built without one does not compile; enforced by `pnpm typecheck`.
  - Every code in the registry is documented in `docs/evidence-layer.md`, and the table there lists no code the registry lacks; enforced by `pnpm check:docs`.
  - No released code is removed or renamed, and every registered code is one some check can produce; enforced by `pnpm test`.
  - Asked for `--format json`, a check prints exactly one JSON document and exits with the code the text mode would have given, and an unknown format is bad usage, never a silent fall back to text; enforced by `pnpm test`.
review_by: 2027-10-18
enforce_owner: Andrii Bohdanov
---

# DEC-0006: findings say which rule produced them, in a word a program can match

## Context

Every finding has carried a level, a `claim` and a `detail` - the last two
English, written for the person reading a terminal. A program that wanted to
act on a finding had two choices: the level, which says how bad it is but not
what it is, or the sentence, which says what it is in words that change every
time someone improves them. A GitHub Action that annotates
`claims/unknown-artifact` differently from `claims/untagged`, a SARIF export
that needs a rule id, a dashboard counting which rules fire - each of them
would have been a regex over prose, which is a claim about the wording, not
about the review.

[`evidence-layer-development-strategy.md`](../plans/evidence-layer-development-strategy.md)
proposed the fix as seven new verdicts (`stale`, `edited`, `unbacked` and
others). [The runtime-gate report](../plans/runtime-gate-implementation-report.md)
§ 3 took the need and rejected the form: five outcomes are a contract every exit
code, journal entry and CI step depends on, and a sixth would break each of
them. A field on the finding carries the same diagnosis without touching the
contract.

## Decision

1. **A registry.** `src/core/codes.ts` lists every code with one line saying
   what it means. Codes are `<check>/<rule>` - `claims/predicate-unmet`,
   `receipt/wrong-base`, `seal/stale`, `governance/unreached`.
2. **A code names a rule, not an outcome.** The level is still one of the
   five. A rule that can pass or fail has one code for the pass and one naming
   each way it fails - `receipt/sample` and `receipt/sample-mismatch` - so the
   code alone says what went wrong, and an `unverifiable` keeps its own code
   (`seal/partial-coverage`) rather than borrowing a pass's.
3. **Compiled in, not remembered.** The package's checks build `CodedFinding`
   (`Finding & { code: Code }`), so a finding without a code, or with a code
   not in the registry, is a type error. `Finding.code` itself stays optional:
   a project's own checks report through the same type and owe nobody a
   registry.
4. **A released code keeps its meaning.** `test/fixtures/codes-released.json`
   records the codes each release shipped; one missing from the registry fails
   the suite. A rule whose meaning changes gets a new code, and the old one
   stays until a major version says otherwise.
5. **`--format json`** on `claims`, `receipt` and `governance` prints the
   report `check:all` already emits between its delimiters - schema 4, which
   adds `code` to each finding and `check` to the report - as the whole of
   stdout, with the exit code unchanged.

## Why not

- **The report's exit code in the JSON.** The process exit code is the
  verdict, and a second copy of it is one more thing that could disagree with
  the first. A consumer that runs the command has it already.
- **Codes for this repository's own checks** (`scripts/check-docs.ts`,
  `check-ladder.ts`). They are facts about this repository, not rules the
  package ships, and a registry of them would be a public promise about
  private scripts.
- **Codes in the gate's journal.** The gate's findings carry codes - they are
  the same findings - but a journal entry records a decision, not each
  finding. Worth adding when a report needs to count rules across stops.

## Consequences

- The report schema is 4. A reader of schema 3 still reads it: nothing was
  removed, two fields were added.
- `SARIF` export and a GitHub Action become a mapping from codes, not from
  sentences - the reason this came first.
- Rewording a `detail` is free; renaming a code is a breaking change, and the
  suite says so.
