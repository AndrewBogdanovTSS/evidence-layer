/**
 * Azure Pipelines output - findings as issues logged on the step, and as a
 * markdown summary on the run.
 *
 * The claim it makes falsifiable: **"what the review says cannot become an
 * instruction to the agent."** The agent reads every line a step prints for a
 * logging command, and finds one anywhere in the line: it looks for `##vso[`
 * with `IndexOf`, not at the line's start (azure-pipelines-agent,
 * `src/Microsoft.VisualStudio.Services.Agent/Command.cs`). So a claim quoting
 * `##vso[task.setvariable ...]` mid-sentence would set a variable. GitHub's
 * answer, `::stop-commands::`, has no Azure counterpart, so every piece of
 * review text printed here is defanged instead: a zero-width space between the
 * two `#`s, which a reader does not see and the agent's ordinal search does
 * not match. The JSON report block gets `#` for the second `#`, which
 * `JSON.parse` turns back into the same text, so a program reading the block
 * loses nothing.
 *
 * What it deliberately does not do: call the Azure DevOps REST API, or set the
 * step's result with `task.complete`. Issues logged by a command land on the
 * step's own timeline record with no token to ask for; the exit code is the
 * text mode's, and the step's result follows from it as for any script.
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Finding, Level } from './cli'

/** `##vso[` and the formatting commands' `##[`, matched loosely: a stricter agent tomorrow is still covered. */
const PREFIX = /##(?=vso\[|\[)/gi

/** Review text as printed: still readable, no longer a command anywhere in the line. */
export function defang(text: string): string {
  return text.replace(PREFIX, '#​#')
}

/**
 * Serialised JSON as printed. Only a JSON string can hold `##`, and `#`
 * inside one parses back to `#` - so the document a program reads is the one
 * that was serialised, byte for byte.
 */
export function defangJson(json: string): string {
  return json.replace(PREFIX, '#\\u0023')
}

/**
 * The agent's own escaping (`CommandStringConvertor.Escape`): `%` first, so the
 * sequences the others become are not escaped a second time. A newline cannot
 * start a second command, and `;` and `]` cannot end a property or the command.
 */
export function escapeAzure(text: string): string {
  return text
    .replace(/%/g, '%AZP25')
    .replace(/;/g, '%3B')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/]/g, '%5D')
}

/**
 * Azure has two issue types and this package has five outcomes - the same
 * squeeze as GitHub's annotations, settled the same way: `unverifiable` and
 * `flaky` are warnings whose message opens with the outcome, because "nobody
 * could check this" must not read as a nit.
 */
const TYPE: Record<Level, 'error' | 'warning' | null> = {
  pass: null,
  warning: 'warning',
  unverifiable: 'warning',
  flaky: 'warning',
  error: 'error',
}

/** One `task.logissue` per finding that is not a pass. */
export function azureIssues(findings: Finding[]): string[] {
  const lines: string[] = []
  for (const f of findings) {
    const type = TYPE[f.level]
    if (!type) continue
    const props = [
      'type=' + type,
      ...(f.file ? ['sourcepath=' + escapeAzure(defang(f.file))] : []),
      ...(f.file && f.line ? ['linenumber=' + f.line] : []),
      ...(f.code ? ['code=' + escapeAzure(f.code)] : []),
    ]
    const outcome = f.level === 'unverifiable' || f.level === 'flaky' ? f.level + ': ' : ''
    const message = outcome + f.claim + ' - ' + f.detail + (f.fix ? '\nFix: ' + f.fix : '')
    lines.push('##vso[task.logissue ' + props.join(';') + ']' + escapeAzure(defang(message)))
  }
  return lines
}

/** A finding whose every piece of review text is defanged, for the human report. */
export function defangFinding(f: Finding): Finding {
  return {
    ...f,
    claim: defang(f.claim),
    detail: defang(f.detail),
    ...(f.file ? { file: defang(f.file) } : {}),
    ...(f.fix ? { fix: defang(f.fix) } : {}),
  }
}

/**
 * Writes the summary where the agent keeps its temporary files and returns the
 * command that attaches it to the run - or null off an agent, where there is
 * nowhere to attach it. The file gets a name of its own per call, so two
 * checks in one step attach two summaries rather than one overwriting the
 * other. The agent does not read an uploaded file for commands, so the
 * markdown needs no defanging.
 */
export function azureSummary(markdown: string, check: string): string | null {
  const dir = process.env.AGENT_TEMPDIRECTORY
  if (!dir) return null
  const path = join(dir, 'evidence-layer-' + check + '-' + randomBytes(4).toString('hex') + '.md')
  writeFileSync(path, markdown, 'utf8')
  return '##vso[task.uploadsummary]' + escapeAzure(path)
}
