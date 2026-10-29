# Azure DevOps integration - plan

Status: phases 1-3 built (PRs #8, #9, #10); the consumer phases redesigned 2026-10-29 around a
central review pipeline.

The goal: what GitHub CI and the two `ci:local` scripts do for this repository and its example, a
project on Azure DevOps gets too - CI gathers the evidence itself, a review is held to the bundle
CI gathered, and a developer can run the same jobs locally before pushing and get the same verdict.
The phases after 3 are written for the shape such a project's CI commonly takes in an organisation
(section 1.5), not for any one repository.

## 1. What exists today

### 1.1 This repository's `pnpm ci:local` (`scripts/ci-local.ts`)

- Mirrors `.github/workflows/ci.yml` job by job, in two phases: typecheck | `check:all --enforce` |
  `check:ladder` per new commit, side by side; then smoke | the action on a fixture review | the
  example's handoff, because those read the `dist/` that `check:all` rebuilds.
- `LOCAL_JOBS` maps each local job to the CI jobs it stands for; `NOT_REPRODUCED` names the ones it
  cannot run (`action-from-npm`). `test/ci-local.test.ts` holds both lists to the workflow, so a CI
  job added without a local counterpart fails the suite.
- Reports through the package's own `report()`: the Node matrices and `action-from-npm` are
  `unverifiable`, never a pass; a dirty tree is a `warning`.

### 1.2 The example's `npm run ci:local` (`examples/plain-node-project/scripts/ci-local.mjs`)

- Plain JS (portability fixture). Refuses to run inside this checkout - only in a standalone copy.
- Runs `evidence` and `governance` side by side, then `review` only when `evidence` passed.
- Copies the bundle and `change.diff` to a separate temp directory, the way the evidence job uploads
  an artifact, so the review's checks read the "uploaded" copy, not the working tree.
- Review modes: `--review-skeleton` (the bundle's suggested claims, no model), `--review <file>`,
  `--no-review`, or the model itself.
- **Reads the model step out of the workflow** (`anthropics/claude-code-action` inputs: `prompt`,
  `claude_args`, `settings`, and the `claims:` file after it) instead of keeping a copy, and refuses
  any `${{ }}` expression it cannot evaluate locally (only `vars.NAME || 'default'`, from env).
- Then `claims --bundle --sha --fix`, then `claims --bundle --sha`, prints what CI would post.

### 1.3 GitHub CI

| Workflow | Shape |
|---|---|
| `.github/workflows/ci.yml` (this repo) | `build` once (typecheck + build, `dist` artifact) -> `smoke` (22.0.0/22/24, bare node), `test` (22/24, `test:unit` on the artifact), `example-evidence` -> `example-review` (bundle handed over as an artifact, held by `uses: ./`), `governance` (`fetch-depth: 0`, `check:docs`, `check:ladder` per commit of the push/PR range, the action on a fixture, `check:all --enforce` captured and rendered by `ci:summary` into `GITHUB_STEP_SUMMARY`). `action-from-npm` runs the action against the published package. |
| example `ci.yml` | `evidence` (checks out the PR head, not the merge commit; `fetch-depth: 0`; `npm run evidence` is the test step; artifact uploaded `if: always()`) and `governance` (the action, `governance: 'true'`) - the two required checks. `review` (PRs, not drafts) runs the model with no shell, then `--fix`, then the action with `bundle` + `sha`, then posts the PR comment. Not required. `concurrency` cancels superseded runs. |
| `release.yml` | Tag-triggered npm publish with provenance. Unaffected. |

### 1.4 Where the package is GitHub-shaped

| Place | Coupling |
|---|---|
| `src/core/annotations.ts`, `src/core/cli.ts` (`Format`) | `--format github`: `::error`/`::warning` workflow commands, escaping, `::stop-commands::<token>` around the human report (DEC-0007). |
| `src/core/ci-summary.ts` | Writes the summary to `GITHUB_STEP_SUMMARY`. |
| `action.yml`, `action/run.mjs` | `INPUT_*`, `GITHUB_OUTPUT`, `GITHUB_WORKSPACE`; the "launcher" that picks installed / own build / `npx` pinned version. |
| `src/core/governance.ts` | The trigger graph reads `.githooks/` and `run:` steps of `.github/workflows/*`. An Azure pipeline is invisible to it. |
| `package.json` `evidenceLayer.outputFormats` | Capability `github`; the plugin launcher and action check capabilities, not versions. |
| example `ci-local.mjs` | Parses the `claude-code-action` step specifically. |

### 1.5 The consumer this is shaped for

The phases after 3 were first written for a project with a pipeline of its own in its repository.
Looking at a real consumer on Azure DevOps showed a different and common shape, and the plan now
targets that:

- **The repository carries no pipeline YAML; its CI is central.** Every pipeline that validates its
  pull requests lives in a separate pipelines repository, shared by many product repositories, and
  reaches each one through a branch policy: build validation for lint and tests, for static
  analysis, for a deploy-preview status bridge, and for an AI review. Shared steps come from a
  templates repository; agents are a self-hosted pool.
- **The AI review is one central job serving many repositories.** It loads the model key and an
  Azure DevOps token from a key vault, clones the target repository at the pull request, composes
  the repository's review guidelines with shared ones, filters the diff, writes its own evidence -
  refs, SHAs and the reviewed file list, git metadata only, no command output - runs the model,
  posts the review and syncs a reviewer vote. The one per-repository extension is a guidelines file.
- **Governance runs outside the review**: in a deploy-preview build plugin and a `pre-push` hook,
  warn-only.
- **The repository has its own layer over evidence-layer**: a scoped gather (lint, a typecheck
  matrix, the tests near the change - never the whole suite), a review verifier with its own
  rules, and a governance check with its own trigger graph.
- **The gap:** the evidence a review cites is gathered by whoever writes the review, on their
  machine, and the CI review never sees it.

## 2. What differs on Azure DevOps (to confirm in phase 0)

Items marked (verify) are from memory of the Azure Pipelines docs and agent behaviour; phase 0
checks each against the docs and a throwaway pipeline before anything is built on it.

| Need | GitHub | Azure Pipelines |
|---|---|---|
| Line annotations | `::error file=,line=::msg` | `##vso[task.logissue type=error;sourcepath=;linenumber=;code=]msg` |
| Escaping | `%`, `\r`, `\n` (+ `:` `,` in properties) | `%` -> `%AZP25`, `\r` -> `%0D`, `\n` -> `%0A`, `;` -> `%3B`, `]` -> `%5D` (verify) |
| Stop the runner obeying printed text | `::stop-commands::<token>` | **No equivalent.** The agent may detect `##vso[` anywhere in a line (verify). Mitigation: neutralise `##vso[` and `##[` in every line of review text the package prints, and run steps with `target: { commands: restricted }` (verify which commands restricted mode still allows - `logissue` and `uploadsummary` must be among them). |
| Job summary | `GITHUB_STEP_SUMMARY` file | `##vso[task.uploadsummary]<abs path to .md>` |
| Step outputs | `GITHUB_OUTPUT` | `##vso[task.setvariable variable=x;isOutput=true]v` |
| Artifact between jobs | upload/download-artifact | `PublishPipelineArtifact@1` / `DownloadPipelineArtifact@2`, `dependsOn` |
| PR head vs merge commit | `ref: head.sha` | PR builds check out `refs/pull/N/merge`; `git checkout $(System.PullRequest.SourceCommitId)` after checkout |
| Full history | `fetch-depth: 0` | `checkout: self` with `fetchDepth: 0` (new pipelines default to shallow - verify) |
| Base ref | `github.base_ref` | `$(System.PullRequest.TargetBranch)` (`refs/heads/develop`) -> `origin/develop` |
| Push range for `check:ladder` | `github.event.before` | No "before" SHA. Tip alone, or the last successful build's `sourceVersion` via REST; PR range is `origin/<target>..SourceCommitId`. |
| Draft PRs | `pull_request.draft` | `System.PullRequest.IsDraft` (verify it exists for the agent version in use) |
| Cancel superseded runs | `concurrency` | Azure Repos ignores a YAML `pr:` trigger, `autoCancel` included: a pull request runs a pipeline only through a build validation policy, so what happens to a superseded run is the policy's behaviour, not the YAML's (`pr: autoCancel` applies to GitHub and Bitbucket repositories) |
| Required vs optional | per job (status check) | per **pipeline** (build validation policy) or per **status name** (PR Status API + "status check" policy) |
| Posting the review | `gh pr comment` | REST `POST .../pullRequests/{id}/threads` with `$(System.AccessToken)`; the build service identity needs "Contribute to pull requests" |
| Secrets on fork PRs | withheld | withheld by default; a project without forks is not constrained by it |

The "required vs optional" row is the one that shapes the design: GitHub lets `evidence` and
`governance` be required while `review` is not, inside one workflow. Azure's build-validation
policy is per pipeline. Two ways to keep the same semantics:

- **A (recommended): one pipeline, three PR statuses.** Each job posts its own PR status
  (`evidence-layer/evidence`, `/governance`, `/review`) through the PR Status API. Branch policy
  requires the first two as status checks; `review` is shown, not required. The pipeline itself is
  an optional build-validation policy, so a failed model step never blocks a merge the suite allows.
- **B: two pipelines.** `evidence.yml` (required build validation) and `review.yml` (optional) - but
  the review pipeline must then fetch the other run's artifact, and pipeline-completion triggers do
  not attach to the PR the way build validation does. More moving parts; only if A's status
  permission is refused.

## 3. Plan

Each phase is a commit series with its own `Ladder-Rung` trailers; package phases ship as one
minor release (0.18.0) with `docs/releases/v0.18.0.md`, because it adds a format users opt into.

### Phase 0 - confirm the ground (no code)

1. Confirm the consumer can run Azure Pipelines: agent pool (Microsoft-hosted or self-hosted),
   parallel jobs available, who can create pipelines and branch policies on its repository.
2. A throwaway pipeline that prints: a `##vso[task.logissue]` at line start and mid-line, a
   `##vso[task.setvariable]` mid-line, the same under `target: commands: restricted`, a
   `task.uploadsummary`, and the escapes above. Record what the agent obeyed. This decides how
   phase 1 neutralises review text.
3. Check `System.PullRequest.IsDraft`, `SourceCommitId`, how a build validation policy treats a superseded run, default `fetchDepth`, and
   whether "partially succeeded" passes a build-validation policy.
4. Confirm the build service can post PR statuses and threads (option A), and where
   `ANTHROPIC_API_KEY` will live (variable group / Key Vault).

Output: a short findings note in `docs/plans/`, linked from the decision record below.

### Phase 1 - `--format azure` in the package (Ladder-Rung: 5)

- `src/core/annotations.ts`: an Azure writer beside the GitHub one - one `task.logissue` per
  finding that is not a pass (`error` -> `type=error`; `warning`, `unverifiable`, `flaky` ->
  `type=warning` with the outcome named in the message, because Azure has two levels and this
  package has five, and "nobody could check this" must not read as a nit), `sourcepath`/`linenumber`
  when the finding has them, `code` from DEC-0006's reason codes.
- Every printed line containing review text is neutralised (`##vso[` / `##[` broken with a
  zero-width or escaped character - exact form per phase 0). This replaces `::stop-commands::`, so
  the invariant is stated as strongly as DEC-0007's: no review text reaches the agent as a command.
- Summary: write the markdown summary to `$(Agent.TempDirectory)` and emit `task.uploadsummary` when
  `TF_BUILD` is set; `ci-summary.ts` gains the same branch for `pnpm ci:summary`.
- `cli.ts` `Format` adds `azure`; `claims`, `receipt`, `governance` accept it; exit codes unchanged.
- `package.json` `evidenceLayer.outputFormats` adds `azure` (capability, not version).
- New `DEC-0012-azure-pipelines-output.md`, invariants enforced by `pnpm test`:
  - review text printed under `--format azure` never reaches the agent as a logging command;
  - every non-pass finding becomes exactly one `logissue`, with its outcome named.
- Tests: `test/annotations-azure.test.ts` with hostile claims (`##vso[task.setvariable ...]`, a
  newline followed by `##vso[`, `;` and `]` in paths), extending the `test/injection.test.ts`
  pattern. README section "Azure Pipelines"; update the README's test-count sentence.

Not built: an Azure DevOps Marketplace task. On GitHub the action exists for projects with nothing
installed; on Azure a script step running the installed CLI is the whole integration
(`pnpm exec evidence-layer claims ... --format azure`), and a Marketplace extension would be a
second distribution channel without npm's provenance - DEC-0007's reasoning, Ladder-Rung 1.

### Phase 2 - governance sees Azure pipelines (Ladder-Rung: 5)

- `src/core/governance.ts` trigger graph also reads `azure-pipelines.yml`, `.azure-pipelines/**`,
  `.azuredevops/**/*.yml`, and from them `script:`, `bash:`, `pwsh:`, `powershell:` steps (and
  `inputs.script` of `Bash@3` / `PowerShell@2` / `CmdLine@2`), so "enforced by `pnpm X`" is satisfied
  by a pipeline that runs it. A `template:` reference that cannot be resolved locally (another repo)
  is reported `unverifiable`, not silently skipped.
- Tests in `test/governance.test.ts` with an Azure fixture.

### Phase 3 - the example on Azure (Ladder-Rung: 5)

- `examples/plain-node-project/azure-pipelines.yml`: `evidence` and `governance` jobs in parallel,
  `review` with `dependsOn: evidence` and the PR/draft condition, `PublishPipelineArtifact` with
  `condition: always()`, checkout of `SourceCommitId`, `fetchDepth: 0`, the model step as a plain
  `claude -p` script step (no `claude-code-action` on Azure), `--fix`, the check with
  `--format azure`, the status posts (option A) and the PR thread post via a small dependency-free
  `scripts/post-review.mjs`.
- `scripts/ci-local.mjs` learns `--pipeline azure|github` (default: whichever file exists, refusing
  when both do and none is named). For Azure it reads the `review` job's `claude -p` step - prompt,
  flags, `--settings` - and evaluates `$(REVIEW_MODEL)` from the pipeline's `variables:` default or
  the environment; any other macro or `$[ ]` / `${{ }}` expression is refused, as today.
- `test/example.test.ts` holds the Azure reader to the Azure file (same rule as for GitHub: the
  local run asks the model nothing CI does not).
- ~~This repository's CI: an `example-azure-format` job.~~ Not built: `test/example.test.ts` runs
  `ci:local --pipeline azure` inside the suite, which CI's `test` job already runs on 22 and 24,
  and `test/azure-logging.test.ts` holds `--format azure` itself - a job would run the same again.
- As built, a pull request's statuses come from `scripts/azure-pr.mjs` in the example (option A of
  section 2), because whether a "partially succeeded" run passes a required build validation could
  not be confirmed.

### The consumer design: one central review pipeline, extended per repository

The review stays the central AI review pipeline, which starts reading evidence; governance moves
out of the deploy-preview build into a job of that pipeline; and the pipeline is centralized but
extendable - a repository extends the standard configuration and overrides the parts it needs.

**One pipeline, one status per job.** The central pipeline remains the single build validation on
each repository, optional. Each of its jobs posts its own pull request status, genre `ai-review`,
as a status bridge does for deploy previews; each repository's status policies decide which are
required - typically `ai-review/evidence` and `ai-review/governance` required, `ai-review/review`
optional, so a failed model call does not block a merge the suite allows. (This is option A of
section 2, settled; it does not depend on how a "partially succeeded" run is judged.)

**Jobs, and where the secrets are.** A job that runs the pull request's code never holds the model
key or the Azure DevOps token; a job that holds them never runs the pull request's code. The PR
author controls that code - a test can print an environment variable as easily as it can fail.

| Job | Runs PR code | Secrets | Does |
|---|---|---|---|
| `evidence` | yes | package registry only | clones the PR head, runs the repository's gather command, publishes the bundle and `change.diff`; posts `ai-review/evidence` |
| `governance` | yes | none | runs the repository's governance command (`--format azure`); posts `ai-review/governance` |
| `review` | **no** | model key | downloads the bundle; the model reads it, the diff and the files, and writes `ai-review.md` whose run claims are copied from the bundle's Suggested claims; publishes it - posts nothing |
| `verify` | yes | none | `evidence-layer claims ai-review.md --bundle --sha --fix`, then the check with `--format azure`, then the repository's own verify command; publishes the review as checked; posts `ai-review/review` |
| `publish` | **no** | Azure DevOps token | posts the checked review, cleans up older threads, syncs the reviewer vote - the existing pipeline's tail, unchanged |

`evidence` and `governance` run side by side; `review` waits for `evidence`, `verify` for `review`,
`publish` for `verify`. Whatever the pipeline does today before the model runs - skip markers,
diff filters, submodules, chunking of large changes - stays in front of `review`.

**The extension: a configuration file in the repository, read from the target branch.**
`.azuredevops/ai-review.yml` overrides central defaults key by key, the way guidelines files are
usually layered (shared, then the repository's, then a fallback):

```yaml
# Read by the central review pipeline, from the target branch.
evidence:
  image: <the repository's dependency image>   # optional: run where its lint and tests already run
  gather: pnpm review-evidence --base "$BASE_SHA" --head "$HEAD_SHA"
  bundle: review-evidence.local.md
governance:
  run: pnpm governance:check --enforce --format azure
verify:
  run: pnpm verify-review --review ai-review.md --sha "$HEAD_SHA"
review:
  guidelines: REVIEW-GUIDELINES.md
```

- **From the target branch, not the PR.** A pull request that edits the file cannot change what
  gathers its own evidence or checks its own review; the change takes effect once merged, after
  review - the rule GitHub's `pull_request_target` exists for. The pipeline reads it with
  `git show origin/<target>:.azuredevops/ai-review.yml`.
- **A repository without the file** gets the review it has today: no evidence job, no bundle.
  Adoption is per repository, not a flag day.
- **Inside the central pipeline the jobs are templates** with `stepList` parameters
  (`beforeGather`, `afterVerify`), so a repository that runs the review from its own YAML stub
  (`extends:` the template) gets the same jobs and can override steps, while the centralized mode
  overrides through the file.
- **Governance sees it.** `.azuredevops/` is one of the directories evidence-layer's governance
  reads (DEC-0013), so "enforced by `pnpm review-evidence`" in the repository's decision records is
  reached through this file - with the pass saying that a pipeline elsewhere runs it, which no file
  shows.

### Phase 4 - the central pipeline reads evidence (the pipelines and templates repositories)

- Split the review job into the five jobs above. Move the key vault step into `review` and
  `publish` only; `evidence`, `governance` and `verify` get no secret.
- Read `.azuredevops/ai-review.yml` from the target branch; when it is absent, run the existing
  flow unchanged.
- `evidence`: PR head, full history, the repository's gather - in its dependency image when the
  file names one. Publish the bundle and `change.diff` under `condition: always()`; attach the
  bundle as the run summary.
- `review`: the prompt gains the bundle - findings about the diff as now, plus every claim about
  what ran copied as a **Claim**/**Grounding** pair from the bundle's Suggested claims, the
  example's prompt. The model writes the review to a file; it posts nothing.
- `verify`: `npx evidence-layer@<the version the repository pins>` - read from its `package.json`,
  an exact version, never `latest` - then the repository's verify command. A review whose claims
  the bundle does not back is marked UNVERIFIED by `--fix` before anyone reads it, so a retry costs
  no tokens.
- Statuses: `azure-pr.mjs`'s shape (phase 3) - pending at a job's start, its outcome under
  `condition: always()`, on the iteration whose head is the commit built.
- Start on a canary repository, or with every new status optional.

### Phase 5 - a repository adopts it

- Depend on the evidence-layer release carrying phases 1-3 (0.18.0).
- Check the gather exits 1 when a step failed, after writing the bundle (DEC-0011's rule for a
  gather that is the test step); fix it first if not.
- Add `.azuredevops/ai-review.yml`.
- If the repository has its own trigger graph for governance, add `.azuredevops/*.yml` as roots -
  or, better, reuse evidence-layer's `traceTriggers` (DEC-0013), adding here whatever hook manager
  it needs (simple-git-hooks reads from `package.json`, not `.githooks/`), and delete the copy
  (Ladder-Rung 2): one trigger graph, not two.
- Status policies: `ai-review/evidence` and `ai-review/governance` optional for a sprint, then
  required.

### Phase 6 - retire the old governance trigger

- Once `ai-review/governance` is required, remove governance from the deploy-preview build and its
  roots from the trigger graph. A ratchet the old step enforced moves into the governance job as
  its own command, still enforced.
- `pre-push` keeps the warn-only governance run: the local, fast signal.
- The repository's decision record for its governance trigger is superseded: invariants
  "enforced by `pnpm governance:check`" are reached through `.azuredevops/ai-review.yml`.

### Phase 7 - the repository's `ci:local`

- `LOCAL_JOBS` / `NOT_REPRODUCED` as `scripts/ci-local.ts` here, run from
  `.azuredevops/ai-review.yml` - the file the central pipeline reads, so the local run and CI
  cannot drift:
  - local: `evidence` (the gather against the default branch), `governance`, `verify`;
  - `review`: `--review-skeleton` (the bundle's suggested claims), `--review <file>`, or the model.
    The prompt is the central pipeline's, so the model mode reads it from the pipelines repository
    - a local clone, or the Azure DevOps REST API - and is `unverifiable` when neither is
    reachable, never a stand-in prompt. Without the model's endpoint and key, the skeleton and
    file modes still run every check;
  - `unverifiable`, never a pass: the other central pipelines, deploy previews, the status and
    thread posts.
- On Windows, the package manager through a shell only on win32, with refused metacharacters, as
  the example does.
- A test holds the job lists to the configuration file's keys.

### Phase 8 - docs and decisions

- Here: release notes for 0.18.0 (DEC-0012, DEC-0013, the example's Azure pipeline), and an
  example `.azuredevops/ai-review.yml` once phase 4's schema settles.
- The central pipeline's README: the jobs, the secrets split and the configuration file.
- The adopting repository: the decision record of phase 6.

## 4. Risks

- **Secrets beside PR code.** A central review job that loads its token and model key into the job
  that clones the PR is safe only while it runs none of the PR's code; the evidence job will, so
  the split in phase 4 comes before any gather, not after.
- **Duplicate work with existing validation.** `evidence` runs lint, typechecks and scoped tests
  that a lint-and-test pipeline may partly run too. Once both are stable, that pipeline's
  validation can become the gather (the suite once, inside the gather, as the example does).
- **Log injection.** Settled in the package (DEC-0012): under `--format azure` review text is
  defanged, since the agent obeys `##vso[` anywhere in a line. Output the pipeline prints itself
  (`--fix`'s lines, the gather) is the repository's own, as in any CI.
- **The configuration file is code.** Read from the target branch, it is reviewed before it runs;
  the pipeline must never fall back to the PR's copy.
- **Token cost.** The bundle adds input tokens; a red `evidence` skips the model entirely.

## 5. Open questions for the owner

1. Do phase 4's changes go to the existing central review pipeline, or into a new pipeline beside
   it first?
2. Is the job split acceptable to the pipeline's owners - secret-free `evidence` / `governance` /
   `verify`, the key vault step only in `review` and `publish`?
3. Should `evidence` start separate from the existing lint-and-test pipeline (duplicate work, no
   change to it), or should that pipeline produce the bundle from the start?
4. Locally, can developers reach the review model, or is the local review the skeleton and file
   modes plus another model as a stand-in?
