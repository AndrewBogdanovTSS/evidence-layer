/**
 * `evidence-layer claims <review.md>` - is every claim in this review backed?
 *
 * Fully portable: nothing here knows what project it is running in. Copy this
 * file - or point a consuming project's script at it directly - unchanged.
 *
 * Exit codes: 0 clean - 1 at least one error - 2 bad usage.
 */
import { existsSync, readFileSync } from 'node:fs'
import { EXIT, exitCodeFor, help, lintClaims, parseArgs, parseReceipt, report, usage } from '../index'

const HELP = `
evidence-layer claims <review.md> [--sha <expected-head>] [--strict]

Lints a review for grounding tags and their required backing.

  --sha     expected head commit; falls back to the review's own Access Receipt
  --strict  treat warnings as failures

exit 0 = every claim is backed, 1 = at least one is not, 2 = bad usage
`

export function run(argv: string[]): void {
  const args = parseArgs(argv)
  if (args.help) help(HELP)

  const path = (args._ as string[])[0] ?? (typeof args.path === 'string' ? args.path : undefined)
  if (!path) usage(HELP)
  if (!existsSync(path)) {
    console.error('no such review file: ' + path)
    process.exit(EXIT.usage)
  }

  const markdown = readFileSync(path, 'utf8')
  const expectedHeadSha = typeof args.sha === 'string' ? args.sha : parseReceipt(markdown).headSha

  const findings = lintClaims(markdown, path, { expectedHeadSha })
  report('Claims in ' + path, findings)
  process.exit(exitCodeFor(findings, args.strict === true))
}
