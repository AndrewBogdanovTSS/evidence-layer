# Azure DevOps integration - plan

Status: phases 1-3 built (PRs #8, #9, #10); Canvas phases redesigned 2026-10-29. Target consumer: Canvas (`VF-AppDelivery / Experience Engineering /
canvas-storefront`, default branch `develop`).

The goal: what GitHub CI and the two `ci:local` scripts do for this repository and its example,
Canvas gets on Azure DevOps - CI gathers the evidence itself, a review is held to the bundle CI
gathered, and a developer can run the same jobs locally before pushing and get the same verdict.

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

### 1.5 Canvas today

Read 2026-10-29 from Azure DevOps (`VF-AppDelivery / Experience Engineering`) over REST.

- **Canvas carries no pipeline YAML; its CI is central.** Every pipeline that validates a
  `canvas-storefront` pull request lives in the `engineering-pipelines` repository and reaches
  Canvas through a branch policy:

  | Definition | Pipeline (`engineering-pipelines`) | Policy on `develop` | What it does |
  |---|---|---|---|
  | 607 Linting and Coverage | `ci-cd/linting-coverage.yml` | build validation, required | `pnpm build`, `lint:ci`, `test:cov` in the repo's dependency image |
  | 675 SonarQube Scan | `ci-cd/sonarqube-scan.yml` | build validation, required | Sonar |
  | 4090 PR Status Bridge | `netlify-pr-status-bridge/centralized-pipeline.yml` | build validation, required | posts each Netlify site's build as a PR status (genre `continuous-integration`), each a required status policy |
  | 4397 AI PR Review | `pr-ai-review/centralized-pipeline.yml` | build validation, optional | the model review, below |

  Templates come from `vf_cloud_core/vf-cicd-ado-pipeline-templates` at `refs/heads/main`; agents
  are the self-hosted pool `adoagent-vmss-eastus2-sharedsvc-appdelivery-ubuntu-2204`.
- **The AI review** is one job, `KimiReview`, serving many repositories. It loads the model and
  Azure DevOps secrets from Key Vault, clones the target repository at the PR, composes
  `REVIEW-GUIDELINES.md` (shared guidance, then the repo's own, then a fallback), filters the diff,
  writes `kimi_review_evidence.json` - refs, SHAs, the reviewed and excluded file lists, which is
  git evidence only, no command output - runs Kimi (`kimi-k2.5` over an OpenAI-compatible
  endpoint), posts the review with a pipeline-made Access Receipt, cleans up its older threads and
  syncs a reviewer vote. Its one per-repo extension point is the repo's `REVIEW-GUIDELINES.md`,
  rubric text plus a ```` ```yaml kimi-review ```` block of exclusions.
- **What nothing uses yet:** the reviewer does not read an evidence-layer bundle, does not run
  `review-evidence`, and does not read Canvas's `---GOVERNANCE-CHECK-JSON-BEGIN---` block - the
  "Azure AI review plugin" that `scripts/governance-check/README.md` says consumes it is not this
  pipeline.
- **Governance** runs in the Netlify build (`netlify-plugin-governance`: `pnpm governance:check`,
  warn-only unless `GOVERNANCE_ENFORCE=true`, plus the enforced `suppressions-ratchet`) and in the
  `pre-push` hook, warn-only.
- **Canvas's own layer** over `evidence-layer@0.17.0` (DEC-0005 there): `review-evidence` (scoped
  lint, brand typecheck matrix, sibling-spec tests - never the full suite), `verify-review`,
  `governance:check` (its own trigger graph: simple-git-hooks, `netlify.toml`, Netlify plugins).
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
| Cancel superseded runs | `concurrency` | `pr: autoCancel: true` (default for PR validation - verify) |
| Required vs optional | per job (status check) | per **pipeline** (build validation policy) or per **status name** (PR Status API + "status check" policy) |
| Posting the review | `gh pr comment` | REST `POST .../pullRequests/{id}/threads` with `$(System.AccessToken)`; the build service identity needs "Contribute to pull requests" |
| Secrets on fork PRs | withheld | withheld by default; Canvas has no forks, so not a constraint |

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

