# Review of 0.18.0, and a roadmap from it

A review of the repository at `4358ff2` (v0.18.0), made on 2026-11-09, and the
roadmap that follows from it. The question asked of every part: does it serve
the declared goal - turning a review's assertions into claims that could be
proved wrong - and does it keep the one rule the project grades itself by,
that the honest path must be cheaper than the convenient one?

## How this was done

- Read: `README.md`, `docs/evidence-layer.md`, `AGENTS.md`, DEC-0010, the
  development strategy, and the core in full - `claims`, `artifact`, `gate`,
  `seal`, `gather`, `receipt`, `skeleton`, `predicates`, `bundle`,
  `gather-command`, `gate-decision`, the `claims`, `hook` and `init` commands,
  the Claude Code adapter and the host contract. `governance` was read in the
  parts that trace triggers.
- Ran: `pnpm typecheck` (clean) and `pnpm check:all --enforce` (exit 0; 592
  tests passed, 2 skipped, 42 files; one warning, from `check:deps`).
- Probed: every finding below marked **reproduced** was run against the
  `dist/` of this commit with a minimal input. The inputs are in the appendix,
  so each can be run again. A finding marked **read** comes from the code
  alone.

Not reviewed in depth: `proc.ts` internals, the Codex adapter, the Azure and
GitHub output escaping, `ci-summary`, `check-ladder`, the release script,
`action/run.mjs`, and anything on Windows - there was no Windows machine.

## The verdict, first

The mechanisms are well made. What an addressed claim is held to - the id, the
commit, the predicates, the seal, the bundle - is checked carefully, the
failure messages carry their own fix, and the repository holds itself to its
own rules more strictly than most projects hold themselves to anything.

The gap is around the mechanisms, not in them. **Everything the layer checks
is opt-in by format, and every opt-out is free, silent and unrecorded.** An
agent that writes "all 12 tests pass" as a sentence instead of a `**Claim**:`
line is not checked, not blocked and not journalled - and the gate's own
session-start text tells it so. A review that drops its Access Receipt loses
the receipt check rather than failing it. A review with no claims at all exits
0. So today the convenient path is not merely cheaper than the honest one: it
is the only path with no risk of a block. That inverts the one rule at the
level of the whole product, and it is the first thing to fix.

Second: several rules rest on guessing from English or from a command's text,
and fall silent when the guess misses - where the gatherer already knows the
answer and could simply say it.

Third: the layer has not yet produced any evidence of its own usefulness.
There is no `journal.jsonl` in this repository, and not one `Missed-By:`
trailer in 75 commits, 16 of which are fixes.

## What is solid, and should not be disturbed

- **The seal.** A content fingerprint through a throwaway index, the
  racy-clean handling, `unverifiable` for sparse checkouts and unhashable
  files, and a pass that says exactly what it covers.
- **Five outcomes, kept apart.** `unverifiable` is used where a check could
  not run, consistently, including in the gate's journal.
- **Fixes read off the run, never off the claim.** `--fix` only ever says
  less. This is the best idea in the package.
- **Hostile-text hygiene.** Argument arrays for git, `::stop-commands::`, the
  Azure defang, `--review` refused rather than quoted.
- **Self-consistency.** `check:docs` holding the README's numbers, the code
  table checked both ways, the smoke job on bare Node 22.0.0, fixtures that
  must keep failing.
- **Honest limits.** The README says what the layer does not do. Most of what
  follows is about the places where that candour has a gap.

## Findings

### A. The way around the layer is cheaper than the way through it

**A1. A result stated in prose passes the stop gate unchecked and unrecorded.**
*Reproduced.* In a session that changed code and never gathered, a final
message of "ran the full test suite and all 12 tests pass. Lint is clean and
the typecheck passes." produces no hook output and no journal entry;
`journal report --include-gate` then says the gate has not run in the
checkout. `stop` returns `not-applicable` when no review changed and the
message has no `**Claim**:` line (`src/core/gate.ts:549-585`), and
`journalOutcome` drops `not-applicable` (`src/core/gate-decision.ts:102`). The
session-start context ends with "Ordinary prose is not checked; only **Claim**
lines are" (`gate.ts:242`), which reads to a model as an instruction.

