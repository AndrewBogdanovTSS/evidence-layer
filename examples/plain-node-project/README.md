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
   | [`scripts/evidence.mjs`](scripts/evidence.mjs) | gathers the evidence before a review is written: runs `npm test`, appends Node's test counts as a work summary, seals the run |
   | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | the suite, then the GitHub Action over the change's `review.md` and the decision records |
   | [`.claude/settings.json`](.claude/settings.json), [`.codex/hooks.json`](.codex/hooks.json) | the runtime gate, written by `evidence-layer init claude` and `init codex` |
   | [`scripts/standalone.mjs`](scripts/standalone.mjs) | `npm run standalone`: copies this project out as a repository of its own - see below. Not part of the setup; the copy leaves it behind |

   The setup is for a project that is its own repository, and inside
   evidence-layer's checkout this one is not. git answers every question from
   the top level, which here is evidence-layer's, so both hosts' hooks would
   check evidence-layer's `review.md` and keep their state in its `.git` - the
   Codex command would not even find the package, which it looks for from
   there - and a sealed run would fingerprint the whole checkout. So the
   runtime gate and the seal are shown in a copy (step 0); every other step
   runs from here.
   | [`docs/decisions/0001-example.md`](docs/decisions/0001-example.md) | two invariants, one enforced by a command and one by "a human" |

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

### 6. Is anything actually running the checks?

```bash
npx evidence-layer governance --repo examples/plain-node-project --decisions examples/plain-node-project/docs/decisions
```

[`docs/decisions/0001-example.md`](docs/decisions/0001-example.md) declares two
invariants. One names `npm test`, which
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs - reachable, pass.
The other is enforced "by a human", which names no command at all - a warning,
because an invariant nothing can run is decoration, and the check says so
rather than guessing.

Note the npm shorthand: the workflow says `npm test`, not `npm run test`. That
case was found by building this fixture, not assumed - a scanner that only knew
`npm run <name>` reported the script as unreached in the most common project
layout there is.

### 7. The same findings, for a program

```bash
npx evidence-layer claims examples/plain-node-project/reviews/bad-claims.md --format json
npx evidence-layer claims examples/plain-node-project/reviews/bad-claims.md --format github
```

`json` is one document - every finding with a stable `code` such as
`claims/untagged` - and `github` turns each finding into an annotation on the
review's line, which is what the action in this project's workflow does. The
exit code is the same in every format.

### 8. Render a run for CI

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
- Delete `- run: npm test` from `.github/workflows/ci.yml` and re-run step 6.
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

## Using it on your own project

Nothing above is specific to this fixture except the paths:

```bash
npm install --save-dev evidence-layer
npx evidence-layer governance            # start here - it needs no setup at all
npx evidence-layer claims your-review.md
npx evidence-layer init claude           # and/or: init codex - the runtime gate
```

Then copy [`scripts/evidence.mjs`](scripts/evidence.mjs) and change the
commands to your project's, and add the action to your workflow as
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) does. A project whose
tests are not `node --test` swaps `summariseNodeTest` for `summariseJUnit`,
`summarisePytest` or `summariseVitest` from the same adapter.

`governance` and `ci-summary` need no configuration. `claims` and `receipt`
need a review written in the grammar the fixtures above demonstrate. Anything
that asserts a fact about *your* project - a route existing, a dependency
pinned, a build under budget - is yours to write, and
[`scripts/check-docs.ts`](../../scripts/check-docs.ts) in this repository is the
worked example of what that looks like.
