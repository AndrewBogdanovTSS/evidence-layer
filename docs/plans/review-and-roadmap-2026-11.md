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

**D2. Windows is written for and never run.** *Read.* There is process-tree
killing through `taskkill`, `cmd.exe` quoting and a separate Codex command for
Windows; every CI job is `ubuntu-latest`, and the suite's two skipped tests
are the two that exercise the Windows quoting. `mise.toml` pins Node 26.8.1
for development; CI tests 22 and 24.

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

Ordered by what most improves the declared goal per unit of work. One
ordering principle is taken from the tour itself: *a gate switched on before
its report is clean teaches people to route around it.* So each tightening
comes after the measurement that shows its cost and the change that makes the
honest path cheap - record first, cheapen second, enforce third.

Each item is done when a fixture that fails on purpose exists for it - the
project's own standard.

### Phase 0 - make the record true (0.18.x; days)

No semantics change. Everything here either removes a false statement or
makes an existing silence visible.

| # | Item | From | Size | Done when |
|---|---|---|---|---|
| 0.1 | Journal every stop, including the ones with nothing to check, with why (`no-claims`, `no-changed-review`). `journal report --include-gate` prints stops checked out of stops seen. | A1 | S | The appendix's A1 probe leaves one journal entry, and the report shows 0 of 1 checked. |
| 0.2 | Say the grade mix in every `claims` summary and in the JSON report (`verified`, `documented`, `inferred`, `unverified`, counts). The action's job summary leads with it. | A2 | S | The all-`UNVERIFIED` probe prints "0 of 3 verified". Exit codes unchanged. |
| 0.3 | One `unverifiable` finding, new code `claims/provenance-unchecked`, when a review cites artifacts and neither `--seal` nor `--bundle` was given. | A4 | S | The A4 probe reports `1 unverifiable` and fails under `--strict`. |
| 0.4 | `receipt`: compare `Files in diff` with the diff git computes; new code `receipt/diff-count-mismatch`. | C1 | S | The C1 probe is an error naming both numbers. |
| 0.5 | Zero-config plan: use the project's package manager; skip a step whose script does not exist, with that reason in the bundle. | B3 | S | The B3 probe writes "Not run: no `lint` script" and suggests no lint claim. |
| 0.6 | Artifact fences: write a fence longer than any backtick run in the body (as `formatCodeSpan` already does for spans), read fences by CommonMark length. Seal only the ids the gatherer produced. | B5 | M | Both B5 probes: the block round-trips; the printed block is not in the seal. |
| 0.7 | `governance` without a `package.json`: `unverifiable`, not a crash. | C3 | S | The probe reports a finding and prints no stack trace. |
| 0.8 | Docs: fix the four links, "six commands", "three outcomes", "one release", the plugin description, the README's gate sentence, the receipt's claim. Extend `check:docs` links and command count to `docs/**`. | C1, C4 | S | `check:docs` fails on the current tree before the fixes. |
| 0.9 | Decide bare `VERIFIED` before 2026-12-06: an error from a named version, with the date in the code rather than in an archived record; the finding stops citing a path consumers do not have. | C4 | S | A test pinned to the date; the message names the version. |
| 0.10 | A `proposed` decision record needs a `decide_by` date, held like `review_by`. Set one on DEC-0010. | C4 | S | A proposed record without one is an error under a new code. |

### Phase 1 - close the free exits (0.19 - 0.20; two to three weeks)

