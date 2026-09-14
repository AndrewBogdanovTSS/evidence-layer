/**
 * `ci:summary` core - render the governance report for a CI job summary.
 *
 * The claim it makes falsifiable: **"the checks ran."**
 *
 * `check:all` prints a delimited JSON block on every run, including a clean
 * one. This is the consumer that block exists for. It turns the report into
 * the markdown GitHub (or any CI that accepts markdown) renders at the top of
 * a workflow run, so the result is visible without opening a log.
 *
 * The important branch is the one for a missing report. It does not shrug and
 * print nothing - it says so, loudly, because an absent report is the only
 * signal anyone has for "never ran," and telling that apart from "checked,
 * found nothing" is the whole discipline this layer is built around.
 */
import { summarise } from './cli'
import type { Finding } from './cli'

export const JSON_BEGIN = '---GOVERNANCE-JSON-BEGIN---'
export const JSON_END = '---GOVERNANCE-JSON-END---'

/**
 * Bumped when the shape changes in a way a reader could notice.
 *
 * 1 - the original block.
 * 2 - unchanged shape, emitted unconditionally rather than only on failure.
 * 3 - findings carry `line`, and the optional `expected`/`observed` values.
 */
export const REPORT_SCHEMA = 3

export interface ReportFinding {
  level: string
  claim: string
  detail: string
  file?: string
  line?: number
  expected?: unknown
  observed?: unknown
}

export interface Report {
  schema: number
  mode: string
  generatedAt: string
  summary: string
  findings: ReportFinding[]
}

/**
 * Builds the report a check emits alongside its human output.
 *
 * Producer and consumer live in the same file deliberately. The block is a
 * contract between two programs, and a contract whose two halves are written in
 * different places drifts - which is exactly what had already happened: the
 * delimiters were declared here *and* retyped as string literals in the script
 * that emits them, so the only thing keeping them equal was that nobody had
 * edited one of the two.
 */
export function buildReport(findings: Finding[], mode: string): Report {
  return {
    schema: REPORT_SCHEMA,
    mode,
    generatedAt: new Date().toISOString(),
    summary: summarise(findings),
    findings: findings.map((f) => ({
      level: f.level,
      claim: f.claim,
      detail: f.detail,
      file: f.file,
      line: f.line,
      expected: f.expected,
      observed: f.observed,
    })),
  }
}

/** Prints the delimited block. The delimiters are why this is greppable in a CI log. */
export function emitReport(findings: Finding[], mode: string): void {
  console.log(JSON_BEGIN)
  console.log(JSON.stringify(buildReport(findings, mode)))
  console.log(JSON_END)
}

/** Pulls the machine-readable block out of a pile of console output. */
export function extractReport(output: string): Report | null {
  const start = output.indexOf(JSON_BEGIN)
  const end = output.indexOf(JSON_END)
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(output.slice(start + JSON_BEGIN.length, end).trim()) as Report
  } catch {
    return null
  }
}

const ICON: Record<string, string> = {
  pass: '✅',
  warning: '⚠️',
  error: '❌',
  unverifiable: '❓',
  flaky: '🔁',
}

export function renderSummary(report: Report | null, mode: string): string {
  if (!report) {
    return [
      '## ❌ Governance: no report',
      '',
      'The run produced no machine-readable report block.',
      '',
      'That is not the same as a clean run. A clean run still prints its report -',
      'that is the entire reason the block is emitted unconditionally. An absent',
      'report means the checks **did not run**, and nothing here can tell you what',
      'the repository looks like.',
      '',
    ].join('\n')
  }

  const errors = report.findings.filter((f) => f.level === 'error').length
  const warnings = report.findings.filter((f) => f.level === 'warning').length
  const unknown = report.findings.filter((f) => f.level === 'unverifiable').length
  const flaky = report.findings.filter((f) => f.level === 'flaky').length

  const verdict =
    errors > 0
      ? mode === 'enforce'
        ? '❌ Governance: ' + errors + ' failing'
        : '⚠️ Governance: ' + errors + ' would fail once enforcement is on'
      : '✅ Governance: clean'

  const lines = [
    '## ' + verdict,
    '',
    '`' + report.summary + '` &middot; mode `' + report.mode + '` &middot; ' + report.generatedAt,
    '',
    '| | Claim | Detail | Where |',
    '|---|---|---|---|',
  ]

  for (const f of report.findings) {
    const where = f.file ? '`' + f.file + '`' : ''
    const detail = f.detail.replace(/\r?\n\s*/g, ' &middot; ').replace(/\|/g, '\\|')
    lines.push(
      '| ' + (ICON[f.level] ?? f.level) + ' | ' + f.claim.replace(/\|/g, '\\|') + ' | ' + detail + ' | ' + where + ' |',
    )
  }

  lines.push('')
  if (errors === 0 && warnings === 0 && unknown === 0 && flaky === 0) {
    lines.push('Every invariant that claims enforcement is reachable from a wired trigger.')
  }
  if (mode !== 'enforce' && errors > 0) {
    lines.push(
      'Warn-only: the build stays green. Enforcement is one flag - add `--enforce` to the',
      'governance step and delete its `continue-on-error`.',
    )
  }
  lines.push('')
  return lines.join('\n')
}
