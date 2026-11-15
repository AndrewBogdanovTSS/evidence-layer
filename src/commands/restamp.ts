/**
 * `evidence-layer restamp <review.md>` - after gathering again, move the
 * review onto the new run in one step.
 *
 * Every block the review carries from an earlier run is replaced by the
 * current run's block for the same step, and the ids in the grade tags that
 * cite it are rewritten to match (see `core/restamp`). Then the result is
 * checked exactly as `claims --seal` would check it, and that verdict is this
 * command's exit code: a predicate the new run does not meet is still an
 * error, because restamping never rewrites what a claim says.
 *
 * `--dry-run` writes nothing, and reports the same.
 *
 * Exit codes: 0 clean - 1 at least one error - 2 bad usage - 3 flaky.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { EXIT, exitCodeFor, formatOf, gradeMix, help, lintClaims, parseArgs, parseReceipt, printFindings, usage } from '../index'
import type { CodedFinding } from '../index'
import { restampReview } from '../core/restamp'
import { readCurrentRun, readKeptRuns } from '../core/seal'
import { heldToSeal } from './claims'

const HELP = `
evidence-layer restamp <review.md> [--repo <path>] [--dry-run] [--format text|json|github|azure]

After gathering again: replaces every artifact block the review carries from
an earlier run with the current run's block for the same step, rewrites the
ids in the grade tags citing it, and checks the result as \`claims --seal\`
does. Never rewrites a claim's sentence or its predicates.

  --repo     the checkout whose sealed runs to read (default: the current directory)
  --dry-run  say what would move and what the check would then find; write nothing
  --format   as for claims; with json, what moved goes to stderr

exit 0 = the restamped review holds, 1 = it does not, 2 = bad usage, 3 = flaky
`

export function run(argv: string[]): void {
  const args = parseArgs(argv)
  if (args.help) help(HELP)
  const format = formatOf(args, HELP)
  const path = (args._ as string[])[0]
  if (!path) usage(HELP)
  if (!existsSync(path)) {
    console.error('no such review file: ' + path)
    process.exit(EXIT.usage)
  }
  const repo = typeof args.repo === 'string' ? args.repo : process.cwd()
  const dryRun = args['dry-run'] === true

  const current = readCurrentRun(repo)
  if (!('run' in current)) {
    // Nothing to move a review onto. Not bad usage - the command was right,
    // the checkout has no run - so it is said the way `claims --seal` says it.
    const findings = heldToSeal('', path, repo, current)
    printFindings(format, 'Restamp ' + path, findings, 'default', 'claims')
    process.exit('none' in current ? EXIT.failed : exitCodeFor(findings))
  }

  const original = readFileSync(path, 'utf8')
  const { markdown, moved, left } = restampReview(original, current.run, readKeptRuns(repo, undefined, current.run.seal.runId))
  // Off stdout for json, which must stay one document. Ids and commands only,
  // never the review's own text: under `github` and `azure` the runner reads this stream.
  const say = format === 'json' ? console.error : console.log
  for (const m of moved) say((dryRun ? 'would move ' : 'moved ') + path + ':' + m.line + '  ' + m.from + ' -> ' + m.to)
  for (const l of left) say('left ' + path + ':' + l.line + '  ' + l.id + ' - ' + l.why)
  if (moved.length === 0) say('nothing to move in ' + path + ' - every block it carries is the current run\'s, or has nothing to move to')
  if (moved.length > 0 && !dryRun) writeFileSync(path, markdown, 'utf8')

  const receipt = parseReceipt(markdown)
  const findings: CodedFinding[] = [
    ...lintClaims(markdown, path, { expectedHeadSha: receipt.headSha, suggestFrom: current.run.bundle }),
    ...heldToSeal(markdown, path, repo, current),
  ]
  if (receipt.headSha !== undefined && receipt.headSha !== current.run.seal.headSha) {
    say(
      'the review\'s Access Receipt names ' + receipt.headSha.slice(0, 7) + ' and the current run was gathered at ' + current.run.seal.headSha.slice(0, 7) +
        ' - if the review is now about that commit, replace its receipt with the bundle\'s "Suggested access receipt"',
    )
  }
  printFindings(format, 'Claims in ' + path + (dryRun ? ', as restamped' : ', restamped'), findings, 'default', 'claims', gradeMix(markdown))
  process.exit(exitCodeFor(findings))
}
