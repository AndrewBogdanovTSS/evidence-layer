# Azure DevOps integration - plan

Status: draft, 2026-10-28. Target consumer: Canvas (`VF-AppDelivery / Experience Engineering /
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

- Hosted on Azure DevOps Repos; PRs there. **No Azure Pipelines YAML in the repository.** CI is the
  Netlify build: `netlify-plugin-governance` (runs `pnpm governance:check`, warn-only unless
  `GOVERNANCE_ENFORCE=true`, plus the enforced `suppressions-ratchet`), axe, Chromatic, Lighthouse,
  performance. Local: simple-git-hooks (`pre-commit` lint-staged, `pre-push` governance warn-only).
- An external "Azure AI review plugin" reads the build log between
  `---GOVERNANCE-CHECK-JSON-BEGIN/END---` delimiters (contract in `scripts/governance-check/README.md`).
- Its own Canvas-specific layer over `evidence-layer@0.17.0` (DEC-0005 there): `review-evidence`
  (scoped lint, brand typecheck matrix from `env/layers.ts`, sibling-spec tests - never the full
  suite; `--pr` resolves base/head over Azure REST with `AZURE_DEVOPS_PAT`), `verify-review`,
  `governance:check` (own trigger graph: simple-git-hooks + `netlify.toml` + Netlify plugins).
- Node `24.14.1`, pnpm `11.9.0`, `.npmrc.ci` (private registry auth in CI).
- The gap: the evidence a review cites is gathered by whoever writes the review, on their machine.
  Nothing independent gathers it at the PR head, so `claims --bundle` has no CI bundle to hold a
  review to - the DEC-0011 handoff does not exist on Azure.

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
- ~~This repository's CI: an `example-azure-format` job.~~ Not built: `test/example.test.ts` runs
  `ci:local --pipeline azure` inside the suite, which CI's `test` job already runs on 22 and 24,
  and `test/azure-logging.test.ts` holds `--format azure` itself - a job would run the same again.
- As built, a pull request's statuses come from `scripts/azure-pr.mjs` in the example (option A of
  section 2), because whether a "partially succeeded" run passes a required build validation could
  not be confirmed.

### Phase 4 - Canvas pipeline: evidence and governance (Canvas repo)

Start in warn-only, the way the Netlify governance plugin started.

- Bump `evidence-layer` to 0.18.0 (standing `minimumReleaseAgeExclude` applies); update DEC-0005's
  version line.
- `azure-pipelines/evidence.yml`, triggers `pr: [develop, release/*]` (`autoCancel: true`) and
  `trigger: [develop]`:
  - **evidence**: `UseNode@1` 24.14.1, `corepack enable` (pnpm 11.9.0), `npmAuthenticate@0` with
    `.npmrc.ci`, `Cache@2` for the pnpm store, `pnpm install --frozen-lockfile`;
    checkout `SourceCommitId`; `git diff origin/<target>...HEAD > change.diff`;
    `pnpm review-evidence --base <target SHA> --head <SourceCommitId>`; publish
    `review-evidence.local.md` + `change.diff` with `condition: always()`; upload the bundle as the
    summary; post status `evidence-layer/evidence`.
    Check first that `review-evidence` exits 1 when a step failed after writing the bundle (the
    DEC-0011 rule); if it does not, that is the first Canvas change, so the gather is the test step.
    Generous `timeoutInMinutes` - the brand typecheck matrix is the slow part.
  - **governance** (parallel, `fetchDepth: 0` for `--record-misses`): `pnpm governance:check
    --warn-only` with the JSON block kept intact in the log (the AI review plugin reads it), the
    enforced `suppressions-ratchet`, `check:ladder` equivalent if Canvas adopts the trailer; post
    status `evidence-layer/governance`.
- Branch policy: pipeline as optional build validation; statuses visible but not required yet.
- Canvas `scripts/governance-check/lib.ts` `buildTriggerGraph` adds the pipeline YAML as roots
  (or uses phase 2's reader if it is exported), so Canvas DEC invariants can name the pipeline.
- After a sprint clean: require both statuses, flip `--enforce`, and decide whether the Netlify
  governance plugin stays as a second gate or is removed (a Canvas decision record).

### Phase 5 - Canvas review job (Canvas repo, optional status)

- **review**: `dependsOn: evidence`, condition PR, not draft, evidence succeeded. Download the
  artifact into a separate directory; install a pinned `@anthropic-ai/claude-code`; `claude -p`
  with the example's prompt adapted to Canvas (cite `review-evidence.local.md` blocks; Risk Matrix
  and Access Receipt rules stay Canvas's), `--allowedTools Read,Glob,Grep,Write`,
  `--disallowedTools Bash,WebFetch,WebSearch`, `{"disableAllHooks": true}` (the agent-guard and
  runtime-gate hooks are for an interactive session), model from a pipeline variable.
- Then `pnpm exec evidence-layer claims ai-review.md --bundle <artifact> --sha <head> --fix`, the
  same without `--fix` and `--format azure`, then `pnpm verify-review` (Canvas's receipt/sample
  rules), then post the thread with `System.AccessToken` (reuse the `post-pr-comment` skill's REST
  shape in a script, not the skill itself) and status `evidence-layer/review`.
- Steps that print review text run with `target: commands: restricted`.

### Phase 6 - Canvas `pnpm ci:local`

- `scripts/ci-local/index.ts` (TypeScript via tsx - Canvas has no plain-JS constraint) with
  `LOCAL_JOBS` / `NOT_REPRODUCED` exactly as `scripts/ci-local.ts` here:
  - local: evidence (`review-evidence` against `origin/develop`), governance, review
    (`--review-skeleton` / `--review <file>` / model, the model step read from
    `azure-pipelines/evidence.yml`, not copied);
  - `unverifiable`, never a pass: the Netlify build and its plugins (axe, Chromatic, Lighthouse,
    performance need a deploy preview), the PR status/thread posts, the hosted agent's OS when the
    developer is on Windows.
- Windows is the common case at Canvas: spawn `pnpm` with a shell only on win32 and refuse a base
  ref containing cmd.exe metacharacters, as the example does.
- `scripts/ci-local/tests/index.test.ts` holds both lists to the pipeline's jobs.
- `package.json` `ci:local`; README for the folder (add-readme style); mention in `AGENTS.md`.

### Phase 7 - docs and decisions

- Here: DEC-0012 (phase 1), README "Azure Pipelines" section, release notes v0.18.0.
- Canvas: a decision record (add-decision skill) "CI gathers review evidence on Azure Pipelines",
  invariants "enforced by `pnpm review-evidence`" / "`pnpm governance:check`" - now reachable
  from the pipeline via phase 2/4's trigger graph.

## 4. Risks

- **Log injection** is the security-critical part: Azure has no `stop-commands`. Phase 0 must show
  what the agent obeys before phase 1 picks a neutralisation; `restricted` mode is defence in
  depth, not the fix.
- **Token cost**: the review runs on every non-draft PR push; `autoCancel` and the evidence gate
  limit it; small model by default.
- **Pipeline time**: the brand typecheck matrix on hosted agents may be slow; cache the pnpm store
  and `.nuxt` generation where safe, or move typecheck to its own job.
- **Two governance gates** (Netlify + pipeline) can disagree on enforcement mode during the
  transition; keep one source of the mode (a pipeline variable mirrored to `GOVERNANCE_ENFORCE`).

## 5. Open questions for the owner

1. Can Canvas use Azure Pipelines at all (pool, parallel jobs, permissions)? Everything in phases
   4-6 depends on it.
2. Option A (per-job PR statuses) or B (two pipelines)?
3. Keep the Netlify governance plugin once the pipeline enforces?
4. Does the AI review plugin keep reading the build log, or is the pipeline's review job its
   replacement?
