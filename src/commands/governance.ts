/**
 * `evidence-layer governance` - does anything actually run the checks, and is
 * what it's running still current?
 *
 * The three checks in this package that need no configuration and no adapter:
 * reachability (every invariant a decision record declares must be reachable
 * from a git hook or a CI workflow), exceptions (every governance exception
 * must carry an expiry date that has not passed) and decision hygiene (every
 * accepted decision record must carry a review date that has not passed
 * either - the same discipline exceptions already get, extended to the
 * records that govern them).
 *
 * It also records every `Missed-By:` commit trailer into `<repo>/journal.jsonl`
 * on every run, so a miss is counted whether or not anyone remembered to log
 * it. The write is idempotent - a trailer already in the journal is never
 * added twice - and `--no-journal` turns it off for a run that must leave the
 * tree untouched.
 *
 * What deliberately is *not* here: running a project's other checks. Which
 * checks a repository runs, in what order, and which of them are slow enough
 * to skip is a fact about that repository - it belongs in that repository's
 * own script, the way `scripts/governance.ts` does in this one.
 *
 * Exit codes: 0 clean or warn-only - 1 --enforce and at least one error -
 * 3 flaky - 2 bad usage.
 */
import { join } from 'node:path'
import {
  checkDecisionHygiene,
  checkExceptions,
  checkReachability,
  emitReport,
  exitCodeFor,
  help,
  parseArgs,
  recordNewMisses,
  report,
  usage,
} from '../index'
import type { Finding } from '../index'

const HELP = `
evidence-layer governance [--repo <path>] [--decisions <dir>] [--enforce] [--no-json] [--no-journal]

Checks that the invariants your decision records declare are actually wired to
something that runs, that no governance exception has quietly expired, and
that no accepted decision record has gone past its own review date. Records
every Missed-By: commit trailer into <repo>/journal.jsonl, once each.

  --repo        repository root (default: current directory)
  --decisions   directory of decision records (default: <repo>/docs/decisions)
  --exceptions  exceptions file, relative to the repo (default: docs/governance-exceptions.md)
  --enforce     exit 1 when any finding is an error (default: warn only)
  --no-json     suppress the machine-readable report block
  --no-journal  do not record Missed-By trailers - leave the tree untouched

exit 0 = clean or warn-only, 1 = --enforce and an error, 3 = flaky, 2 = bad usage
`

export function run(argv: string[]): void {
  const args = parseArgs(argv)
  if (args.help) help(HELP)
  if ((args._ as string[]).length > 0) usage(HELP)

  const repo = typeof args.repo === 'string' ? args.repo : process.cwd()
  const decisions = typeof args.decisions === 'string' ? args.decisions : join(repo, 'docs', 'decisions')
  const exceptions = typeof args.exceptions === 'string' ? args.exceptions : undefined

  const findings: Finding[] = [
    ...checkReachability(repo, decisions),
    ...(exceptions ? checkExceptions(repo, exceptions) : checkExceptions(repo)),
    ...checkDecisionHygiene(repo, decisions),
  ]

  if (args['no-journal'] !== true) {
    const newMisses = recordNewMisses(repo, join(repo, 'journal.jsonl'))
    if (newMisses.length > 0) {
      findings.push({
        level: 'warning',
        claim: newMisses.length + ' new miss(es) recorded from commit trailers',
        detail: newMisses.map((m) => m.commit.slice(0, 10) + ' missed by ' + m.check).join('; '),
      })
    }
  }

  const mode = args.enforce === true ? 'enforce' : 'warn'
  report('Governance in ' + repo, findings)
  if (args['no-json'] !== true) emitReport(findings, mode)

  process.exit(mode === 'enforce' ? exitCodeFor(findings) : 0)
}
