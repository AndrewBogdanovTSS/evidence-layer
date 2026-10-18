---
id: DEC-0008
status: accepted
date: 2026-10-18
supersedes: null
invariants:
  - A work-summary line is written by the gatherer after a step has finished, from the summariser the caller passed, and only when every count is present for the step's own kind; a step whose summary is unavailable says why in the bundle; enforced by `pnpm test`.
  - A JUnit report older than the step that should have written it is never read, and JUnit counts come from the `<testcase>` elements, not from a suite's attributes or from text inside CDATA or comments; enforced by `pnpm test`.
  - The report readers are pinned by output recorded from real runs of pytest and vitest, not written by hand; enforced by `pnpm test`.
review_by: 2027-10-18
enforce_owner: Andrii Bohdanov
---

# DEC-0008: the work-summary line has a writer, and it reads the project's own report

## Context

DEC-0005 gave claims predicates - `VERIFIED[tests-a3f91c: passed>=71,
failed=0]` - read off a work-summary line at the end of a test or lint block,
`[SUMMARY tests: passed=71 failed=0 skipped=0 todo=0]`. The grammar, its
parser, the outcome rules that use it and the skeleton that suggests
predicates from it all shipped. What did not was anything that writes the
line: `gatherEvidence` ran `pnpm test` and recorded its output as it was. So a
`passed>=N` predicate could only be checked against a block someone had typed
a summary into - the one kind of block the seal exists to catch.

The test step itself was fixed to `pnpm test`, so a project whose tests are
`pytest` or `mvn test` could not gather a test step at all. And `pytest` was
classified as a `cmd` artifact, not `tests`, because `\btest\b` does not match
inside a word - so even run by hand its success claims were held to none of
the test rules.

## Decision

1. **The gatherer writes the line.** `GatherOptions.summaries` takes a
   `Summariser` for the lint and test steps. After a step finishes, its answer
   is checked against the grammar - the kind must be the step's, every count
   present, a non-negative safe integer - and appended as the block's last
   line, before the block is addressed and sealed. The tool never writes it,
   which is what lets `parseWorkSummary` trust only the last line. A stopped
   run gets no summary, and any step whose summary is unavailable says why in
   the bundle.
2. **Readers live in an adapter.** `adapters/test-reports` reads JUnit XML,
   pytest's closing line and vitest's `Tests` line. JUnit is the one format
   nearly every runner can write, so it is how a Python, JVM or .NET project
   gets counts. The core only knows the `Summariser` type.
3. **Counted, not trusted.** JUnit counts come from `<testcase>` elements -
   a suite's `tests=` attribute is the writer's claim about the cases - with
   comments and CDATA removed first, since captured output can contain the text
   `<failure>`. A vitest line whose parts do not add up to its stated total is
   refused.
4. **A report is evidence about the run that wrote it.** A file older than the
   step is refused; in a directory of reports, the old ones are left out.
   Otherwise a test command that failed before writing its report would be
   credited with the previous run's counts.
5. **The commands are the project's.** `PlanOptions` gains `testCommand` and
   `typecheckCommand` beside `lintCommand`, and `classifyCommand` reads
   `pytest`, `rspec`, `phpunit`, `mypy`, `pyright`, `ruff`, `flake8` and
   `pylint` for what they are.

## Why not

- **Parsing JUnit with an XML library.** No runtime dependencies (DEC-0003).
  The reader needs elements, not a document model; what it does not handle -
  a `<testcase>` inside a comment, a `<failure>` inside CDATA - is removed
  before it looks.
- **The suite's attributes when present.** Two sources for one number means
  choosing between them when they disagree, and the cases are the thing the
  number is about.
- **A default summariser.** Which report a project writes, and where, is the
  project's business; a guessed default would read a file the project did not
  mean, or nothing, and both look like a summary.

## Consequences

- This repository's own gather summarises its test step with
  `summariseVitest`, so its bundle carries `passed=N` and its skeleton suggests
  it.
- An artifact id for a `pytest` command changes from `cmd-…` to `tests-…`; a
  review citing an old id of that command must gather again.
