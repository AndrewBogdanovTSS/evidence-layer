/**
 * The exceptions journal - required before `--enforce` means anything.
 *
 * The claim it makes falsifiable: **"this exception is still justified."**
 *
 * Governance is warn-only today. The day it flips to `--enforce`, legitimate
 * exceptions will appear - "confirmed manually," "external blocker," "checked
 * on a call." Without a record, that becomes an oral practice, and warn-only
 * quietly becomes the permanent default because nobody can tell a considered
 * exception from a forgotten one.
 *
 * The format is a markdown table in `docs/governance-exceptions.md`:
 *
 *     | Date | Commit | Issued by | Check | Reason | Expires |
 *     |---|---|---|---|---|---|
 *     | 2026-09-06 | a1b2c3d | you | check:docs | build-size check needs a build nobody has run here | 2026-09-20 |
 *
 * An exception with no expiry date is not a valid exception - see `parseExceptions`.
 * An expired one is a finding on the next run, always, regardless of warn/enforce
 * mode: an exception nobody re-examined is not an active decision any more.
 *
 * This is the one place in the layer where the honest path is not supposed to
 * be the cheap one. Filling in the row is fast; the cost is visibility - the
 * issuer's name and the expiry date are printed on every run, so silently
 * extending an exception by never revisiting it is not an available option.
 * Cheap to write, expensive to leave open: that is the point.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { Finding } from './cli'

export interface Exception {
  date: string
  commit: string
  issuedBy: string
  check: string
  reason: string
  expires: string
}

const ROW_RE = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/

/** Parses the exceptions table. Rows that do not match all six columns are dropped, not guessed at. */
export function parseExceptions(markdown: string): Exception[] {
  const exceptions: Exception[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const m = ROW_RE.exec(line)
    if (!m) continue
    const [, date, commit, issuedBy, check, reason, expires] = m
    if (date === 'Date' || /^-+$/.test(date!)) continue // header / separator row
    exceptions.push({ date: date!, commit: commit!, issuedBy: issuedBy!, check: check!, reason: reason!, expires: expires! })
  }
  return exceptions
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Active and expired counts are printed **every run, including zero**, for the
 * same reason a clean governance report is still printed in full: a silent
 * zero and an unmeasured zero must never look the same.
 */
export function checkExceptions(repo: string, path = 'docs/governance-exceptions.md', today = new Date()): Finding[] {
  const fullPath = repo + '/' + path
  if (!existsSync(fullPath)) {
    return [{ level: 'pass', claim: 'governance exceptions', detail: '0 active, 0 expired (no exceptions file)', file: path }]
  }

  const exceptions = parseExceptions(readFileSync(fullPath, 'utf8'))
  const findings: Finding[] = []
  let active = 0
  let expired = 0

  for (const ex of exceptions) {
    if (!DATE_RE.test(ex.expires)) {
      findings.push({
        level: 'error',
        claim: 'exception for ' + ex.check + ' has a valid expiry date',
        detail: '"' + ex.expires + '" is not a YYYY-MM-DD date - an exception without an expiry is not valid',
        file: path,
      })
      continue
    }
    const isExpired = new Date(ex.expires + 'T00:00:00Z').getTime() < today.getTime()
    if (isExpired) {
      expired += 1
      findings.push({
        level: 'error',
        claim: 'exception for ' + ex.check + ' (issued by ' + ex.issuedBy + ' on ' + ex.date + ') has expired',
        detail: 'expired ' + ex.expires + ' - "' + ex.reason + '". Renew deliberately or fix the underlying check.',
        file: path,
      })
    } else {
      active += 1
    }
  }

  findings.push({
    level: 'pass',
    claim: 'governance exceptions',
    detail: active + ' active, ' + expired + ' expired',
    file: path,
  })
  return findings
}