The README's "an unbacked 'tests pass' is caught by the agent that wrote it"
is therefore true only of an agent that volunteered for the check. DEC-0010
names this (F5, "every way out is free") and defers it to a "C7" that no
document in the repository contains.

**A2. A review file can assert results in prose, or grade nothing VERIFIED,
and pass clean.** *Reproduced.* "All 71 tests pass and lint is clean. The
typecheck passed too" with no claim lines: one warning (`claims/none`), exit
0. The prose rule's word list (`claims.ts:121`: works, fixed, resolved,
passes, tested, validated) has no "pass", "passed", "passing", "green",
"clean" or "succeeded" - the outcome rules' own `SUCCESS_VERB_RE` knows them,
the prose rule does not. And a review whose every claim is `UNVERIFIED` is
`3 checked - 0 failed`, under `--strict` too. That is right as a verdict - an
honest `UNVERIFIED` is not a failure - but the summary a person reads in CI
cannot tell that review from one with three verified claims.

**A3. Leaving out the Access Receipt removes the receipt check.** *Read.* The
gate runs `checkReceipt` only when the review has a `HEAD SHA`
(`gate.ts:340`); the action's `receipt:` input is off by default. A review
that includes a receipt can be failed by it; one that omits it cannot.

**A4. Plain `claims` passes a block typed by hand, and says nothing about
it.** *Reproduced.* An invented `tests-abcdef` block with `passed=500` gives
`1 checked - 0 failed, 0 unverifiable`. The documentation discloses this, and
`--seal` and `--bundle` close it - but plain `claims` is the first command in
the README, the action's default, and what `check:claims` runs. The provenance
check did not run, and by this package's own rule a check that did not run is
`unverifiable`, not absent.

### B. Rules that guess, where the gatherer could say

**B1. A failing run backs any claim that does not sound like success.**
*Reproduced.* "The new parser handles unicode input correctly" and "The retry
logic is covered by the suite", both `VERIFIED` over a block with `failed=3`
and `exit: 1`: two passes, no warning. `outcomeProblem` returns early unless
`readsAsSuccess` matches (`claims.ts:205`), so the rule "a failing run backs
no success claim" is only as wide as an English word list.

**B2. The kind of a run is guessed from its command, and a miss switches the
rules off.** *Reproduced.* `classifyCommand` answers `cmd` for
`python -m unittest`, `cargo nextest run`, `make check`, `./gradlew check`,
`mvn -B verify`, `ctest`, `rake spec`, `tox`, `npm run check`, `cypress run`;
for the linters `cargo clippy`, `biome check`, `oxlint`, `rubocop`; for the
typecheckers `cargo check`, `go vet`, `flow check`, `svelte-check`. With the
test step set to `npm run check`, the gatherer still appends a test summary,
but the id is `cmd-...`, the suggested claim is "This command exits 0", and
"All tests pass" over a block summarising `passed=0 skipped=5` passes - where
the same block under `npm test` is an error. In the gate, freshness stops
blocking for that run too (`freshnessMatters`, `seal.ts:687`). The gatherer
knew it was the test step; that knowledge is thrown away and re-guessed. This
is where "the project it checks need not be Node" is weakest.

**B3. Zero-config gathering hands the writer a false claim.** *Reproduced.*
`gatherEvidence({ repo, base })` in an npm project with a `test` script and
nothing else runs `pnpm lint` and `pnpm typecheck`, gets exit 254 (`Command
"lint" not found`), and writes into the bundle, ready to keep:
`**Claim**: Lint reports violations.` / `VERIFIED[lint-8e8173: exit=254]`.
Lint reported nothing; there is no lint. The honest path - leave the skeleton
in place - produces an untrue claim that passes every check. The package
manager is assumed to be pnpm although `gather-command.ts` already reads
`packageManager`.