1. Confirm Canvas can run Azure Pipelines: agent pool (Microsoft-hosted or self-hosted), parallel
   jobs available, who can create pipelines and branch policies on `canvas-storefront`.
2. A throwaway pipeline that prints: a `##vso[task.logissue]` at line start and mid-line, a
   `##vso[task.setvariable]` mid-line, the same under `target: commands: restricted`, a
   `task.uploadsummary`, and the escapes above. Record what the agent obeyed. This decides how
   phase 1 neutralises review text.
3. Check `System.PullRequest.IsDraft`, `SourceCommitId`, `autoCancel`, default `fetchDepth`, and
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
- This repository's CI: an `example-azure-format` job (or a step in `example-review`) runs the
  handoff with `--format azure` and `TF_BUILD=True` and asserts the `logissue` lines and the
  summary command. `scripts/ci-local.ts` `LOCAL_JOBS` gains its counterpart - `test/ci-local.test.ts`
  fails until it does.

### The Canvas design: one central review pipeline, extended per repository

Decided with the owner on 2026-10-29: the review stays the central `AI PR Review` pipeline, which
starts reading evidence; the Netlify governance plugin is deprecated in favour of a governance job
in that pipeline; and the pipeline is centralized but extendable - a repository extends the
standard configuration and overrides the parts it needs.

**One pipeline, one status per job.** The central pipeline remains the single build validation on
each repository (optional, as 4397 is today). Each of its jobs posts its own pull request status,
genre `ai-review`, as the PR Status Bridge already does for Netlify sites; the repository's
status policies decide which are required. For Canvas: `ai-review/evidence` and
`ai-review/governance` required, `ai-review/review` optional - a failed model call must not block a
merge the suite allows. (This is option A of section 2, settled; it does not depend on how a
"partially succeeded" run is judged.)

**Jobs, and where the secrets are.** A job that runs the pull request's code never holds the model
key or the Azure DevOps PAT; a job that holds them never runs the pull request's code. The PR
author controls that code - a test can print an environment variable as easily as it can fail.

| Job | Runs PR code | Secrets | Does |
|---|---|---|---|
| `evidence` | yes | npm registry only | clones the PR head, runs the repo's gather command, publishes the bundle and `change.diff`; posts `ai-review/evidence` |
| `governance` | yes | none | runs the repo's governance command (`--format azure`); posts `ai-review/governance` |
| `review` | **no** | model key | downloads the bundle; the model reads it, the diff and the files, and writes `ai-review.md` whose run claims are copied from the bundle's Suggested claims; publishes it - posts nothing |
| `verify` | yes | none | `evidence-layer claims ai-review.md --bundle --sha --fix`, then the check with `--format azure`, then the repo's own verify command (Canvas: `pnpm verify-review`); publishes the review as checked; posts `ai-review/review` |
| `publish` | **no** | Azure DevOps PAT | posts the checked review, cleans up older threads, syncs the reviewer vote - today's tail of `KimiReview`, unchanged |

`evidence` and `governance` run side by side; `review` waits for `evidence`, `verify` for `review`,
`publish` for `verify`. Today's `#ai-skip`, preflight diff filter, submodule handling and
large-PR chunking stay where they are, in front of `review`.

