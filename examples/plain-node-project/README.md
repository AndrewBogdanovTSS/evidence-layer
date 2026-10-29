# widget-counter

A deliberately boring project: one function, three tests, plain JavaScript, no
TypeScript, no framework, no monorepo, its own unconnected `package.json`. What
matters about it is what it is **not**.

It exists twice over.

1. As a **test fixture**: [`test/portability.test.ts`](../../test/portability.test.ts)
   runs `readInvariants`, `reachableCommands`, `lintClaims`, `checkReceipt` and
   `renderSummary` against this directory. A claim that `evidence-layer` works
   on "any project" is exactly the kind of claim its own `claims` check would
   tag UNVERIFIED if nobody had checked it. Anything that had to change in
   `src/core/` rather than in an adapter to make this project work would have
   been a layer-separation bug, fixed rather than worked around.

2. As the **worked example**: everything below runs here, against files you can
   read in a minute, so you can watch each check fire before pointing any of it
   at code you care about - and it is set up the way a project using
   evidence-layer should be:

   | File | What it does |
   | --- | --- |
   | [`package.json`](package.json) | `evidence-layer` as a dev dependency (this checkout, via `file:../..`; in your project, the registry) and an `evidence` script |
   | [`scripts/evidence.mjs`](scripts/evidence.mjs) | gathers the evidence before a review is written: runs `npm test`, appends Node's test counts as a work summary, seals the run, and exits 1 when the suite failed |
   | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | gathers in CI - the suite runs once, inside the gather - and uploads the bundle; checks governance alongside; on a pull request, a model reviews from the bundle and its review is held to that bundle - see [below](#in-ci-gather-review-verify) |
   | [`azure-pipelines.yml`](azure-pipelines.yml), [`scripts/azure-pr.mjs`](scripts/azure-pr.mjs) | the same jobs for Azure Pipelines, each posting the pull request status a branch policy can require - see [below](#in-azure-pipelines) |
   | [`scripts/ci-local.mjs`](scripts/ci-local.mjs) | `npm run ci:local`: the workflow's jobs - or the Azure pipeline's - run locally the way CI runs them - see [below](#before-you-push-npm-run-cilocal) |
   | [`.claude/settings.json`](.claude/settings.json), [`.codex/hooks.json`](.codex/hooks.json) | the runtime gate, written by `evidence-layer init claude` and `init codex` |
   | [`scripts/standalone.mjs`](scripts/standalone.mjs) | `npm run standalone`: copies this project out as a repository of its own - see below. Not part of the setup; the copy leaves it behind |
   | [`docs/decisions/0001-example.md`](docs/decisions/0001-example.md) | two invariants, one enforced by a command and one by "a human" |

   The setup is for a project that is its own repository, and inside
   evidence-layer's checkout this one is not. git answers every question from
   the top level, which here is evidence-layer's, so both hosts' hooks would
   check evidence-layer's `review.md` and keep their state in its `.git` - the
   Codex command would not even find the package, which it looks for from
   there - and a sealed run would fingerprint the whole checkout. So the
   runtime gate and the seal are shown in a copy (step 0); every other step
   runs from here.

## The tour

Run these from the root of this repository after `pnpm build`, unless a step
says otherwise. Each takes seconds.

### 0. Gather, write, check - the loop this project is set up for

In a copy that is a repository of its own, for the reason above:

```bash
cd examples/plain-node-project
npm run standalone                        # copies it out, links this checkout, commits; prints the path
cd <the path it printed>
npm run evidence -- --base HEAD           # writes evidence.local.md and seals the run
```

The bundle's test block ends with a line the gatherer appended, not the test
runner - `[SUMMARY tests: passed=3 failed=0 skipped=0 todo=0]`, read off Node's
own totals - and its *Suggested claims* section already cites it:
`VERIFIED[tests-…: exit=0, passed>=3, failed=0]`. The lint step says it was not
run: the lint script is a placeholder that checks nothing, and gathering it
would suggest "lint reports no violations" about no lint at all.

Copy the suggested claims into `review.md` and check it against the sealed run:

```bash
npx evidence-layer claims review.md --seal
```

Every claim passes, every block is the one the run wrote, and the code is what
it was gathered from. Now change `index.js` and run it again: the same review
fails with `seal/stale`, naming the file - evidence about yesterday's code does
not back a claim about today's. [`test/example.test.ts`](../../test/example.test.ts)
runs exactly this loop on a copy `npm run standalone` made.

Start Claude Code or Codex in the copy and the runtime gate works on the copy:
a `review.md` the session writes there, or the claims in its final message,
are checked when the turn ends. Codex runs a project's hooks only once you
trust them, in `/hooks`.

### 1. A review whose claims are backed

```bash
npx evidence-layer claims examples/plain-node-project/reviews/good-claims.md
```

Four claims, four tags, exit 0. One is `VERIFIED[tests-3a6036: exit=0,
passed>=3, failed=0]`, which addresses the artifact block below it - gathered
by `scripts/evidence.mjs`, work summary and all - and names the counts the
claim rests on; one is `DOCUMENTED` and cites a file; one is
`INFERRED` and shows its chain; one is `UNVERIFIED` and says so. An honest
UNVERIFIED is a pass, not a failure - it tells the next reader where the review
is thin instead of hiding it.

### 2. The same review, unbacked

```bash
npx evidence-layer claims examples/plain-node-project/reviews/bad-claims.md
```

Six errors and a warning, exit 1. Read
[`bad-claims.md`](reviews/bad-claims.md) and
[`good-claims.md`](reviews/good-claims.md) side by side: the broken one is
shorter, more confident, and reads better. That is the problem in one page.

### 3. The failure proximity alone cannot catch

```bash
npx evidence-layer claims examples/plain-node-project/reviews/phantom-artifact.md
```

Both claims use the addressed form and both fail: one names an id that exists
nowhere, one names an id that is real but lives in a different file. A checker
that only asked "is there an artifact block near this tag" would pass the
second one.

### 4. A real artifact asked to carry too much

```bash
npx evidence-layer claims examples/plain-node-project/reviews/shotgun-artifact.md
```

Exit 0, with a warning. The block is real, the id is right, and four claims
address it - three of which it says nothing about. Not an error, on purpose: a
checker that failed this would teach people to split evidence artificially.

### 5. A real artifact, and the wrong number

```bash
npx evidence-layer claims examples/plain-node-project/reviews/predicate-mismatch.md
```

Exit 1. The id resolves, the run exited 0 and its work summary shows tests that
ran - and the claim says four where the artifact says three. The tag carries a
predicate, `passed>=4`, so the number is no longer only in the sentence where a
script cannot reach it.

### 6. The wrong number, with no predicate to catch it

```bash
npx evidence-layer claims examples/plain-node-project/reviews/count-mismatch.md
```

Exit 1, `claims/count-mismatch` twice. The same mistake as step 5, with the
predicates left out - and the sentence is still held to the run. "Four passing
tests" and "2 tests were skipped" are read off the words and compared with the
work summary's `passed=3 skipped=0`. A number spelled out is the same number.
Only a count a word ties to the run is read: "adds 3 tests" is about the
change, and is left alone.

### 7. The wrong kind of run

```bash
npx evidence-layer claims examples/plain-node-project/reviews/kind-mismatch.md
```

Exit 1, `claims/kind-mismatch`. "Lint reports no violations" cites a test run
that passed - real block, right id, exit 0. A test run says nothing about lint,
so the claim fails whatever that run showed, and since no lint run was gathered
the fix says so rather than offering one.

### 8. Exit 0 is not the same as "it passed"

```bash
npx evidence-layer claims examples/plain-node-project/reviews/outcome-mismatch.md
```

Exit 1, `claims/outcome-mismatch` three times, over three real runs of this
project's suite: one with a failing test, one the time limit killed (`exit: 124
(timeout)`), and one where every test was skipped - exit 0, `passed=0`. A
success claim over any of them fails. Beside each sits the claim the same run
does back - "1 failing test", "did not complete", "ran 0 tests to completion" -
and those pass. The skipped run is the one to look at twice: its exit code is
the one a passing suite has.

### 9. Let the checker apply the fix that needs no judgement

```bash
npx evidence-layer claims examples/plain-node-project/reviews/fix-me.md
cp examples/plain-node-project/reviews/fix-me.md review-copy.md
npx evidence-layer claims review-copy.md --fix
```

The first prints three errors - a wrong count, the wrong kind of run, a
predicate key that does not exist - each with a `fix:` read off the run: the
claim it does back, or the grounding line with its own predicates. `--fix`
writes to the file, hence the copy: it marks every claim an error failed
UNVERIFIED, checks again, and exits 0. It never rewrites a sentence or a
predicate to fit its run, so the cheapest way past a finding says less, never
more. Delete `review-copy.md` afterwards.

### 10. Is anything actually running the checks?

```bash
npx evidence-layer governance --repo examples/plain-node-project --decisions examples/plain-node-project/docs/decisions
```

[`docs/decisions/0001-example.md`](docs/decisions/0001-example.md) declares two
invariants. One names `npm run evidence` - the gather, which runs the suite and
fails when it does - and [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
runs it: reachable, pass. The other is enforced "by a human", which names no
command at all - a warning, because an invariant nothing can run is decoration,
and the check says so rather than guessing.

This invariant used to name `npm test`, which the workflow ran - written
in npm's shorthand, not `npm run test`, a case found by building this fixture:
a scanner that only knew `npm run <name>` reported the script as unreached in
the most common project layout there is. The shorthand is still recognised,
and `test/governance.test.ts` holds the scanner to it; CI here simply no
longer runs the suite twice.

### 11. The same findings, for a program

```bash
npx evidence-layer claims examples/plain-node-project/reviews/bad-claims.md --format json
npx evidence-layer claims examples/plain-node-project/reviews/bad-claims.md --format github
```

`json` is one document - every finding with a stable `code` such as
`claims/untagged` - and `github` turns each finding into an annotation on the
review's line, which is what the action in this project's workflow does. The
exit code is the same in every format.

### 12. Render a run for CI

```bash
npx evidence-layer governance --repo examples/plain-node-project --decisions examples/plain-node-project/docs/decisions > run.txt
npx evidence-layer ci-summary run.txt
```

The summary is markdown, meant for `$GITHUB_STEP_SUMMARY`. Point it at a file
that does not exist and it renders **"no report"** - not a clean run, and not
silence either. A clean run still prints its report block, which is the entire
reason the block is emitted unconditionally: an absent report means the checks
did not run, and a summary that stayed quiet about that would manufacture
confidence out of nothing.

## Break it on purpose

A check nobody has seen fail is indistinguishable from a check that cannot
fail. Try any of these:

- Delete the `exit: 0` line from the artifact block in `good-claims.md`. The
  block stops being an artifact, and the claim that addresses it fails.
- Change one digit of the id in the fence (`artifact:tests-3a6036@…`) without
  changing the tag. Both halves are now phantoms.
- Change `passed>=3` to `passed>=4` in `good-claims.md`'s tag. The block is
  real and the run passed; the number in the claim is wrong, and it says so.
- Add a fifth `**Claim**:` to `good-claims.md` with no `**Grounding**:` line.
- Delete the `npm run evidence` line from `.github/workflows/ci.yml` and re-run step 10.
  The invariant that was passing becomes an error, because nothing reaches the
  command it names any more.

## Regenerating the artifact

The id is a hash of the command, the commit and the output, so it is
deterministic and it is **not** guessable - the fixtures here were built by
running the command and copying the real id, never by inventing one.

```js
import { artifactId, formatArtifact } from 'evidence-layer'
```

The output of `npm test` includes a duration, so re-running produces a
different id. That is correct: a different run is different evidence. If you
regenerate, update the fence and every tag that addresses it together, which is
what `npx evidence-layer claims` is there to check you did.

## In CI: gather, review, verify

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) is laid out so that each
command runs once, in parallel where nothing waits on it, and a model spends
tokens only on reading:

| Job | Runs | Waits on | Required |
| --- | --- | --- | --- |
| `evidence` | `npm run evidence` against the base branch - the suite, once, inside the gather; uploads `evidence.local.md` and `change.diff`, and puts the bundle in the job summary for the human reviewer | nothing | yes - it fails when the suite does |
| `governance` | `evidence-layer governance --enforce` through the action | nothing | yes |
| `review` | on a pull request that is not a draft: a model reads the bundle, the diff and the files - no shell, so nothing re-run - and writes `ai-review.md` from the bundle's suggested claims; `claims --bundle --fix` marks what the bundle does not back UNVERIFIED; the action checks it against the bundle and the head SHA; it is posted as a comment | `evidence` passing | no |

The `review` job holds the model's blocks to the bundle `evidence` uploaded, not
to anything in its own job, so the evidence stays CI's: a block the model typed
or edited is `bundle/not-gathered` or `bundle/edited`, and `--fix` turns the
claim UNVERIFIED before anyone reads it - correcting it costs no second model
turn. A red suite costs no tokens at all: `review` runs only once `evidence`
passed.

To use it, in a repository of its own:

- Depend on evidence-layer from the registry, not `file:../..`, and commit the
  lockfile. The `bundle` input and the gather's exit code need the release that
  added them; the action ref names it.
- Make `evidence` and `governance` required status checks: Settings > Rules >
  Rulesets > Require status checks to pass. Nothing in the repository can make
  a check required, and `governance` cannot tell a required job from an
  optional one - it only reads that a workflow runs the command.
- For `review`, add an `ANTHROPIC_API_KEY` secret, and optionally a
  `REVIEW_MODEL` variable (default `claude-haiku-5-5`: copying a claim and its
  block needs no stronger model). Pull requests from forks get neither secrets
  nor a token that can comment, which is why `review` is not required.
- The default branch is `main`; change `branches:` if yours is not.

### Before you push: `npm run ci:local`

`npm run ci:local` runs the workflow's jobs on your machine, in the order and
shape CI runs them, and ends with what CI would report:

```text
=== what CI would report ===========================================
  evidence    required  pass
  governance  required  pass
  review      optional  pass - review from the model
```

- `evidence` and `governance` run side by side; `review` runs only once
  `evidence` passed, as `needs: evidence` makes it.
- The review's checks read the bundle from a separate directory - the
  "artifact" - not from the working tree, so a review that cites a block the
  gather did not write, or edits one, fails here exactly as it would in CI.
- The model step is read out of the workflow - its `prompt`, `claude_args` and
  `settings` - not kept as a second copy, so it cannot drift from what CI asks.
  It needs the `claude` command (Claude Code) on PATH and spends tokens as the
  CI job does. `REVIEW_MODEL=claude-sonnet-5-5 npm run ci:local` stands in for
  the repository variable.

Run it in a repository of its own - `npm run standalone` makes one from this
template; inside evidence-layer's checkout it refuses, because git would answer
for evidence-layer. Commit the change first: it gathers from the working tree,
where CI gathers from the commit, and says so when the two differ.

| Command | What it runs |
| --- | --- |
| `npm run ci:local` | every job, the review by the model - against `origin/main`, or `main` when there is no remote |
| `npm run ci:local -- --base <ref>` | the same, against the base you name |
| `npm run ci:local -- --review-skeleton` | the review is the bundle's own suggested claims - what the model is asked to copy - so the whole pipeline runs with no model and no tokens |
| `npm run ci:local -- --review notes.md` | the review is a file you wrote, checked as CI would check the model's |
| `npm run ci:local -- --no-review` | the two required jobs only |
| `npm run ci:local -- --pipeline azure` | any of the above, with the review step read from `azure-pipelines.yml` instead of the GitHub workflow - the default when the workflow is not there |

It exits 0 when every job that ran passed, 1 when one failed, and 2 when it
could not run - a bad option, no repository of its own, or a review step in the
pipeline it cannot read. A model step on an empty diff is skipped rather than
paid for. What it leaves behind - `evidence.local.md`, `change.diff`,
`ai-review.md` - is ignored by git, and the summary prints where the "artifact"
copy is.

What it does not reproduce: a fresh checkout and `npm ci` (it uses your working
tree and `node_modules`), the pull request comment (it prints the review
instead), and required checks, which only the repository's settings make.

### In Azure Pipelines

[`azure-pipelines.yml`](azure-pipelines.yml) is the same three jobs for a
project on Azure DevOps, with the same handoff: `evidence` publishes the
bundle as a pipeline artifact, `review` downloads it and holds the model's
review to it with `claims --bundle --format azure`, which logs every finding
as an issue on the step.

One thing has to be built differently. Azure Repos runs a pipeline on a pull
request only through a build validation branch policy, and that policy is
required or optional for the whole pipeline - so it cannot require
`evidence` and `governance` without requiring `review`. Each job instead
posts its own pull request status through
[`scripts/azure-pr.mjs`](scripts/azure-pr.mjs) - pending when it starts, its
outcome when it ends, on the pull request iteration whose head is the commit it
built - and the branch policy requires the statuses:

- Create a pipeline from `azure-pipelines.yml`.
- On the target branch's policies, add **Build validation** for that pipeline,
  marked **Optional**, so it runs on every pull request without its review
  blocking one.
- Add **Status checks** for `evidence-layer/evidence` and
  `evidence-layer/governance`, marked **Required** (each appears once a run
  has posted it). Leave `evidence-layer/review` optional.
- Allow the project's build service to **Contribute to pull requests** on the
  repository, so `System.AccessToken` can post statuses and the review.
- For `review`, add an `ANTHROPIC_API_KEY` secret variable, and optionally a
  `REVIEW_MODEL` variable (default `claude-haiku-5-5`).

`npm run ci:local -- --pipeline azure` reads the model step out of
`azure-pipelines.yml` - the words of its `claude -p` script, as the shell
would split them, with `${REVIEW_MODEL:-claude-haiku-5-5}` taken from your
environment - so the local review asks what the pipeline asks. It does not
post statuses or the review, and a draft pull request is reviewed where Azure
does not tell the pipeline it is one.

## Using it on your own project

Nothing above is specific to this fixture except the paths:

```bash
npm install --save-dev evidence-layer
npx evidence-layer governance            # start here - it needs no setup at all
npx evidence-layer claims your-review.md
npx evidence-layer init claude           # and/or: init codex - the runtime gate
```

Then copy [`scripts/evidence.mjs`](scripts/evidence.mjs) and change the
commands to your project's, and copy [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
as [below](#in-ci-gather-review-verify) describes. A project whose
tests are not `node --test` swaps `summariseNodeTest` for `summariseJUnit`,
`summarisePytest` or `summariseVitest` from the same adapter.

`governance` and `ci-summary` need no configuration. `claims` and `receipt`
need a review written in the grammar the fixtures above demonstrate. Anything
that asserts a fact about *your* project - a route existing, a dependency
pinned, a build under budget - is yours to write, and
[`scripts/check-docs.ts`](../../scripts/check-docs.ts) in this repository is the
worked example of what that looks like.
