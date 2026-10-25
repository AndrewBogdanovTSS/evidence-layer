# AGENTS.md

The source of truth for anyone - person or agent - changing this repository.
There is deliberately no `CLAUDE.md`: Claude Code (2.1.277 and later) reads
this file itself when none exists, and one would stop it from doing so.

`evidence-layer` is a zero-runtime-dependency Node 22+ package of checks that
turn a review's assertions into claims that could be proved wrong. It is its
own first consumer: every check runs against this repository too.

## Before you push

```bash
pnpm install --frozen-lockfile
pnpm typecheck               # the one step check:all does not run
pnpm check:all --enforce     # pnpm test (builds, then runs the suite - the CLI tests
                             # run dist/), every repository check, plus: does
                             # anything run them?
```

`check:all` runs the suite once and hands its output to `check:docs`, so there
is no need to run `pnpm test` first; on its own, `pnpm check:docs` runs the
suite itself.

`pnpm hooks:install` wires the same fast checks into a pre-push hook.

The runtime gate runs here too: `.claude/settings.json` (written by
`evidence-layer init claude`, which notices it is in its own repository) runs
the plugin's launcher, which runs this checkout's `dist/`. So the gate is the
code of the last `pnpm build`, not of the working tree, and a fresh clone says
the gate is inactive until it is built.

`pnpm check:docs` (part of `check:all`) compares the README's sentence "The
suite is **N tests** across **M files**" with the real suite. When you add or
remove tests, update that sentence in the same change. It also holds the
action ref the README and the example's workflow show
(`uses: ...evidence-layer@vX.Y.Z`) to package.json's version; `pnpm release`
rewrites those in the release commit, so only a bump by hand has to.

`examples/plain-node-project/` is a template here, not a repository: git, and
so its hooks and its seal, answer for this checkout. `npm run standalone` in it
makes the copy where they work, and `test/example.test.ts` runs on that copy.
Its workflow does not run here either - GitHub reads only the top level - so
the `example-evidence` and `example-review` jobs in `.github/workflows/ci.yml`
run its gather-then-verify handoff on such a copy. A change to how the
example's workflow hands the bundle over changes those jobs too, and
`scripts/ci-local.mjs` (`npm run ci:local`, which reads the review step out of
the workflow) must still read it - `test/example.test.ts` holds it to that.

## Rules the tests enforce

- `src/core/` imports only `node:*` builtins and its own siblings - no project's
  stack, no adapters, no hosts (`test/boundary.test.ts`).
- `src/hosts/` imports only builtins, `../core/*` and `./contract`.
- No runtime dependencies (`check:docs`, and CI's smoke job runs the build on
  bare `node`). The published tarball carries `dist/`, the README and the
  licence, nothing else (`test/bin.test.ts`).
- Text from a review, a receipt or a host's input never reaches a shell: call
  git through `git()` / `gitCapture()` in `src/core/proc.ts`, never by
  concatenating it into `run()` or `capture()`. `test/injection.test.ts` holds
  `receipt` to it with hostile branch names and paths, and
  `test/host-injection.test.ts` holds every hook event of both hosts to it,
  with a payload in each field the agent writes and a working directory named
  `$(...)`. `init` refuses a `--review` value a shell would interpret, since it
  goes onto the hook's command line. Nothing scans for a new concatenation, so
  a new call site is on review.
- Five outcomes, never collapsed: `pass`, `warning`, `error`, `unverifiable`,
  `flaky`. A check that could not run is `unverifiable`, not a pass. Exit codes:
  0 clean, 1 error, 2 bad usage, 3 flaky - except `evidence-layer hook`, which
  always exits 0 and speaks the host's protocol.

## How code here is written

- Every module opens with a header saying which claim it makes falsifiable and
  what it deliberately does not do. Keep that header true when you change the
  module.
- Comments explain why, especially why the obvious alternative was rejected.
  Match the density and voice of the file you are in.
- The honest path must be cheaper than the convenient one. A feature that makes
  a correct review cost more than an unbacked one does not ship in that form.

## Commits

- Conventional prefixes: `feat:`, `fix:`, `docs:`, `test:`, `ci:`,
  `chore(release):`.
- `Ladder-Rung: <1-5> <what>` names the rung of the decision ladder the change
  stopped at (1 does it need to exist, 2 reuse what is here, 3 the platform does
  it, 4 an installed dependency does it, 5 write the minimum) - checked by
  `pnpm check:ladder`, which CI runs on every commit a push or pull request
  brings. On rungs 2 to 4 the word after the verb is read as a name - the
  symbol reused, the dependency used (`2 reuse formatWorkSummary`) - and must
  appear in the diff, so prose there fails the check. Rungs 1 and 5 are
  judgement and report `unverifiable`, and a commit with no trailer only
  warns, so the check catches a wrong trailer, not a missing one. A function
  that is an existing one renamed fails it whatever the trailer says. Run it
  on your commit before you push it.
- `Missed-By: <review or PR>` on a commit that fixes a bug a review let through.
  `governance` extracts these into `journal.jsonl`; that count is the layer's
  only measure of what reviews miss.

## Decisions and plans

- `docs/decisions/NNNN-*.md` are decision records. Their frontmatter lists
  `invariants`, each ending "enforced by \`pnpm <script>\`" - `governance`
  checks that a git hook or CI workflow actually runs that script - plus a
  `review_by` date that must not pass. A superseded record moves to
  `docs/decisions/archive/`.
- `docs/plans/` holds designs, reviews of them and implementation reports - the
  reasoning behind a decision record, kept so it can be re-read later.

## Releases

`pnpm release [patch|minor|major]` checks, bumps, commits, tags and pushes; the
tag starts `.github/workflows/release.yml`, which publishes to npm with
provenance and creates the GitHub Release. Nothing is published from a
laptop. A release that changes what users must do carries notes in
`docs/releases/v<version>.md`, committed before the release; the workflow puts
them ahead of the generated commit list.

## Documents

Every document in this repository - code comments, docs, release notes, commit
messages - is written in English.
