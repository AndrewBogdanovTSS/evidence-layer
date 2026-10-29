---
id: DEC-0013
status: accepted
date: 2026-10-29
supersedes: null
invariants:
  - An Azure Pipelines file - `azure-pipelines*.yml` at the root, YAML under `.azure-pipelines/`, `azure-pipelines/`, `.azuredevops/` or `.pipelines/`, and the local templates they include - is a trigger, and a pass it rests on names the file and says no file shows a pipeline runs it; enforced by `pnpm test`.
  - While a pipeline template cannot be read - from another repository, a computed path, a missing file - an invariant nothing readable reaches is `unverifiable`, never an error and never a pass; enforced by `pnpm test`.
review_by: 2027-10-29
enforce_owner: Andrii Bohdanov
---

# DEC-0013: governance reads Azure Pipelines files

## Context

`governance` holds a decision record's "enforced by `pnpm X`" to something
that runs `X` without a person choosing to: a git hook or a GitHub workflow.
A project on Azure DevOps - Canvas, which is moving its review evidence into
Azure Pipelines ([`azure-devops-integration.md`](../plans/azure-devops-integration.md))
- has its CI in pipeline YAML the check never read, so every invariant only a
pipeline enforces would be `governance/unreached`, an error, and the honest
fix would be to stop saying it.

Azure differs from GitHub in two ways that shape the reading:

- **No fixed place, and no automatic run.** A file in `.github/workflows/`
  runs because it is there. An Azure pipeline is created in Azure DevOps and
  pointed at a YAML path; a file no pipeline points at runs nothing.
- **Templates.** A pipeline pulls stages, jobs or steps from other files with
  `template:` - local paths, or files in another repository (`x.yml@tools`),
  or paths computed from parameters.

## Decision

1. **Where.** `azure-pipelines*.yml` at the root - the name Azure DevOps
   suggests - and any YAML under `.azure-pipelines/`, `azure-pipelines/`,
   `.azuredevops/` and `.pipelines/`. Their whole text seeds the trigger graph,
   as a GitHub workflow's does.
2. **Templates.** A local `template:` is read as part of the pipeline,
   resolved as Azure resolves it: against the file naming it, or the
   repository root for `/x.yml`; `@self` is local. A template from another
   repository, with a computed path, or missing is listed as unread.
3. **Unread is unverifiable.** While any template is unread, an invariant
   nothing readable reaches is `governance/template-unread`, `unverifiable` -
   the template might run it. An invariant something readable reaches passes
   regardless.
4. **A pass says what it rests on.** `governance/reached` names the trigger
   file. When it is an Azure file, the detail adds that it runs once a pipeline
   in Azure DevOps points at it, which no file can show. A git hook or GitHub
   workflow that reaches the same script is credited first.

## Why not

- **Make an Azure-only reach `unverifiable`.** Nothing in the repository proves
  a pipeline is registered - but nothing proves a GitHub workflow is enabled
  or a check required either, and those pass. Every Azure-enforced invariant
  reading `unverifiable` forever is noise people learn to skip; a pass that
  names its file and its limit is a claim a reader can weigh.
- **Ask Azure DevOps.** A REST call needs a token and a network in every
  place `governance` runs, the pre-push hook included. What a server is set
  to do is the server's to report.
- **Fetch templates from other repositories.** Same objection, and a template
  repository is pinned by a ref the pipeline resolves at queue time, not here.
- **Search every YAML file in the repository.** Configuration files mention
  commands too, and a `docker-compose.yml` that names `pnpm test` would pass
  an invariant no pipeline enforces.

## Consequences

- An invariant enforced only by an Azure pipeline now passes, naming the file;
  a reader decides whether that file has a pipeline behind it.
- A repository that extends a template from another repository gets
  `unverifiable`, not `error`, for what nothing readable reaches - honest, and
  still not a pass.
- A pipeline file in any other directory is seen only when a recognised one
  includes it as a template.
