# demo/

The four demos the talk runs, in slide order, with the fixtures they need.

Everything here is either wrong on purpose or a reference this repository's own
history cannot produce by itself. Each file says at the top what it is and what
is wrong with it. Read them before running the checkers: the point of these
fixtures is that they look completely normal.

## Setup

One command, once per clone - and again any time a `git fetch` has rewritten
`refs/remotes/origin/*`. It is cheap and idempotent:

```bash
pnpm demo:setup
```

It creates a local `demo-target` branch parked on the first commit and an
`origin/demo-target` ten commits ahead of it, so the receipt fixtures have a
baseline that has genuinely gone stale. Nothing touches `master`, and every
ref it creates is named `demo-*`. Remove them with `pnpm demo:reset`.

Only demo 3 needs this. Demos 1, 2 and 4 run on a clean clone.

## The demos

### 1 - the claim linter

```bash
pnpm check:claims examples/plain-node-project/reviews/bad-claims.md
pnpm check:claims examples/plain-node-project/reviews/good-claims.md
```

A tag with nothing behind it, a citation-free `DOCUMENTED`, a chain-free
`INFERRED`, an untagged claim, an unfalsifiable comparison and one line of
flattery - then the same review repaired. The repaired one is longer, hedges
more, and is the only one of the two that could be proved wrong.

The fixtures live under `examples/`, not here, because they are also the
worked example a consumer of this package reads first. `pnpm check:all` asserts
that each one still exits the code it is supposed to: a check nobody has seen
fail is indistinguishable from a check that cannot fail.

### 2 - gathering the bundle

```bash
pnpm evidence --base origin/master
pnpm evidence --base origin/master --head 6d2adf6
```

Run from inside this repository - gathering is dev tooling, not part of the
published CLI. The first writes `evidence.local.md`: the diff summary, git
status, a lockfile check, the lint, the typecheck and the tests, each as its
own artifact block, with any skipped step recorded *as skipped*. The second is
refused, because the working tree is not at the commit being asked for.

### 3 - equality, not ancestry

```bash
pnpm demo:setup
pnpm check:receipt demo/reviews/bad-receipt.md --repo .
pnpm check:receipt demo/reviews/good-receipt.md --repo .
```

| File | What it shows |
|---|---|
| `reviews/bad-receipt.md` | a baseline taken from a stale local branch, a file quoted that none of the review's own claims cite, a second file quoted approximately rather than verbatim, and two citations that do not resolve |
| `reviews/good-receipt.md` | the same review with a receipt that holds, carrying one verbatim quote per file it actually cites |

The headline is the baseline. `demo-target` is ten commits behind
`origin/demo-target`, so the stale base inflates the diff from 22 files and
1009 insertions to 29 and 1544 - and every one of those ten commits is
attributed to the branch under review. It fails in the reassuring direction,
because the diff comes out *bigger*, so nothing looks missing. An ancestry
check waves it straight through: a stale tip is still an ancestor of mainline.

Run `pnpm check:receipt demo/reviews/bad-receipt.md --repo .` **before**
`pnpm demo:setup` to see the other half of the slide. With no
`origin/demo-target` in the clone the baseline check reports `unverifiable`,
not `pass`. Three outcomes, never two: a checker that passes when it could not
run manufactures confidence out of nothing.

### 4 - is anything running the checks?

```bash
pnpm check:governance --repo examples/plain-node-project
```

Two invariants in the example project read as enforced. One names `npm test`,
which is reachable from the CI workflow. The other is "enforced by a human",
which names no runnable command, so its enforcement cannot be checked - and it
is reported that way rather than passed.

`npx evidence-layer governance --repo examples/plain-node-project` is the same
command for a consumer who has the package installed. Inside this repository
the bin is not linked into `node_modules/.bin`, because the package does not
depend on itself, so `check:governance` runs the source entry point directly.

## Why keep broken files around

Two reasons.

The obvious one: a checker is easier to understand when you have watched it
fire.

The less obvious one: **a check nobody has seen fail is indistinguishable from
a check that cannot fail.** These fixtures are regression tests for the
checkers themselves. If `bad-receipt.md` ever starts passing, something in the
receipt checker quietly stopped working, and without this file nobody would
find out until it mattered.

## When the history moves

The receipt fixtures name specific commits, and so does `demo/refs.mjs`. If
one of them no longer resolves, `pnpm demo:setup` says so and stops, and the
checker reports the mismatch rather than passing quietly - which is the
behaviour you want, and also mildly inconvenient.

Regenerate the values by copying the current ones in, never by typing a
plausible-looking line from memory:

```bash
git rev-parse HEAD
git merge-base origin/demo-target HEAD
git show HEAD:test/proc.test.ts | head -1
```

Quote that last line **exactly**. While writing these fixtures the sample
integrity check caught a line whose import names had been copied from the
neighbouring test file in the right spirit and the wrong order - which is
precisely the failure the check exists for, and it is still in
`bad-receipt.md` on purpose.