**B4. Only four kinds of evidence can be gathered, and only two carry
numbers.** *Read.* The plan is fixed at lint, typecheck, lockfile and test
(`gather.ts:95-128`), plus an optional audit. A build, an end-to-end run, a
migration, a size budget, a contract test - the "check only you can write" of
the tour's step 2 - cannot be added as a step, so it cannot be sealed, so a
claim about it can only be `UNVERIFIED` or rest on a hand-built block.
Predicates are closed over test and lint counts; a typecheck has no error
count and coverage is prose.

**B5. Output containing a fence line breaks its artifact block, and can plant
another.** *Reproduced.* A test run whose output includes a line starting with
three backticks (a docs test, a snapshot, a diff of a Markdown file) is
written by `formatArtifact` into a block that `findArtifactBlocks` no longer
parses: zero blocks come back, and the claim citing it fails as
`claims/unknown-artifact` for a reason the writer cannot see. Worse, output
that prints a well-formed `artifact:` block is parsed as that block, and
`buildSeal` seals every block that parses out of the bundle text
(`seal.ts:363-376`) rather than the ones the gatherer produced - so a
command's output can mint a sealed artifact. The fence regex
(`artifact.ts:62`) treats every fence as three backticks.

### C. Claims this repository makes that nothing backs

**C1. "I read the code" is not what `receipt` shows.** *Reproduced.* A receipt
stating `Files in diff: 1` over a two-file diff passes: the number is compared
only with the equally self-reported `Files opened` (`receipt.ts:228-236`),
never with `git diff --name-only`. A `path:line` citation is checked for the
line existing, not for what is on it. And the Sample integrity quotes - the
proof of reading - are pre-filled by the gatherer, which is the right cost
decision and means they show that the gatherer read the file. What `receipt`
does establish is real and worth having: the commit exists here, the base is
the true merge-base, every cited path exists at that commit. The README and
the module header claim more than that.

**C2. The journal is empty, and part of its description is not
implemented.** *Read.* There is no `journal.jsonl` in the repository. The tour
says "every check appends what it found" (`docs/evidence-layer.md:404`) and
`journal.ts` says a finding is "written by a checker, at the moment it runs";
only `misses.ts` and the gate write entries - `claims`, `receipt` and
`governance` findings are never journalled. Of 75 commits, 16 are `fix:` and
none carries `Missed-By:`. The question the tour defers to "30 runs against
real changes" has no runs to be answered from, and the README's "agent review
gets a scorecard" describes a scorecard with nothing on it in the package's
own first consumer. The cause is upstream: this repository runs governance,
`check:docs` and the ladder on itself, but never the core loop - no pull
request here is reviewed with gathered evidence and held to it in CI.

**C3. "This is enforced" is checked more loosely than it reads.**
*Reproduced, and read.* 31 of this repository's 39 invariants are "enforced by
`pnpm test`", so governance shows that the suite runs somewhere - not that any
test stands behind any one invariant; deleting the test leaves the report
green. Reachability is a text match over the trigger file: an invariant
enforced by `npm test` is `governance/reached` when that string appears only
in a comment, inside a job with `if: false`, in a workflow that runs only on
`workflow_dispatch`. And outside Node the check does not degrade, it crashes:
without a `package.json`, `governance` dies on an uncaught `ENOENT` with exit
1 - the code for "at least one error".

**C4. Statements past their date.**
- `docs/evidence-layer.md` opens with "Six commands" (the README says seven)
  and says "Three outcomes, never two" (there are five). Its step 4 points to
  "step 3 below", which is above it.
- Bare `VERIFIED` is "kept for one release" (`artifact.ts`, the tour) - that
  was seventeen releases ago. The cutover date in the archived DEC-0002 is
  **2026-12-06**, four weeks out, and nothing in the code knows it. The
  warning a *consumer* sees cites
  `docs/decisions/0002-evidence-layer-v2.md`, a path in this repository, and
  one that moved to `archive/`.
