# Using it

The order of work in a project of your own: what to set up once, what to do
on each change, what to do when a check fails, and what to read every week.
[`evidence-layer.md`](evidence-layer.md) is the reasoning behind each check,
and [`examples/plain-node-project/`](../examples/plain-node-project) is a
project set up this way, where every step below can be run.

One idea carries all of it: **run the commands before the review is written,
and let the review keep what they printed.** Everything else is making that
the path of least effort - for a person, and for an agent that would
otherwise write "the tests pass" because it is a plausible next sentence.

## Set it up, once

**1. Install it.**

```bash
npm install --save-dev evidence-layer
```

**2. Write the gather script.** Gathering is a library call in a script you
own, because which commands are your project's, and how long they may take,
is yours to say:

```js
// scripts/evidence.mjs
import { gatherEvidence, stepFailed } from 'evidence-layer'
import { summariseNodeTest } from 'evidence-layer/adapters/test-reports'

const at = process.argv.indexOf('--base')
const result = await gatherEvidence({
  repo: process.cwd(),
  base: at === -1 ? 'origin/main' : process.argv[at + 1],
  summaries: { test: summariseNodeTest() },
})
if (result.steps.some(stepFailed)) process.exitCode = 1
```

With nothing else it runs your `lint`, `typecheck` and `test` scripts and a
lockfile check, and skips one you do not have, saying so. `plan` replaces a
command (`testCommand: () => 'pytest -q --junitxml=reports/junit.xml'`),
`skip` drops a step, and `summaries` says how to read how much a step checked:
`summariseNodeTest`, `summariseVitest`, `summarisePytest` or `summariseJUnit`.
Give the test step a summariser. Without one a block says a command exited 0
and nothing about how many tests ran, and "all 71 tests pass" has no number to
be held to.

Add it to `package.json`, and say how it is called, so that every message
telling a writer to gather again can name the command:

```json
{
  "scripts": { "evidence": "node scripts/evidence.mjs" },
  "evidenceLayer": { "gather": "npm run evidence -- --base origin/main" }
}
```

Put `evidence.local.md` in `.gitignore`. It is one working copy's evidence,
not history.

**3. Wire the runtime gate**, if an agent works in the repository:

```bash
npx evidence-layer init claude    # and/or: init codex
```

Commit what it writes - the hooks and the launcher beside them - and run it
again after upgrading the package. Codex runs a project's hooks only once you
trust them, in `/hooks`.

