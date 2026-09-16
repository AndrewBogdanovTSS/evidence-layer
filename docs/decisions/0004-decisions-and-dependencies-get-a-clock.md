---
id: DEC-0004
status: accepted
date: 2026-09-16
supersedes: null
invariants:
  - Every decision record accepted in docs/decisions/ carries a review_by date that has not passed, or is filed under archive/; enforced by `pnpm check:all`.
  - Every dependency this package declares in package.json is referenced somewhere in its own source, or explicitly exempted with a reason a reader can check; enforced by `pnpm check:deps`.
review_by: 2027-09-16
enforce_owner: Andrii Bohdanov
---

# DEC-0004: the exceptions clock is not just for exceptions

## Context

`docs/governance-exceptions.md` exists because of one rule: an exception with
no expiry is not a valid exception, and an expired one is a finding on every
run, forever, until someone looks at it again. [DEC-0002](archive/0002-evidence-layer-v2.md)
built that rule because warn-only governance needed a place for legitimate
bypasses to live without quietly becoming permanent. It worked because the
date is checked, not trusted.

Extending `pnpm evidence` to gather more of a project's own state - a working
tree status, a lockfile check, an optional coverage summary, an opt-in
dependency audit - turned up two more places the same gap was still open,
both a short walk from checks this package already ships:

1. **A decision record makes the identical promise about itself that an
   exception does**, in the same frontmatter `readInvariants` already reads.
   Every record here carries `review_by`. Nothing checked it. An `accepted`
   record whose review date had quietly passed while it sat in the directory
   `readInvariants` treats as live would be indistinguishable from one still
   current - the exact failure mode the exceptions file was built to close,
   just one document type further up.

2. **"Zero runtime dependencies" is a claim `check:docs` already checks -
   but nothing checked the other side**: that every devDependency this
   package carries is actually used for something. An unused dependency is a
   smaller risk than a wrong test count, but it is the same shape of claim -
   asserted once, in a lockfile nobody re-reads - and this package does not
   get to exempt its own manifest from the standard it holds a README to.

## Decision

1. **`checkDecisionHygiene`**, new in `src/core/decision-hygiene.ts`, portable
   core alongside `governance.ts` and `exceptions.ts` rather than folded into
   either: it reads the same frontmatter `readInvariants` does but asks a
   different question ("is this record itself still current," not "is its
   invariant reachable"), which is what earned exceptions their own file
   instead of a function inside `governance.ts`. Wired into
   `evidence-layer governance` (so every consumer gets it for free, the same
   way `checkExceptions` already rides that command) and into this
   repository's own `check:all`.

2. **`pnpm check:deps`**, new in `scripts/check-deps.ts` - repository
   business, not portable: "is this import used" depends on how a project
   imports things, which is exactly why `check-docs.ts` lives here and not in
   `src/core/`. It treats "no textual reference found" as a `warning`, never
   an `error` - a heuristic over free text is weaker evidence than a command
   that actually failed, and a dependency invoked only as a config flag to
   another tool (this package has one: `@arethetypeswrong/core`, turned on as
   `attw: true` in `tsdown.config.ts`) is real, explained, and checked against
   that flag rather than exempted unconditionally.

3. **`pnpm evidence`'s bundle grows three sections and one step**, none of
   them gated the way lint/typecheck/test are, because none of them makes the
   same kind of claim: the working tree's own `git status`, since
   lint/typecheck/test read the tree as it sits and not the diff, and
   whatever sits on top of the reviewed commit shapes their result without
   ever appearing in it; a lockfile check (`pnpm install --frozen-lockfile
   --lockfile-only`, which touches neither `node_modules` nor the lockfile
   itself - `--dry-run` was the first thing tried and does not exist on
   `pnpm install`, caught by actually running it rather than assumed), planned
   by default and skipped honestly when there is no `pnpm-lock.yaml` to check;
   a coverage summary, parsed out of whatever the
   test step already printed if a caller supplies a parser, never run for its
   own sake; and `pnpm audit`, opt-in only, because unlike everything else
   gathered here its result can change with no code change at all - a new
   advisory against an unpinned transitive dependency - which is a different
   claim than "this command passed against this diff."

## Consequences

- Two more findings appear on `evidence-layer governance` and this
  repository's `check:all`. Both are currently clean:
  [`0003-evidence-layer-as-a-package.md`](0003-evidence-layer-as-a-package.md)'s
  `review_by` is not due until 2027, and `pnpm check:deps` passes on every
  current dependency - some by the convention-based exemptions above, the
  rest found directly in this repository's own text.
- The portability fixture's decision record
  ([`examples/plain-node-project/docs/decisions/0001-example.md`](../../examples/plain-node-project/docs/decisions/0001-example.md))
  gained a `review_by` dated comfortably in the future, for the same reason
  every other accepted record needs one: it demonstrates reachability, not
  staleness, and a permanently-erroring worked example would teach the wrong
  lesson before line one of its own README.
- `pnpm evidence`'s bundle is bigger by default (a working-tree block and a
  lockfile step, always; coverage and an audit, only when asked for), which
  is the same tradeoff every prior addition to gathering made: more to read
  once, so a review has less it can plausibly have missed.
- No consuming project's `package.json` needs to change. The new evidence
  sections and the lockfile step are part of `gatherEvidence`'s zero-config
  default; `checkDecisionHygiene` rides the existing `governance` command;
  `check:deps` is this repository's own script, same as `check:docs`, and
  nothing about its shape asks any other project to adopt it.