- Four relative links are broken (`docs/evidence-layer.md` twice and
  `docs/governance-exceptions.md` once to the un-archived DEC-0002;
  `docs/governance-exceptions.md` to `../packages/evidence-layer/...`).
  `check:docs` checks links in the README only.
- The plugin manifest says an unbacked claim "blocks the stop until it is
  fixed". By default it blocks twice and then lets the stop through.
- DEC-0010 has been `proposed` with `review_by: null` since 2026-10-19.
  Hygiene reports that as a pass ("a review date does not apply"), so a
  proposal can stay open indefinitely - the exact drift DEC-0004 exists to
  prevent for accepted records.

**C5. The host protocols have a read date and no clock.** *Read.* The adapters
are pinned to documentation "read 2026-10-17" and fixtures written from the
schema, as the README says plainly. Nothing brings that date back up for
review, and nothing has yet run against a live host.

**C6. The gatherer writes no Access Receipt.** *Reproduced; found
2026-11-14, while checking this document's own item 1.6.* The tour says
`pnpm evidence` "writes evidence.local.md, receipt included" and that
`check:receipt evidence.local.md` is then clean. A gathered bundle carries a
`- Head:` line and a Sample integrity table, and no receipt: `receipt` on it
fails on six missing fields. So the receipt - two 40-character SHAs among
them - is typed by hand, which makes it the most expensive honest step in the
layer, and explains A3 better than anything said there: a review omits the
receipt because writing one is all cost. The first version of this roadmap
proposed making its absence `unverifiable` on the grounds that "the gatherer
already writes the receipt, so keeping it is free". It does not.

### D. Reach and robustness

**D1. The gate is absent exactly where sessions start fresh.** *Observed in
this review's own session, and read.* On a fresh clone the session-start hook
reported "the gate is inactive ... is it built? (pnpm build)" - true of every
cloud or CI agent session in this repository until something builds. For a
consumer wired by `init claude`, the hook command is
`node "$CLAUDE_PROJECT_DIR/node_modules/evidence-layer/..."`
(`init.ts:65`); before `npm install` that is a module-not-found error and exit
1, which the host treats as a hook failure rather than a decision. Only the
plugin's launcher explains itself. Ephemeral sessions are where an unreviewed
agent summary is most likely to be the only thing a person reads.

**D2. Windows is written for, and no CI runs it.** *Read; corrected
2026-11-14.* There is process-tree killing through `taskkill`, `cmd.exe`
quoting and a separate Codex command for Windows; every CI job is
`ubuntu-latest`. The first version of this finding said Windows was "never
run", from the two tests Linux skips. That was wrong: the maintainer develops
on Windows and the suite passes there (588 passed, 6 skipped, at 0.18.0). What
is true is narrower - nothing a pull request triggers runs it, so a Windows
break is found on one machine or not at all. `mise.toml` pins Node 26.8.1 for
development; CI tests 22 and 24.

**D3. Captured output is published as it came.** *Read.* A step's output goes
verbatim into the bundle, from there into a CI artifact and, with `fold`, into
a pull request comment. Nothing masks a token a test printed or an
environment dump in a failure message.

**D4. Adoption costs a script, in JavaScript, in every project.** *Read.*
Gathering is a library call by design. For a Python or Go repository that
means adding Node tooling and a `.mjs` file to run `pytest`; for a Node one,
writing a script, a `package.json` entry and a workflow by hand. `init` writes
hooks only. The step the README says "carries the weight" is the one with the
highest setup cost.

**D5. The public surface is large and undeclared.** *Read.* 128 runtime
exports, a JSON report at schema 5 with no published schema, eighteen minor
releases in about two months. Nothing says which of it a consumer may build
on.

**D6. A bundle is trusted for where it came from, and nothing shows where.**
*Read, and disclosed in `bundle.ts`.* `--bundle` holds blocks to a file; that
the file is the one CI's gather job produced is the workflow author's word.

## Roadmap

*Revised 2026-11-14, after Phase 0 shipped and the roadmap was itself
reviewed. What that review found, and what changed here because of it:*

- *It had no measure of outcome - every "done when" was a fixture. There is
  now one number, below, and a stated way to collect it.*
