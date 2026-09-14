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
   at code you care about.

## The tour

Run these from the root of this repository. Each takes seconds.

### 1. A review whose claims are backed

```bash
npx evidence-layer claims examples/plain-node-project/reviews/good-claims.md
```

Four claims, four tags, exit 0. One is `VERIFIED[tests-9aefa5]` and addresses
the artifact block below it; one is `DOCUMENTED` and cites a file; one is
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

### 5. Is anything actually running the checks?

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

### 6. Render a run for CI

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
- Change one digit of the id in the fence (`artifact:tests-9aefa5`) without
  changing the tag. Both halves are now phantoms.
- Add a fifth `**Claim**:` to `good-claims.md` with no `**Grounding**:` line.
- Delete `- run: npm test` from `.github/workflows/ci.yml` and re-run step 5.
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
```

`governance` and `ci-summary` need no configuration. `claims` and `receipt`
need a review written in the grammar the fixtures above demonstrate. Anything
that asserts a fact about *your* project - a route existing, a dependency
pinned, a build under budget - is yours to write, and
[`scripts/check-docs.ts`](../../scripts/check-docs.ts) in this repository is the
worked example of what that looks like.
