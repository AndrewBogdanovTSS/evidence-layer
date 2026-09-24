# Review: decision records and dependencies get a clock - VALID RECEIPT

> Fixture. Run `pnpm demo:setup` once, then
> `pnpm check:receipt demo/reviews/good-receipt.md --repo .`
>
> The receipt below is the first block of the review, above any verdict,
> because a reader has to see where the review was written from before they
> see what it concluded.
>
> This review cites three files, so its Sample integrity table has **three**
> rows, one per cited file - see `demo/reviews/bad-receipt.md` for what it
> looks like when only one file is quoted and it is not one of the files the
> review is actually about. That file keeps the older one-line-per-quote form,
> which the checker still reads.

## Access Receipt

**Repo path**: the local clone this file lives in
**Branch**: demo-review
**HEAD SHA**: f7cf753276f45c35003043fdb945d0fc1f8e4764
**Target branch**: demo-target
**Base SHA**: 572a258a2871f88d84eb6836d4e4cf96618f3de9
**Diff stat**: 22 files changed, 1009 insertions(+), 62 deletions(-)
**Files in diff**: 22
**Files opened during review**: 22
**Tools used**: git, ripgrep, the local test suite

**Sample integrity**:

| File | First non-blank line |
|---|---|
| `test/decision-hygiene.test.ts` | `import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'` |
| `test/proc.test.ts` | `import { describe, expect, it } from 'vitest'` |
| `README.md` | `# evidence-layer` |

Every field above is a literal value. Nothing here is a summary, an
impression, or a promise: a reader can re-derive each one by running the same
command against the same commit, and the checker does exactly that.

The base is the merge-base with `origin/demo-target`, not the tip of the local
branch of the same name. Those two values differ by ten commits in this clone,
and the difference is the whole of `demo/reviews/bad-receipt.md`.

The sample integrity rows are the cheapest of the checks and the hardest to
fake. Quoting the first non-blank line of a file you did not open requires
guessing it, and nobody guesses an import list verbatim - including the order
of the names inside the braces.

## Findings

**Claim**: a decision record that has passed its review date is reported as
stale rather than quietly staying green.
**Grounding**: VERIFIED

```artifact
$ pnpm vitest run test/decision-hygiene.test.ts
 Test Files  1 passed (1)
      Tests  7 passed (7)
exit: 0
```

The cases live in `test/decision-hygiene.test.ts:12`, which is the file this
receipt quotes first.

**Claim**: the process runner reports a command that could not be spawned as a
distinct outcome, not as a non-zero exit.
**Grounding**: DOCUMENTED - `test/proc.test.ts:40` pins the behaviour, and the
module header above it says why the two cases must not be collapsed.

**Claim**: the README's own description of the layer matches what the package
now ships.
**Grounding**: DOCUMENTED - `README.md:26` states the claim that
`pnpm check:docs` re-derives on every run.

Every citation in this review resolves at the commit named above. A citation
that does not resolve is the signature of a review that was assembled rather
than read.