- *It contradicted itself: Phase 0 was headed "no semantics change" and three
  of its items can turn a clean run red; item 1.8 was done when the journal
  was non-empty, while the checks that would fill it were scheduled a phase
  later; item 1.6 rested on a receipt the gatherer does not write (C6).*
- *One finding was overstated (D2, corrected above).*
- *Its own standard - a fixture that fails on purpose - stopped at Phase 1.
  Phase 2 now has it; Phase 3 is labelled as what it is.*
- *It only added. Each phase now carries something to remove, and the public
  surface is pinned so that growing it is a decision.*
- *It did not say which items break a consumer. They are marked, and there is
  a compatibility rule.*
- *Two items were under-sized and are split: prose detection (a decision
  first, and observation before any block) and "run the loop here" (blocked
  on a decision this document cannot make).*
- *Secret redaction was ranked below correctness fixes. It is the one item
  that can do harm outside the tool, and has moved up.*

One ordering principle is taken from the tour itself: *a gate switched on
before its report is clean teaches people to route around it.* So each
tightening comes after the measurement that shows its cost and the change
that makes the honest path cheap - record first, cheapen second, enforce
third.

### What this is measured by

**Of the stops the gate saw, how many checked something** -
`journal report --include-gate`, since 0.19.0. Today, for a session that
reports in prose, it is 0. Every item in Phase 1 should move it or make the
honest path that moves it cheaper; an item that does neither needs a reason
to be here.

It is a number per checkout: the gate's journal lives in `.git`, nothing
reports it anywhere, and nothing will. So it is collected by reading it - in
this repository's own checkouts first, which is one more reason for item
1.10. Two decisions below wait on it, with the thresholds written down now
rather than when they are convenient:

- **Prose detection may block (1.5b)** once 30 stops journalled as
  `unclaimed-result` have been tagged by hand (`journal tag <id> real|false
  --gate`) and at most 3 are false.
- **DEC-0010's C1** is worth building if more than 1 in 10 blocks is on a
  review the turn did not touch.

### Compatibility

From 0.20.0, [`docs/compatibility.md`](../compatibility.md): what a consumer
may build on, and what a release must say when it changes it. In the tables
below, **⚠** marks an item that can turn a run that passed into one that
fails, or changes an artifact id; each ships in a minor release, with what to
do about it first in the notes.

### Phase 0 - make the record true (0.19.0) - done

Shipped in [0.19.0](../releases/v0.19.0.md). Its heading here said "no
semantics change", which was not true of three items: `claims --strict` with
no seal or bundle (0.3), a receipt's diff count (0.4) and a proposed record
with no `decide_by` (0.10) can each fail a run that passed. The release notes
say so; this document did not. Two departures from the table: 0.9 keeps bare
`VERIFIED` a warning and puts the date in code with a test that fails from
it, since which release follows 2026-12-06 is not known; and 0.2's action
summary comes from `--format github`, which the action already runs.

It also took the reason codes from 79 to 86 and the package's exports from
128 to 135 - the opposite direction from D5. Item 1.0 is the answer to that.

| # | Item | From |
|---|---|---|
| 0.1 | Every stop journalled; "N of M stops checked something" | A1 |
| 0.2 | Grade mix in every `claims` report; JSON schema 6 | A2 |
| 0.3 | `claims/provenance-unchecked` ⚠ under `--strict` | A4 |
| 0.4 | `receipt/diff-count-mismatch` ⚠ | C1 |
| 0.5 | Zero-config plan uses the project's scripts, or skips them | B3 |
| 0.6 | Length-aware fences; the seal holds only produced artifacts | B5 |
| 0.7 | `governance/no-manifest` instead of a crash | C3 |
| 0.8 | Links checked in every document; stale statements fixed | C4 |
| 0.9 | Bare `VERIFIED` cutover as a dated constant and test | C4 |
| 0.10 | `decide_by` for proposed records ⚠ | C4 |

### Phase 1 - close the free exits (0.20 - 0.21)

In the order they should land. *Status* is as of this revision.

