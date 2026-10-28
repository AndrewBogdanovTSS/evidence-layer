/**
 * `evidence-layer claims <review.md>` - is every claim in this review backed?
 *
 * Fully portable: nothing here knows what project it is running in. Copy this
 * file - or point a consuming project's script at it directly - unchanged.
 *
 * `--fix` writes to the review: every claim an error failed is marked
 * UNVERIFIED, and the review is checked again. It is the one fix that needs
 * no judgement, so it is the one this applies; every other fix is printed
 * beside its finding for the writer to make.
 *
 * `--bundle` holds every cited block to a bundle file instead of a checkout's
 * seal - the one a CI gather job uploaded, wherever the review was written.
 * A bundle that is not there is bad usage, never a pass.
 *
 * Exit codes: 0 clean - 1 at least one error - 2 bad usage.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { EXIT, downgradeClaims, exitCodeFor, formatOf, help, lintClaims, parseArgs, parseReceipt, printFindings, usage } from '../index'
import { checkFreshness, checkProvenance, readCurrentRun } from '../core/seal'
import { checkBundle, readBundle } from '../core/bundle'
import type { CodedFinding } from '../index'

const HELP = `
evidence-layer claims <review.md> [--sha <expected-head>] [--seal] [--bundle <file>] [--repo <path>]
                                  [--fix] [--strict] [--format text|json|github|azure]

Lints a review for grounding tags and their required backing.

  --sha     expected head commit; falls back to the review's own Access Receipt,
            then to the head the --bundle names
  --seal    also hold every cited block to this checkout's sealed run: it must be
            one the gatherer wrote, unedited, and the code must not have changed
            since. Local only - CI has no seal unless it gathers its own.
  --bundle  also hold every cited block to this evidence bundle - the one a CI
            gather job uploaded - wherever the review was written: it must be
            in the bundle, unedited. Does not check freshness; pass --sha
  --repo    the checkout whose seal to read (default: the current directory)
  --fix     mark every claim an error failed UNVERIFIED, in the review itself,
            then check it again. Never rewrites a sentence or a predicate - the
            claim stays as written, and its grade says nothing backs it
  --strict  treat warnings and unverifiable findings as failures
  --format  json prints one report document - every finding with its code -
            instead of the text; github adds annotations and a job summary to
            the text, for a GitHub Actions step; azure adds logged issues and a
            run summary, for an Azure Pipelines step. The exit code is the same

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

  const repo = typeof args.repo === 'string' ? args.repo : process.cwd()
  const current = args.seal === true ? readCurrentRun(repo) : undefined
  if (args.bundle !== undefined && typeof args.bundle !== 'string') usage(HELP)
  if (typeof args.bundle === 'string' && !existsSync(args.bundle)) {
    console.error('no such bundle file: ' + args.bundle)
    process.exit(EXIT.usage)
  }
  const given = typeof args.bundle === 'string' ? readBundle(args.bundle) : undefined
  const check = (markdown: string): CodedFinding[] => {
    const bundle = given && 'bundle' in given ? given.bundle : undefined
    const expectedHeadSha = typeof args.sha === 'string' ? args.sha : parseReceipt(markdown).headSha ?? bundle?.headSha
    // With a seal or a bundle there is a bundle to suggest runs from; without one, nothing local is read.
    const suggestFrom = current && 'run' in current ? current.run.bundle : bundle?.text
    const findings: CodedFinding[] = lintClaims(markdown, path, { expectedHeadSha, suggestFrom })
    if (bundle) findings.push(...checkBundle(markdown, path, bundle))
    else if (given && 'broken' in given) {
      findings.push({ level: 'error', code: 'bundle/broken', claim: 'the cited blocks are the ones in ' + args.bundle, detail: given.broken })
    }
    if (current === undefined) return findings
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
    return findings
  }

  let findings = check(readFileSync(path, 'utf8'))
  if (args.fix === true) {
    const { markdown, downgraded } = downgradeClaims(readFileSync(path, 'utf8'), findings)
    if (downgraded.length > 0) {
      writeFileSync(path, markdown, 'utf8')
      findings = check(markdown)
    }
    // Off stdout for json, which must stay one document. Never the review's own
    // text: under `--format github` or `azure` the runner reads stderr for commands too.
    const say = format === 'json' ? console.error : console.log
    for (const d of downgraded) say('marked UNVERIFIED: ' + path + ':' + d.line + ' (' + d.code + ')')
    if (downgraded.length === 0) say('nothing to mark UNVERIFIED in ' + path)
  }
  printFindings(format, 'Claims in ' + path, findings, args.strict === true ? 'strict' : 'default', 'claims')
  process.exit(exitCodeFor(findings, args.strict === true))
}