**The extension: a configuration file in the repository, read from the target branch.**
`.azuredevops/ai-review.yml` overrides central defaults key by key - the layering
`REVIEW-GUIDELINES.md` already has (shared, then the repository's, then a fallback):

```yaml
# Read by engineering-pipelines/pr-ai-review/centralized-pipeline.yml, from the target branch.
evidence:
  image: canvas-storefront/dependency-install   # optional: run in the repo's dependency image, as 607 does
  gather: pnpm review-evidence --base "$BASE_SHA" --head "$HEAD_SHA"
  bundle: review-evidence.local.md
governance:
  run: pnpm governance:check --enforce --format azure
verify:
  run: pnpm verify-review --review ai-review.md --sha "$HEAD_SHA"
review:
  guidelines: REVIEW-GUIDELINES.md              # as today
```

- **From the target branch, not the PR.** A pull request that edits the file cannot change what
  gathers its own evidence or checks its own review; the change takes effect once merged, after
  review - the rule GitHub's `pull_request_target` exists for. The pipeline reads it with
  `git show origin/<target>:.azuredevops/ai-review.yml`.
- **A repository without the file** gets today's review: no evidence job, no bundle, the git-only
  `kimi_review_evidence.json`. Adoption is per repository, not a flag day.
- **Inside the central pipeline the jobs are templates** in `vf-cicd-ado-pipeline-templates`
  (`pr-ai-review/jobs/evidence.yml` and so on) with `stepList` parameters (`beforeGather`,
  `afterVerify`), so the per-repo stub mode (`example-usage.yml`, `extends:` the template) gets the
  same jobs and can override steps, while the centralized mode overrides through the file.
- **Governance sees it.** `.azuredevops/` is one of the directories evidence-layer's governance
  reads (DEC-0013), so "enforced by `pnpm review-evidence`" in a Canvas decision record is reached
  through this file - with the pass saying that a pipeline elsewhere runs it, which no file shows.

### Phase 4 - the central pipeline reads evidence (`engineering-pipelines`, `vf-cicd-ado-pipeline-templates`)

- Split `KimiReview` into the five jobs above. Move the Key Vault step into `review` and `publish`
  only; `evidence`, `governance` and `verify` get no secret.
- Read `.azuredevops/ai-review.yml` from the target branch; when it is absent, run today's flow
  unchanged.
- `evidence`: PR head (the pipeline's existing `resolve-pr-context.mjs` already resolves it), full
  history, the repo's gather in its dependency image as 607 runs `pnpm build` (`.npmrc` secure
  file, jFrog image). Publish the bundle and `change.diff` under `condition: always()`; attach the
  bundle as the run summary.
- `review`: the Kimi prompt gains the bundle - findings about the diff as now, plus every claim
  about what ran copied as a **Claim**/**Grounding** pair from the bundle's Suggested claims, the
  example's prompt. The Risk Matrix, Executive Summary and the rest stay. The model writes the
  review to a file; it posts nothing.
- `verify`: `npx evidence-layer@<the version the repo pins>` - read from its `package.json`, an
  exact version, never `latest` - then the repo's verify command. A review whose claims the bundle
  does not back is marked UNVERIFIED by `--fix` before anyone reads it, so a retry costs no
  tokens.
- Statuses: `azure-pr.mjs`'s shape (phase 3) - pending at a job's start, its outcome under
  `condition: always()`, on the iteration whose head is the commit built.
- Start on a canary repository, or on Canvas with every new status optional.

### Phase 5 - Canvas adopts it (`canvas-storefront`)

- Bump `evidence-layer` to the release carrying phases 1-3 (0.18.0); DEC-0005's version line.
- Check `review-evidence` exits 1 when a step failed, after writing the bundle (DEC-0011's rule for
  a gather that is the test step); fix it first if not.
- Add `.azuredevops/ai-review.yml` as above.
- `scripts/governance-check/lib.ts`: the trigger graph gains `.azuredevops/*.yml` as roots, so
  Canvas invariants can name the central pipeline's commands. Better, since the Netlify roots are
  going: reuse evidence-layer's `traceTriggers` (DEC-0013) and add simple-git-hooks support there,
  deleting Canvas's copy (Ladder-Rung 2) - one trigger graph, not two.
- Status policies on `develop`, `release/*`: `ai-review/evidence` and `ai-review/governance`
  optional for a sprint, then required.
- Correct `scripts/governance-check/README.md`: no AI review plugin reads the JSON block today.

### Phase 6 - deprecate the Netlify governance plugin (`canvas-storefront`)

- Once `ai-review/governance` is required: remove `netlify-plugin-governance` from `netlify.toml`
  and `netlify/plugins/`, and its roots from the trigger graph. `suppressions-ratchet` moves into
  the governance job as its own command, still enforced.
- `pre-push` keeps `governance:check --warn-only`: the local, fast signal.
- A Canvas decision record (add-decision skill) supersedes the Netlify trigger: invariants
  "enforced by `pnpm governance:check`" are reached through `.azuredevops/ai-review.yml`.

### Phase 7 - Canvas `pnpm ci:local`

- `scripts/ci-local/index.ts`, `LOCAL_JOBS` / `NOT_REPRODUCED` as `scripts/ci-local.ts` here, run
  from `.azuredevops/ai-review.yml` - the file the central pipeline reads, so the local run and CI
  cannot drift:
  - local: `evidence` (the gather against `origin/develop`), `governance`, `verify`;
  - `review`: `--review-skeleton` (the bundle's suggested claims), `--review <file>`, or the model.
    The prompt is the central pipeline's, so the model mode reads it from `engineering-pipelines`
    at `main` - a local clone, or REST with `AZURE_DEVOPS_PAT` - and is `unverifiable` when neither
    is reachable, never a stand-in prompt. Kimi needs its endpoint and key; without them, the
    skeleton and file modes still run every check;
  - `unverifiable`, never a pass: 607, Sonar, the Netlify builds, the status and thread posts.
- Windows is the common case at Canvas: `pnpm` through a shell only on win32, with refused
  metacharacters, as the example does.
- `scripts/ci-local/tests/index.test.ts` holds the job lists to the configuration file's keys.

### Phase 8 - docs and decisions

- Here: release notes for 0.18.0 (DEC-0012, DEC-0013, the example's Azure pipeline).
- `engineering-pipelines`: the `pr-ai-review` README gains the jobs, the secrets split and the
  configuration file.
- Canvas: the decision record of phase 6; AGENTS.md and the `review-pr` skill point at the CI bundle.

## 4. Risks

- **Secrets beside PR code.** The current `KimiReview` job loads the PAT and the model key into the
  job that clones the PR. It does not run the PR's code today; the evidence job will, so the split
  in phase 4 comes before any gather, not after.
- **Duplicate work with 607.** `evidence` runs lint, a typecheck matrix and scoped tests that 607
  partly runs too. Once both are stable, 607's validation script can become the gather (the suite
  once, inside the gather, as the example does) - a later change, and 607's owners' call.
- **Log injection.** Settled in the package (DEC-0012): under `--format azure` review text is
  defanged, since the agent obeys `##vso[` anywhere in a line. Output the pipeline prints itself
  (`--fix`'s lines, the gather) is the repository's own, as in any CI.
- **The configuration file is code.** Read from the target branch, it is reviewed before it runs;
  the pipeline must never fall back to the PR's copy.
- **Token cost.** The review already runs on every PR update; the bundle adds input tokens, and a
  red `evidence` skips the model entirely.

## 5. Open questions for the owner

1. Who owns `engineering-pipelines` and `vf-cicd-ado-pipeline-templates`, and do phase 4's changes
   go through them, or through a new pipeline beside 4397 first?
2. Is the job split acceptable to that owner - the secret-free `evidence` / `governance` / `verify`
   jobs, the Key Vault step only in `review` and `publish`?
3. Should `evidence` start separate from 607 (duplicate work, no change to 607), or should 607
   produce the bundle from the start?
4. Locally, is Kimi reachable for developers (endpoint and key), or is the local review the skeleton
   and file modes plus `claude -p` as a stand-in model?