*2026-11-14: 1.0 to 1.7 are implemented, for
[0.20.0](../releases/v0.20.0.md). The exports went from 135 to 145 doing it -
ten names, each a line added to the fixture on purpose, which is what 1.0
set out to make true; it does not make the surface smaller, and nothing in
this phase did. 1.8 to 1.10 are not started, and each waits on a decision
that is the maintainer's.*

| # | Item | From | Size | Done when | Status |
|---|---|---|---|---|---|
| 1.0 | **A compatibility rule, and the exports pinned.** `docs/compatibility.md` says what is stable. The package's export list is a fixture a test holds it to, so an addition is a line someone wrote on purpose. | D5 | S | Adding an export without the fixture fails the suite. | 0.20.0 |
| 1.1 | **The step says what an unrecognised command is.** ⚠ ids. The gatherer knows which step it ran; when `classifyCommand` does not recognise the command, the step's kind is the artifact's - `tests-...` for a test step running `npm run check`. A reader takes the kind from the id. A command it does recognise keeps its kind, and so its id: a project whose lint step is its typechecker still gets one artifact. | B2 | M | The B2 probe: a `tests-` id, the test rules apply, freshness blocks. | 0.20.0 |
| 1.2 | **A failing run backs only a claim that says it failed.** ⚠ A non-zero exit needs a predicate that admits it (`exit=1`, `exit!=0`, `failed>=1`) or wording that does; otherwise `claims/failing-run`, and the fix is the grounding line with the run's own predicates - the sentence stays. The skeleton already writes them. | B1 | M | The B1 probe is an error; the skeleton's failure claim passes; "the new test reproduces the bug" passes with `exit=1`. | 0.20.0 |
| 1.3 | **The gatherer writes the Access Receipt.** Branch, head, target, merge-base and the diff's size, read from git, in the bundle beside the Sample integrity table. `Files opened` starts at 0, which is true until the writer says otherwise. | C6 | S | `receipt` on a fresh bundle reports no error. | 0.20.0 |
| 1.4 | **A review with claims and no receipt** is `receipt/absent`, `unverifiable`, at the gate - only now that 1.3 makes keeping one free. | A3 | S | Fixture: receipt removed, the gate says so and offers the bundle's. | 0.20.0 |
| 1.5a | **Result language outside a claim line - observed.** Decision first: [DEC-0014](../decisions/0014-results-stated-as-prose.md), proposed. A sentence that names a kind of run and reads as its outcome, with no `**Claim**:`, is `claims/unclaimed-result`: a warning in a review file, and in a final reply a journal entry - nothing said to the agent, nothing blocked. This reverses a stated limit ("prose is never graded"), on English word lists, so it ships as measurement. | A1, A2 | M | The A1 probe is journalled `unclaimed-result`; a corpus of ordinary prose stays silent. | 0.20.0 |
| 1.5b | **... and acted on.** ⚠ A notice with the ready claims, then one block per episode. Not before DEC-0014 is accepted and the threshold above is met. | A1 | S | DEC-0014's invariants. | waits on data |
| 1.6 | **Captured output is redacted before it is hashed.** The values of secret-shaped environment variables are masked in every block; a `redact` option for the rest. | D3 | M | A step that prints a token in its environment leaves no trace of it in the bundle or the seal. | 0.20.0 |
| 1.7 | **A `fix:` commit says what missed it.** `check:ladder` warns on a `fix:` with no `Missed-By:`; `Missed-By: none` is the explicit answer for a bug no review let through, and is not journalled as a miss. | C2 | S | A `fix:` commit with no trailer warns. | 0.20.0 |
| 1.8 | **Decide DEC-0010.** This document recommends accepting C3 and C4: a citation from an earlier kept run that saw the same files passes, and `restamp` moves a review onto the current run in one command. They are what makes the honest path cheap after the first edit. The decision is the maintainer's, by 2026-12-31. | DEC-0010 | L | DEC-0010's candidate invariants, each with a test. | not started |
| 1.9 | **The gate on a fresh checkout.** One launcher for `init` and the plugin that says "inactive, run X" instead of failing with module-not-found. Needs a design: `init` would have to write a launcher file into the project. | D1 | M | A fresh clone's first session is told the gate is inactive, and how to change that. | not started |
| 1.10 | **Run the loop here.** Gather in CI on every pull request and hold a review to the bundle - and journal what `claims` and `receipt` find there, which nothing does today. Blocked on a decision: who writes the review. A model step needs a key and a budget; a person needs a habit. | C2 | M | `journal:report` on `master` is non-empty. | needs a decision |
| 1.11 | **Remove:** on the first release after 2026-12-06, bare `VERIFIED` becomes an error and the proximity mode behind it is deleted - `ARTIFACT_WINDOW`, positional consumption, the id-less `artifact` fence. | C4 | S | The dated test is replaced by one expecting the error. | dated |

