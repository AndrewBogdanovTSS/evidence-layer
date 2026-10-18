/**
 * `evidence-layer claims <review.md>` - is every claim in this review backed?
 *
 * Fully portable: nothing here knows what project it is running in. Copy this
 * file - or point a consuming project's script at it directly - unchanged.
 *
 * Exit codes: 0 clean - 1 at least one error - 2 bad usage.
 */
import { existsSync, readFileSync } from 'node:fs'
import { EXIT, exitCodeFor, formatOf, help, lintClaims, parseArgs, parseReceipt, printJsonReport, report, usage } from '../index'
import { checkFreshness, checkProvenance, readCurrentRun } from '../core/seal'
import type { CodedFinding } from '../index'

const HELP = `
evidence-layer claims <review.md> [--sha <expected-head>] [--seal] [--repo <path>] [--strict]
                                  [--format text|json]

Lints a review for grounding tags and their required backing.

  --sha     expected head commit; falls back to the review's own Access Receipt
  --seal    also hold every cited block to this checkout's sealed run: it must be
            one the gatherer wrote, unedited, and the code must not have changed
            since. Local only - CI has no seal unless it gathers its own.
  --repo    the checkout whose seal to read (default: the current directory)
  --strict  treat warnings and unverifiable findings as failures
  --format  json prints one report document - every finding with its code -
            instead of the text; the exit code is the same either way

exit 0 = every claim is backed, 1 = at least one is not, 2 = bad usage
`

export function run(argv: string[]): void {
  const args = parseArgs(argv)
  if (args.help) help(HELP)
  const format = formatOf(args, HELP)

  const path = (args._ as string[])[0] ?? (typeof args.path === 'string' ? args.path : undefined)
  if (!path) usage(HELP)
  if (!existsSync(path)) {
    console.error('no such review file: ' + path)
    process.exit(EXIT.usage)
  }

  const markdown = readFileSync(path, 'utf8')
  const expectedHeadSha = typeof args.sha === 'string' ? args.sha : parseReceipt(markdown).headSha

  const findings: CodedFinding[] = lintClaims(markdown, path, { expectedHeadSha })
  if (args.seal === true) {
    const repo = typeof args.repo === 'string' ? args.repo : process.cwd()
    const current = readCurrentRun(repo)
    if ('run' in current) {
      findings.push(...checkProvenance(markdown, path, current.run), checkFreshness(repo, current.run))
    } else {
      // Asked for and not there is not a pass: nothing was checked.
      findings.push({
        level: 'none' in current ? 'unverifiable' : 'error',
        code: 'none' in current ? 'seal/no-run' : 'seal/broken',
        claim: 'the cited blocks came from this checkout\'s gatherer',
        detail: 'none' in current ? current.none : current.broken,
      })
    }
  }
  if (format === 'json') printJsonReport(findings, args.strict === true ? 'strict' : 'default', 'claims')
  else report('Claims in ' + path, findings)
  process.exit(exitCodeFor(findings, args.strict === true))
}
