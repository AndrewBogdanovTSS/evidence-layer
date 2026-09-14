/**
 * `evidence-layer receipt <review.md>` - was this review written against this repo?
 *
 * Fully portable: nothing here knows what project it is running in.
 *
 * Exit codes: 0 receipt holds - 1 at least one error - 2 bad usage.
 */
import { existsSync, readFileSync } from 'node:fs'
import { EXIT, checkReceipt, exitCodeFor, help, parseArgs, parseReceipt, report, usage } from '../index'

const HELP = `
evidence-layer receipt <review.md> [--repo <path>] [--sha <expected-head>] [--strict]

Checks the Access Receipt at the top of a review against the repository.

  --repo    repository to check against (default: current directory)
  --sha     the head commit the review is supposed to be about; pass it whenever
            something other than the review itself knows the answer
  --strict  treat warnings and unverifiable results as failures

exit 0 = the receipt holds, 1 = it does not, 2 = bad usage
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

  const repo = typeof args.repo === 'string' ? args.repo : process.cwd()
  const markdown = readFileSync(path, 'utf8')
  const findings = checkReceipt(
    parseReceipt(markdown),
    markdown,
    repo,
    typeof args.sha === 'string' ? args.sha : undefined,
  )

  report('Access receipt in ' + path, findings)
  process.exit(exitCodeFor(findings, args.strict === true))
}