### Phase 2 - widen what can be claimed

Not scheduled. Each is done when its fixture exists; none starts before 1.8
and 1.10 are settled.

| # | Item | From | Size | Done when |
|---|---|---|---|---|
| 2.1 | Custom steps - `steps: [{ name, kind, command, summarise }]` - sealed like the built-in four, and work summaries for more kinds (typecheck error counts, coverage). | B4 | L | A build step's block is sealed and a claim cites it with a predicate. |
| 2.2 | `evidence-layer gather`, driven by an `evidenceLayer` block: commands as strings, report readers by name. `init` scaffolds it. | D4 | L | A Python fixture gathers with no `.mjs` file. |
| 2.3 | An invariant names its test, and governance holds it to the suite's report. Reachability skips comments and flags `if: false`. | C3 | L | The C3 probe is not `reached`; deleting an invariant's test fails governance. |
| 2.4 | A `path:line` citation may carry a quote, checked against that line. With a read log from the host where one exists. | C1 | M | A citation quoting the wrong line fails. |
| 2.5 | Citations with paths the pattern does not read today - `app/[id]/page.tsx`, `Makefile`, an upper-case extension. | C1 | S | Each is found and checked. |
| 2.6 | A Windows CI leg; Node 26 in the matrix. | D2 | S | The four Windows-only tests run on a pull request. |
| 2.7 | Host protocols get a `review_by`, and fixtures recorded from a live session. | C5 | M | `check:docs` fails when the date passes. |
| 2.8 | **Remove:** `SkeletonArtifact.timedOut`, deprecated since 0.4.0; the colon-named command aliases. | D5 | S | Neither is in the export fixture or the CLI. |

### Phase 3 - towards 1.0

A direction, not a plan - nothing here is sized or has a fixture yet.

- Shrink the stable surface in `docs/compatibility.md` to what a consumer
  needs, and mark the rest internal. (D5)
- A published JSON Schema for the report, with golden fixtures.
- A bundle bound to the run that produced it by the platform's own
  attestation, verified by the action. (D6)
- The adversarial fixture corpus from the strategy document, grown from the
  appendix here.
- A first case study written from the journal 1.10 fills.

### Not covered

This roadmap follows what the review read. The process runner (`proc.ts`),
the Codex adapter, the GitHub and Azure output escaping, `action/run.mjs`,
the release script and `check-ladder` were not reviewed in depth, so they
have no items - which is the absence of a review, not of problems. And it
has no evidence about users: it was derived from the code. If the binding
constraint is that few projects adopt the layer, 2.2 belongs ahead of most
of Phase 1; nothing measured here says which is true.

## On the two plans already in the repository

**DEC-0010** is right about the problem and should be decided rather than
left open: C3 and C4 belong in Phase 1 (item 1.8), C5 after them, and C1 once
the journal shows how often an old review actually blocks an unrelated turn.
Its deferred "C7" is item 1.5, and now a record of its own, DEC-0014.

