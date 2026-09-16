/**
 * Decision-record hygiene - the review date every decision record already
 * declares, finally checked rather than trusted.
 *
 * The claim it makes falsifiable: **"this decision is still current."**
 *
 * `docs/governance-exceptions.md` already gets this treatment: an exception
 * with no expiry is not valid, and an expired one is a finding on every run -
 * see `exceptions.ts`. A decision record makes the identical promise about
 * itself, in the same frontmatter `readInvariants` already reads: every
 * record this package ships carries a `review_by` date, and
 * `docs/decisions/archive/README.md` explains why a superseded one moves to
 * `archive/` rather than being edited in place - a decision record is a dated
 * artifact, and the date is the whole point.
 *
 * What was missing is the check. Nothing previously noticed an `accepted`
 * record whose `review_by` date had quietly passed while it kept sitting in
 * the directory `readInvariants` treats as live - the same gap the
 * exceptions file closed for exceptions, still open for the records that
 * govern them.
 *
 * Scans the same directory `readInvariants` does (`docs/decisions/`, not
 * `archive/` beneath it) for the same reason: an archived record's date is
 * expected to be in the past, by design, and flagging it would be true and
 * useless.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Finding } from './cli'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Top-level `key: value` frontmatter lines only. A list item's `  - ` indent
 * excludes it by construction - this is not meant to read `invariants:`, only
 * the scalar fields sitting alongside it.
 */
function parseFrontmatterFields(text: string): Record<string, string> {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fields: Record<string, string> = {}
  if (!front) return fields
  for (const line of front[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z_]+):\s*(.+?)\s*$/.exec(line)
    if (field) fields[field[1]!] = field[2]!
  }
  return fields
}

/**
 * Active and stale counts are printed **every run, including zero**, for the
 * same reason `checkExceptions` prints 0 active/0 expired rather than saying
 * nothing: a silent zero and an unmeasured zero must never look the same.
 *
 * A record with no `status:` field gets a warning, not an error - the
 * frontmatter is malformed, but that is a weaker claim than "this specific
 * decision has gone stale." A record whose status is not `accepted` (rare -
 * most decisions live here already accepted, or are archived once
 * superseded) is reported rather than skipped, so every file this scanned is
 * still visible in the output.
 */
export function checkDecisionHygiene(repo: string, decisionsDir?: string, today: Date = new Date()): Finding[] {
  const dir = decisionsDir ?? join(repo, 'docs', 'decisions')
  if (!existsSync(dir)) {
    return [{ level: 'pass', claim: 'decision record hygiene', detail: '0 active, 0 stale (no decisions directory)' }]
  }

  const findings: Finding[] = []
  let active = 0
  let stale = 0

  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const file = relative(repo, join(dir, name)).replace(/\\/g, '/')
    const fields = parseFrontmatterFields(readFileSync(join(dir, name), 'utf8'))
    const id = fields.id ?? name
    const status = fields.status

    if (!status) {
      findings.push({ level: 'warning', claim: id + ' declares a status', detail: 'no `status:` field in the frontmatter', file })
      continue
    }
    if (status !== 'accepted') {
      findings.push({
        level: 'pass',
        claim: id + ' review date',
        detail: 'status is `' + status + '`, not `accepted` - a review date does not apply',
        file,
      })
      continue
    }

    const reviewBy = fields.review_by
    if (!reviewBy || !DATE_RE.test(reviewBy)) {
      findings.push({
        level: 'error',
        claim: id + ' has a valid review_by date',
        detail:
          (reviewBy ? '"' + reviewBy + '"' : 'no `review_by` field') +
          ' is not a YYYY-MM-DD date - an accepted decision without a review date is not a valid decision',
        file,
      })
      continue
    }

    const isStale = new Date(reviewBy + 'T00:00:00Z').getTime() < today.getTime()
    if (isStale) {
      stale += 1
      findings.push({
        level: 'error',
        claim: id + ' is still current',
        detail:
          'review_by ' + reviewBy + ' has passed - re-ratify with a new date, or move it to docs/decisions/archive/ if it has been superseded',
        file,
      })
    } else {
      active += 1
      findings.push({ level: 'pass', claim: id + ' is still current', detail: 'accepted, review by ' + reviewBy, file })
    }
  }

  findings.push({ level: 'pass', claim: 'decision record hygiene', detail: active + ' active, ' + stale + ' stale' })
  return findings
}
