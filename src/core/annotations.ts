/**
 * GitHub Actions output - findings as annotations on the changed lines, and as
 * a table in the job summary.
 *
 * The claim it makes falsifiable: **"what the review says cannot become an
 * instruction to the runner."** A runner reads every line of a step's stdout
 * for workflow commands (`::error::`, `::add-mask::`, `::stop-commands::`), and
 * the text printed here is a review's own words - written by an agent, or by
 * the author of a pull request from a fork. So every value that goes into a
 * command is escaped the way the runner un-escapes it (a newline cannot start a
 * second command), and the human report printed after the annotations runs
 * under `::stop-commands::` with a token chosen per run, so a line of review
 * text that looks like a command is printed, not obeyed.
 *
 * What it deliberately does not do: call the GitHub API. Annotations made by
 * workflow commands land on the job's own check run, on the commit the job ran
 * for, with no token and no permission to ask for. A separate Check Run would
 * need `checks: write` and a second account of the same result.
 */
import { randomBytes } from 'node:crypto'
import { summarise } from './cli'
import type { Finding, Level } from './cli'

/** The runner's own escaping for a command's message. */
export function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/** A property value (`file=`, `title=`) additionally cannot contain `:` or `,`. */
export function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

/**
 * GitHub has three annotation levels and this package has five outcomes.
 * `unverifiable` and `flaky` are not passes, so they are not silent; they are
 * not errors either, so they are warnings - and the title says which, because
 * a warning that is really "nobody could check this" must not read as a nit.
 */
const COMMAND: Record<Level, string | null> = {
  pass: null,
  warning: 'warning',
  unverifiable: 'warning',
  flaky: 'warning',
  error: 'error',
}

/** One workflow command per finding that is not a pass. */
export function annotations(findings: Finding[]): string[] {
  const lines: string[] = []
  for (const f of findings) {
    const command = COMMAND[f.level]
    if (!command) continue
    const title = (f.level === 'unverifiable' || f.level === 'flaky' ? f.level + ': ' : '') + (f.code ?? f.claim)
    const props = [
      ...(f.file ? ['file=' + escapeProperty(f.file)] : []),
      ...(f.file && f.line ? ['line=' + f.line] : []),
      'title=' + escapeProperty(title),
    ]
    lines.push('::' + command + ' ' + props.join(',') + '::' + escapeData(f.claim + ' - ' + f.detail))
  }
  return lines
}

/** A token the review text cannot know in advance, so it cannot end the pause. */
export function stopToken(): string {
  return randomBytes(16).toString('hex')
}

const ICON: Record<Level, string> = { pass: '✅', warning: '⚠️', error: '❌', unverifiable: '❓', flaky: '🔁' }

const cell = (text: string): string => text.replace(/\r?\n\s*/g, ' · ').replace(/\|/g, '\\|')

/**
 * The job summary: the verdict, the counts, and every finding that is not a
 * pass. Passes are counted, not listed - a summary that lists forty green rows
 * hides the one red one, and the log still has all of them.
 */
export function renderFindingsSummary(title: string, findings: Finding[]): string {
  const errors = findings.filter((f) => f.level === 'error').length
  const verdict = errors > 0 ? '❌ ' + title + ': ' + errors + ' failing' : '✅ ' + title
  const problems = findings.filter((f) => f.level !== 'pass')
  const lines = ['## ' + verdict, '', '`' + summarise(findings) + '`', '']
  if (problems.length > 0) {
    lines.push('| | Code | Claim | Detail | Where |', '|---|---|---|---|---|')
    for (const f of problems) {
      const where = f.file ? '`' + f.file + (f.line ? ':' + f.line : '') + '`' : ''
      lines.push('| ' + ICON[f.level] + ' | `' + (f.code ?? '') + '` | ' + cell(f.claim) + ' | ' + cell(f.detail) + ' | ' + where + ' |')
    }
    lines.push('')
  }
  return lines.join('\n') + '\n'
}
