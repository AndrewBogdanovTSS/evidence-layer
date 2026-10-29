---
id: DEC-0012
status: accepted
date: 2026-10-28
supersedes: null
invariants:
  - Under `--format azure`, the only logging commands the agent can find in what a check prints are the `task.logissue` and `task.uploadsummary` lines the package writes - review text, in the report, the issues and the JSON block, is defanged wherever in a line it falls; enforced by `pnpm test`.
  - Every finding that is not a pass becomes exactly one `task.logissue`, `unverifiable` and `flaky` named in its message, and the exit code is the text mode's; enforced by `pnpm test`.
  - The JSON block printed under `--format azure` parses to the same report as under `--format text`; enforced by `pnpm test`.
review_by: 2027-10-28
enforce_owner: Andrii Bohdanov
---

# DEC-0012: Azure Pipelines output, with review text the agent cannot obey

## Context

Projects using this package live on Azure DevOps as well as GitHub. Moving a
project's review evidence into CI there
([`azure-devops-integration.md`](../plans/azure-devops-integration.md)) starts
where DEC-0007 started on GitHub: findings a reader sees on the run, not in the
middle of a log.

Azure's agent takes commands from what a step prints, as GitHub's runner does,
with two differences that matter here:

- **It finds a command anywhere in a line.** `Command.TryParse` in
  azure-pipelines-agent (`src/Microsoft.VisualStudio.Services.Agent/Command.cs`)
  looks for `##vso[` with `IndexOf`, not at the line's start. A claim that
  quotes `##vso[task.setvariable variable=X]y` in the middle of a sentence sets
  a variable; GitHub's runner would print it.
- **Nothing pauses it.** There is no `::stop-commands::`. A step can be run
  with a restricted command set, but that is the pipeline author's setting, not
  something the package can rely on.

## Decision

1. **`--format azure`** on `claims`, `receipt` and `governance`: one
   `##vso[task.logissue]` per finding that is not a pass - `type=error` for
   errors, `type=warning` for the rest, the message opening with
   `unverifiable:` or `flaky:` where that is the outcome - with `sourcepath`,
   `linenumber` and the finding's `code`. Then the usual text report. Then,
   when `AGENT_TEMPDIRECTORY` is set, the markdown summary written there and
   attached with `##vso[task.uploadsummary]`.
2. **Values are escaped as the agent unescapes them**
   (`CommandStringConvertor`): `%` as `%AZP25` first, then `;`, `\r`, `\n`,
   `]`. A newline cannot start a second command and a `]` cannot end the first.
3. **Review text is defanged, not paused.** Every `##vso[` and `##[` in text the
   package prints gets a zero-width space between the two `#`s - invisible to a
   reader, not matched by the agent's ordinal search. `governance`'s JSON block
   gets `#` for the second `#` instead, which `JSON.parse` reads back as
   `#`, so the delimited block other tools extract is unchanged as data.
4. **No REST calls, no `task.complete`.** Issues logged by command land on the
   step's timeline record with no token. The exit code is the text mode's, and
   the step's result follows from it as for any script.
5. **`azure` joins `evidenceLayer.outputFormats`**, so a launcher can check the
   capability rather than a version, as the action does for `github`.

## Why not

- **An Azure DevOps Marketplace task.** The GitHub action exists for projects
  with nothing installed; on Azure a script step running the installed CLI is
  the whole integration, and a Marketplace extension would be a second
  distribution channel without the npm release's provenance - DEC-0007's
  reason for keeping the checks out of the action.
- **Strip `##vso[` instead of defanging it.** The report would then misquote
  the review, and a reader looking for why a claim failed would not find the
  text that failed.
- **Rely on `target: commands: restricted`.** It is a pipeline setting the
  package cannot see: output that is safe only when a setting elsewhere is
  right is not safe. Worth setting in a pipeline as a second layer; not the
  package's answer.
- **Defang under `--format text` too.** Text is for a terminal and a person;
  it prints the review as written, and the README says which format belongs in
  an Azure step.

## Consequences

- An Azure step is `pnpm exec evidence-layer claims review.md --format azure`,
  with `--bundle` and `--sha` when CI gathered.
- A log copied out of Azure carries zero-width spaces inside any `##vso[` the
  review contained. That is the cost of a review that cannot command the agent.
- The rest of the Azure integration - governance reading pipeline YAML, the
  example's Azure pipeline and its `ci:local` - is planned in
  [`azure-devops-integration.md`](../plans/azure-devops-integration.md), not
  decided here.