**The development strategy** looks outward - a protocol, schemas, an adapter
SDK, attestations, bridges to neighbouring projects. Most of it is sound, and
its adversarial corpus, `init`/`doctor` and assurance-level ideas are taken up
above (0.3 is an assurance level said out loud). But its ordering puts the
protocol first, and that is the one disagreement here: a protocol published
now would standardise a check that a sentence of prose walks around, and
would do it before the project has one journal entry showing the check
catches anything. Close the exits, fill the journal, then freeze the format.

## Appendix: the probes

Each was run with `node dist/bin/evidence-layer.mjs` at `4358ff2`. Outer
fences are tildes because the inputs contain backtick fences.

**A1** - in a repository with one commit beyond its base, after a
`session-start` for the same session id:

~~~bash
echo '{"session_id":"s1","cwd":"'$PWD'","stop_hook_active":false,"last_assistant_message":"Done. I added mul(), ran the full test suite and all 12 tests pass. Lint is clean and the typecheck passes."}' \
  | evidence-layer hook claude stop
# prints nothing; .git/evidence-layer/journal.jsonl is not created
~~~

**A2** - `claims` on either file exits 0:

~~~markdown
All 71 tests pass and lint is clean. The typecheck passed too, and everything is green.
~~~

~~~markdown
**Claim**: Tests pass.
**Grounding**: UNVERIFIED
~~~

**A4** - `claims` exits 0 with `0 unverifiable`:

~~~markdown
**Claim**: The test suite ran 500 passing tests and reports no failures.
**Grounding**: VERIFIED[tests-abcdef: exit=0, passed>=500, failed=0]

```artifact:tests-abcdef@1234567
$ pnpm test
all good
[SUMMARY tests: passed=500 failed=0 skipped=0 todo=0]
exit: 0
```
~~~

**B1** - `claims` reports one pass:

~~~markdown
**Claim**: The new parser handles unicode input correctly.
**Grounding**: VERIFIED[tests-abcdef]

```artifact:tests-abcdef@1234567
$ pnpm test
3 failing
[SUMMARY tests: passed=2 failed=3 skipped=0 todo=0]
exit: 1
```
~~~

**B2** - a pass as written; an error (`checked nothing`) with the command
changed to `npm test` and the id to `tests-abcdef`:

~~~markdown
**Claim**: All tests pass.
**Grounding**: VERIFIED[cmd-abcdef]

```artifact:cmd-abcdef@1234567
$ npm run check
[SUMMARY tests: passed=0 failed=0 skipped=5 todo=0]
exit: 0
```
~~~

**B3** - in an npm project whose only script is `test`:

~~~js
await gatherEvidence({ repo: process.cwd(), base: 'base' })
// lint: exit 254, typecheck: exit 254
// bundle: **Claim**: Lint reports violations.  VERIFIED[lint-...: exit=254]
~~~

**B5** - `id` and `commit` are any valid id and commit:

~~~js
const out = 'running docs test\n```js\nconsole.log(1)\n```\n1 passed'
findArtifactBlocks(formatArtifact('pnpm test', out, 0, { id, commit }).split('\n')).length // 0

const printed = 'ok\n```\n```artifact:tests-ffffff@aaaaaaa\n$ pnpm test\n[SUMMARY tests: passed=999 failed=0 skipped=0 todo=0]\nexit: 0\n```\n```\ntail'
findArtifactBlocks(formatArtifact('node script.js', printed, 0, { id: 'cmd-000000', commit }).split('\n'))
// one block: tests-ffffff, `pnpm test`
~~~

**C1** - a receipt whose head and base are right, over a two-file diff, with
`**Files in diff**: 1` and `**Files opened during review**: 1`: `receipt`
reports "1 opened of 1 in the diff" as a pass and exits 0.

**C3** - with a decision record whose invariant is "enforced by `npm test`"
and a `test` script in `package.json`, `governance --enforce` reports the
invariant reached and exits 0:

~~~yaml
on: workflow_dispatch
jobs:
  never:
    if: false
    runs-on: ubuntu-latest
    steps:
      - run: echo hi   # TODO: one day run npm test here
~~~

With the `package.json` removed, the same command exits 1 on an uncaught
`ENOENT` from `traceTriggers`.