**4. Gather in CI.** The job that runs your tests becomes the job that
gathers: the script exits 1 when a step failed, after writing the bundle, so
the suite runs once. Upload `evidence.local.md` as an artifact.
[The example's workflow](../examples/plain-node-project/.github/workflows/ci.yml)
is the layout, and
[its Azure pipeline](../examples/plain-node-project/azure-pipelines.yml) the
same for Azure DevOps.

**5. Start warn-only.** Leave `--strict` and `--enforce` off until the reports
are clean (see [How strict to be](#how-strict-to-be)).

## On each change

**Gather first.**

```bash
npm run evidence -- --base origin/main
```

It refuses when the working tree is not at the commit you asked about, writes
`evidence.local.md`, and seals the run in the checkout's git directory.

**Write the review by keeping, not by typing.** The bundle ends with two
sections made to be copied:

- *Suggested claims* - a `**Claim**:` / `**Grounding**:` pair for each run,
  with the id and the predicates filled in, and the artifact block under it.
  Keep the pairs you are claiming, with their blocks, unedited. Delete the
  rest.
- *Suggested access receipt* - the branch, the commits and the size of the
  diff, read from git. Keep it, and set `Files opened during review` to what
  you opened.

Everything else you assert takes one of the other three grades:

| You have | Write |
|---|---|
| a run in the bundle | `VERIFIED[id: predicates]`, as the bundle wrote it |
| a source to point at | `DOCUMENTED`, with a URL, a `§` section, an issue id or a file in backticks beside it |
| a chain of reasoning | `INFERRED`, with two or more numbered steps below it |
| nothing | `UNVERIFIED` |

`UNVERIFIED` is a pass. It tells the next reader where the review is thin
instead of hiding it, and it is always available: the cheapest way past any
finding is to say less.

Opinions need no grade. "This will be hard to maintain" is a review comment,
not a claim. What should not sit in prose is a result - "all 12 tests pass" -
because there nothing checks it.

**Check it.**

```bash
npx evidence-layer claims review.md --seal   # backed, by this run, about this code?
npx evidence-layer receipt review.md         # written against this checkout?
```

With the runtime gate, an agent does not have to remember to: both run when it
stops, over the review files the session changed and the claims in its final
reply.

**Fix from the finding.** A failing finding carries its fix, read off the run:
the claim the cited run does back, ready to paste. `claims review.md --fix`
applies the one fix that needs no judgement - every failing claim becomes
`UNVERIFIED` - and never rewrites a sentence to fit a run.

## After you change the code

The evidence is about the code as it was. Edit a file and `--seal` reports
`seal/stale`, naming it. The honest fix is two commands:

```bash
npm run evidence -- --base origin/main
npx evidence-layer restamp review.md         # --dry-run first, to see what would move
```

`restamp` replaces each block the review carries from an earlier run with the
current run's block for the same step, rewrites the ids in the grade tags, and
checks the result as `--seal` does. It never touches a sentence or a
predicate, so a claim the new run does not back is still an error - now one
that is true. Three things it leaves to you:

- **The Access Receipt.** Which commit a review is about is yours to say. When
  the new run is of a later commit, `restamp` tells you; replace the receipt
  with the new bundle's.
- **Gathering again when nothing changed** needs no restamp. A citation from
  an earlier run holds while the files are what that run saw
  (`seal/earlier-run`). The five most recent runs are kept.
- **A claim with no predicates** is held on the new block only to what its
  wording says. Keep the predicates the bundle wrote: `passed>=71` is what
  notices the new run passing 70.

## In CI

A check run by whoever wrote the change is a self-report. For the evidence to
be someone else's, CI gathers it, and the review is held to CI's bundle:

```yaml
- uses: AndrewBogdanovTSS/evidence-layer@<release>   # the README shows the current ref
  with:
    claims: review.md
    bundle: evidence.local.md
    sha: ${{ github.event.pull_request.head.sha }}
```

On Azure Pipelines it is a script step, with `--format azure`:

```yaml
- script: npx evidence-layer claims review.md --bundle evidence.local.md --sha $(System.PullRequest.SourceCommitId) --format azure
```

Two things to know before relying on it.

**The review has to be written from CI's bundle.** An id hashes a run's
output, and test output carries timings, so the ids CI's run gets are not the
ids your machine's run got. A review written locally is checked locally, with
`--seal`; a review held with `--bundle` is one written after CI gathered - by
a model in a later job, as the example does, or by a person reading the
uploaded bundle.

**A bundle is as trustworthy as where it came from.** Use the artifact CI's
gather job uploaded, never a bundle committed beside the review, and always
pass the commit under review as `sha`.

When a model writes the review, run `claims --bundle --fix` before anyone
reads it: what the bundle does not back becomes `UNVERIFIED`, and correcting
it costs no second model turn.

## When a check fails

Take the finding's own `fix` first. This table is for knowing what you are
looking at.

| Code | What happened | What to do |
|---|---|---|
| `seal/stale` | the code changed after the evidence was gathered | gather again, then `restamp` |
| `seal/not-gathered` | the cited block is from no kept run | `restamp`, or copy the block and its claim from the bundle again |
| `seal/edited`, `bundle/edited` | the block is not as the gatherer wrote it | copy it again, whole; do not trim a block |
| `seal/disagreeing-runs` | an earlier run is cited, and the current run of the same command ended differently (exit 3) | cite the current run, or find out which result holds |
| `claims/unknown-artifact` | the tag names an id the review does not contain | the block was left behind: copy it with its claim |
| `claims/wrong-commit` | the block was gathered at another commit than the receipt names | gather at the commit under review, `restamp`, and take the new receipt |
| `claims/failing-run` | the cited run exited non-zero, and the claim does not say so | take the fix: the grounding with the run's own predicates |
| `claims/predicate-unmet`, `claims/count-mismatch` | the claim states a number the run does not show | take the fix: the claim the run does back |
| `claims/kind-mismatch` | a lint claim cites a test run, or the like | cite the run the claim is about |
| `claims/unclaimed-result` | a result is stated as prose | state it as a claim, or as `UNVERIFIED` |
| `claims/provenance-unchecked` | blocks are cited, and neither `--seal` nor `--bundle` was given | pass `--seal` locally, `--bundle` in CI |
| `claims/bare-verified` | `VERIFIED` with no id | cite the id; an error in the first release after 2026-12-06 |
| `receipt/absent` | the review has claims and no Access Receipt | copy the bundle's suggested receipt |
| `receipt/wrong-base` | the base is not the merge-base with the target branch | fetch the target branch and take the bundle's receipt |
| `bundle/not-gathered` | the cited block is not in CI's bundle | the review was not written from that bundle |

Every code is listed, with its meaning, in
[the tour](evidence-layer.md#machine-readable-output).

## How strict to be

Each knob trades a false alarm against a miss. Start at the left, and move
right once the report at that level has been clean for a while: a gate
switched on before its report is clean teaches people to route around it.

| Where | Default | Stricter |
|---|---|---|
| `claims`, `receipt` | errors fail | `--strict`: warnings and `unverifiable` fail too |
| `governance` | warn only | `--enforce`: an error exits 1 |
| the gate, on errors | blocks twice in an episode, then lets the stop through with the errors attached | `--keep-blocking`: never runs out of blocks |
| the gate, when it cannot run | the session goes on, and is told why | `--fail-closed`: blocks |
| the gate, on `unverifiable` | a message | `--strict`: blocks, and both of the above |

Pass the gate's flags to `init`, which writes them into the hooks. `--strict`
on `claims` is what turns a result stated as prose, a bare `VERIFIED` and
unchecked provenance into failures; it is a reasonable setting for CI well
before it is one for the gate.

## Every week: read the journal

The layer keeps two records, and neither means anything until a person reads
it.

```bash
npx evidence-layer journal report --include-gate
```

- **Of the stops the gate saw, how many checked something.** A stop with no
  changed review and no claim in the final reply had nothing to check. If that
  is most of them, results are being reported as prose, and the gate is
  watching an empty road.
- **Blocks, not yet tagged.** Each has an id. Decide whether the block was
  right, and say so: `journal tag <id> real --gate`, or `false`. A check that
  is mostly false is one to loosen; the counts are how you know which.
- **Results stated outside a claim.** Listed with the sentence, and tagged the
  same way.
- **Misses.** When a commit fixes a bug a review let through, say so in the
  commit: `Missed-By: <review or pull request>`. `governance` records it into
  `journal.jsonl`, which is committed. `Missed-By: none` is the answer when no
  review let it through. Tag a miss with `--caught yes|no`: could a check you
  already have have caught it?

The gate's journal lives in the checkout's git directory and is not shared;
`journal.jsonl` is. The agent is never shown a block's id - the blocked party
does not grade its own blocks - so the tagging is yours.

## What it will not do for you

It does not read output for meaning. A real, correctly cited run under a
sentence it says nothing about passes, with a warning at most. It makes "which
run backs this?" answerable and "did that run happen, on this code?" checked -
whether the run supports the sentence is still a reader's judgement. And it
removes the default failure, not a determined one: the seal lives where the
writer can write, which is why CI gathers its own.
[The tour](evidence-layer.md#what-this-does-not-do) has the full list.
