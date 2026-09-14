/**
 * `evidence-layer ci-summary <captured-output-file>` - render the governance report for CI.
 *
 * Fully portable. Exit codes: 0 always. This renders a report; it does not
 * decide anything.
 */
import { readFileSync } from 'node:fs'
import { EXIT, extractReport, help, parseArgs, renderSummary, usage } from '../index'

const HELP = `
evidence-layer ci-summary <file>

Reads captured governance-check output and writes a markdown summary to stdout.

  <file>   a file containing the output of the governance check

exit 0 always - this renders a report, it does not decide anything
`

export function run(argv: string[]): void {
  const args = parseArgs(argv)
  if (args.help) help(HELP)

  const path = (args._ as string[])[0]
  if (!path) usage(HELP)

  let output = ''
  try {
    output = readFileSync(path, 'utf8')
  } catch {
    process.stdout.write(renderSummary(null, 'warn'))
    process.exit(EXIT.ok)
  }

  const report = extractReport(output)
  process.stdout.write(renderSummary(report, report?.mode ?? 'warn'))
  process.exit(EXIT.ok)
}
