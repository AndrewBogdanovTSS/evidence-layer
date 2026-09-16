# Review: decision records and dependencies get a clock - DELIBERATELY BROKEN RECEIPT

> Fixture. Run `pnpm demo:setup` once, then
> `pnpm check:receipt demo/reviews/bad-receipt.md --repo .`
>
> This is the same review as [`good-receipt.md`](./good-receipt.md) with a
> baseline that has gone stale, a file quoted that none of its own claims
> cite, a second file quoted approximately rather than verbatim, and two
> citations that do not resolve.
>
> Read it before running anything. It looks completely normal, which is the
> entire problem: nothing below is malformed, mistyped, or obviously lazy.

## Access Receipt

**Repo path**: the local clone this file lives in
**Branch**: demo-review
**HEAD SHA**: f7cf753276f45c35003043fdb945d0fc1f8e4764
**Target branch**: demo-target
**Base SHA**: 89853d19b85eb26c6941bf3117f9ab70007a1754
**Diff stat**: 29 files changed, 1544 insertions(+), 90 deletions(-)
**Files in diff**: 29
**Files opened during review**: 9
**Sample integrity**: `src/core/proc.ts` -> `/**`
**Sample integrity**: `test/node-default.test.ts` -> `import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'`
**Tools used**: git, the pull request page

Four things are wrong here and not one of them is visible by reading.

The **base** was taken from the local branch named `demo-target`, which is ten
commits behind its remote. That is not a typo or a shortcut - it is what the
obvious command produces when the local branch has not been pulled. The
resulting diff is *larger* than the change under review: 29 files and 1544
insertions instead of 22 and 1009. Nothing looks missing, and the review's own
file counts still agree with each other. An ancestry check passes this
receipt, because a stale tip is still an ancestor of the mainline.

The **first sample** quotes a file the review never cites. Quoting
`src/core/proc.ts` proves *a* file was opened; it says nothing about the files
this review actually talks about. It is also the cheapest line in the
repository to quote, because almost every source file here opens with the same
comment marker - which is the point. A requirement satisfied by the cheapest
available file is not a requirement.

The **second sample** is close to the real line but not identical: the names
inside the braces are in the wrong order, copied from the neighbouring test
file rather than from the one being quoted. Close is the tell. A file that was
really opened gets quoted exactly; a file reconstructed from memory of what
such a file usually says gets quoted approximately.

The **coverage** line admits 9 files opened against 29 in the diff and offers
no reason - a warning rather than an error, because skipping generated files
is legitimate and skipping silently is not.

## Findings

**Claim**: the dependency clock is wired into the adapter rather than the core.
**Grounding**: DOCUMENTED - see `test/node-default.test.ts:31`, which exists,
and is the file this receipt quotes incorrectly.

**Claim**: nothing outside the checked modules was touched.
**Grounding**: DOCUMENTED - see `src/core/nowhere.ts:12`, which does not exist
at the reviewed commit.

**Claim**: the process runner keeps spawn failures separate from exit codes.
**Grounding**: DOCUMENTED - see `test/proc.test.ts:9000`, a line number well
past the end of a 65-line file.
