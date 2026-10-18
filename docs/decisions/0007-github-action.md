---
id: DEC-0007
status: accepted
date: 2026-10-18
supersedes: null
invariants:
  - Review text printed under `--format github` never reaches the runner as a workflow command - annotation values are escaped as the runner un-escapes them, and the human report runs under `::stop-commands::` with a token chosen per run; enforced by `pnpm test`.
  - The action never passes a step it could not run - nothing to check, a missing review, an installed package that cannot write annotations, an unbuilt checkout of this package, or a version that is not exact is misconfigured, exit 2, ranked above a failure; enforced by `pnpm test`.
  - The action runs the evidence-layer the project installed when there is one, and otherwise an exact version, never `latest`; enforced by `pnpm test`.
  - The inputs `action.yml` declares are exactly the inputs the action reads; enforced by `pnpm test`.
review_by: 2027-10-18
enforce_owner: Andrii Bohdanov
---

# DEC-0007: one workflow step, annotations on the lines, and nothing that can be told what to do by a review

## Context

Running the checks in GitHub Actions has meant a `run:` step and a reader who
opens the log: a red cross on the job, and the reason somewhere in the text.
[`evidence-layer-development-strategy.md`](../plans/evidence-layer-development-strategy.md)
ranks a ready-made Action as P0 - "onboarding through a single workflow step",
with per-claim annotations - and DEC-0006's reason codes are what make the
annotations more than a sentence: each one is titled by the rule that failed.

The obvious way to annotate is the runner's workflow commands, and they come
with a hazard. The runner reads every line a step prints for `::command::`,
and what this package prints is a review's own text - written by an agent, or
by the author of a pull request from a fork. A claim that reads
`::add-mask::...`, or a Sample integrity quote that ends a line and starts a
command on the next, would be obeyed.

## Decision

1. **`--format github`** on `claims`, `receipt` and `governance`: one
   annotation per finding that is not a pass - `error` for errors, `warning`
   for warnings, `unverifiable` and `flaky` (titled so, because "nobody could
   check this" must not read as a nit) - then the usual text report, then a
   job summary when `GITHUB_STEP_SUMMARY` is set. The exit code is unchanged.
2. **Review text is data.** Every value in a command is escaped the way the
   runner un-escapes it, so a newline cannot start a second command. The text
   report, which quotes the review freely, runs under
   `::stop-commands::<token>`, with a token from `crypto.randomBytes` that the
   review cannot know in advance.
3. **No API calls.** Annotations made by workflow commands land on the job's
   own check run, for the commit the job ran on, with no token and no
   permission to request. A separate Check Run would need `checks: write` and
   would be a second account of the same result.
4. **The Action is a launcher, not a copy.** `action.yml` at the repository
   root runs `action/run.mjs` on `node24`: plain Node, no dependencies, no
   build, because an action runs from the repository at the ref the workflow
   names and `dist/` is not committed. It runs the evidence-layer the project
   installed; failing that, this checkout's build when the project is
   evidence-layer itself; failing that, `npx evidence-layer@<the version this
   action was released with>`. A copy of the checks inside the action would be
   a second build of the package, published without the npm release's
   provenance.
5. **Capabilities, not versions.** `package.json` declares
   `"outputFormats": ["text", "json", "github"]`; an installed package that
   does not list `github` would ignore the flag and print plain text, so the
   action refuses it and says to upgrade - the rule the plugin's launcher
   already follows for `hookProtocol`.

## Why not

- **SARIF and code scanning.** Annotations need nothing enabled and show on
  the pull request's diff; code scanning needs `security-events: write` and,
  for a private repository, a paid plan. SARIF output is a mapping from the
  same codes when someone needs it.
- **A gather step in the action.** CI gathering its own evidence is the
  independent party DEC-0005 relies on, but what to run is the project's own
  script; the action checks what a review cites.
- **A floating `v0` tag.** A workflow names an exact release, `@v0.7.0`, and
  gets that release's checks; moving a tag under people is what this package
  asks reviews not to do.

## Consequences

- `uses: AndrewBogdanovTSS/evidence-layer@v0.7.0` is the whole setup for a
  project that writes `review.md`. `receipt` needs a full clone and the target
  branch fetched; the input's description says so.
- This repository's CI runs the action on a fixture review with `uses: ./`, so
  the action and the checks of the same commit are tested together.
- GitHub caps how many annotations it shows for a step; every finding is also
  in the log and in the job summary, which list them all.