| # | Item | From | Size | Done when |
|---|---|---|---|---|
| 1.1 | **Declared kind.** The gatherer records each artifact's step, and the kind comes from the step - `tests-...` for the test step whatever its command. `classifyCommand` stays as the fallback for blocks built by hand. | B2 | M | The B2 probe: `npm run check` as the test step yields a `tests-` id, the test rules apply, freshness blocks. |
| 1.2 | **A failing run backs only a claim that says it failed.** Non-zero exit or `failed>0` requires a predicate that admits it (`exit!=0`, `failed>=1`) or failure wording; otherwise new code `claims/failing-run`. The skeleton already writes those predicates, so the honest path costs nothing. | B1 | M | The B1 probe is an error; the skeleton's own failure claim still passes. |
| 1.3 | **Decide DEC-0010: accept C3 and C4.** A citation from an earlier kept run that saw the same files passes; `restamp` moves a review onto the current run in one command. These are what make the honest path cheap *after the first edit* - the precondition for 1.4. | DEC-0010 | L | DEC-0010's own candidate invariants, each with a test. |
| 1.4 | **Result language outside a claim line.** In the final message, and in a changed review's prose: a sentence that names a kind of run (`kindsNamed`) and reads as its outcome (`readsAsSuccess`, a stated count) with no `**Claim**:` is new code `claims/unclaimed-result`. The reason hands over the ready claims, so the fix is a paste. Ships as a notice plus journal entry; becomes one block per episode once 0.1's numbers show how often it fires and how often it is wrong. Reuses the existing word lists - no new judgement. Record the decision as the missing "C7". | A1, A2 | M | The A1 probe is journalled as `unclaimed-result`; a fixture of ordinary prose ("this adds 3 tests") stays silent. |
| 1.5 | Unify the prose rule's word list with `SUCCESS_VERB_RE`. | A2 | S | "Tests pass." in review prose is found. |
| 1.6 | A changed review with claims and no Access Receipt: `unverifiable` in the gate, and the action notes it. The gatherer already writes the receipt, so keeping it is free. | A3 | S | Fixture: receipt removed, gate says so. |
| 1.7 | The gate on a fresh checkout: one launcher for `init` and the plugin that says "inactive, run X" instead of failing; this repository's session-start hook builds when `dist/` is missing. | D1 | S | A fresh clone's first session reports the gate active. |
| 1.8 | **Run the loop here.** Every pull request to this repository: gather in CI, a review file held to the bundle with the action, findings journalled. `check:ladder` asks a `fix:` commit for `Missed-By:` or an explicit `Missed-By: none`. | C2 | M | `journal:report` on `master` is non-empty; a `fix:` commit with neither trailer warns. |

### Phase 2 - widen what can be claimed (0.21 onward; a month or more)

| # | Item | From | Size |
|---|---|---|---|
| 2.1 | Custom steps: `steps: [{ name, kind, command, summarise }]`, sealed like the built-in four. Work summaries for more kinds through adapters - typecheck error counts, coverage percentages, a project's own keys - with predicates reading whatever the declared kind carries. | B4 | L |
| 2.2 | `evidence-layer gather`, driven by an `evidenceLayer` block in `package.json` or a small config file: commands as strings, report readers by name. The library call stays for projects that need code. `init` scaffolds the config, the script entry and a CI workflow; `doctor` says what is missing. | D4 | L |
| 2.3 | An invariant names its test - a file or a tagged title - and governance holds it to the suite's own report: that test ran and passed. Reachability skips comments, flags `if: false` and manual-only triggers, and reads Makefile, justfile and tox targets where there is no `package.json`. | C3 | L |
| 2.4 | A read log from the host: record the files the session opened (a post-tool-use hook) and hold a receipt's cited files to it. This is the version of "I read the code" that can actually be wrong. | C1 | M |
| 2.5 | Journal `claims` and `receipt` findings from CI runs, or delete the sentences that say they are. | C2 | M |
| 2.6 | A Windows CI leg for the suite; Node 26 in the matrix. | D2 | S |
| 2.7 | Redaction before hashing: a `redact` option and a default that masks the values of secret-shaped environment variables. | D3 | M |
| 2.8 | Host protocols get a `review_by`, held by `check:docs`, and a script that records fixtures from a live session per host release. | C5 | M |

### Phase 3 - towards 1.0

- Declare the stable surface: the CLI and its exit codes, the reason codes,
  the artifact grammar, the JSON report with a published schema and golden
  fixtures, the seal layout. Mark the rest of the 128 exports internal. (D5)
- Bind a bundle to the run that produced it with the platform's own
  attestation (GitHub artifact attestations), verified by the action - rung
  3, not a signing stack of this package's own. (D6)
- The adversarial fixture corpus from the strategy document, grown from the
  appendix here.
- A first case study written from the journal 1.8 fills.
- Further hosts, each under the existing rule: an adapter and recorded inputs
  first.

## On the two plans already in the repository

**DEC-0010** is right about the problem and should be decided rather than
left open: C3 and C4 belong in Phase 1 (item 1.3), C5 after them, and C1 once
0.1 shows how often an old review actually blocks an unrelated turn. Its
deferred "C7" is item 1.4.

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
