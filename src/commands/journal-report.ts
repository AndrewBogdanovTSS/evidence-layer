/**
 * `evidence-layer journal report` - what has the evidence layer actually found?
 *
 * Fully portable, with one convention: run it from the consuming project's
 * root (as `pnpm journal:report` always does - pnpm scripts run with cwd set
 * to the package.json that owns them), or pass `--repo` explicitly. The
 * default is `process.cwd()`, not a path relative to this file - this file
 * moved into the shared package, but the journal it reads always belongs to
 * whichever project is running it, never to this package's own directory.
 */
import { join } from 'node:path'
import { help, parseArgs, readJournal, summariseByCheck } from '../index'

const HELP = `
evidence-layer journal report [--repo <path>]

Prints the accumulated findings-and-misses journal: per-check real/false/
untagged counts, and open misses awaiting a couldHaveCaught tag.
`

export function run(argv: string[]): void {
  const args = parseArgs(argv)
  if (args.help) help(HELP)

  const repo = typeof args.repo === 'string' ? args.repo : process.cwd()
  const journalPath = join(repo, 'journal.jsonl')

  const rows = summariseByCheck(journalPath)
  console.log('\nFindings, by check')
  console.log('------------------')
  if (rows.length === 0) {
    console.log('(empty - nothing has run against journal.jsonl yet, or it does not exist)')
  }
  for (const r of rows) {
    console.log(
      r.check +
        ': ' +
        r.runs +
        ' runs, ' +
        r.realFindings +
        ' real, ' +
        r.falseFindings +
        ' false, ' +
        r.untagged +
        ' untagged, ' +
        r.flaky +
        ' flaky',
    )
  }

  const misses = readJournal(journalPath).filter((e) => e.outcome === 'miss')
  console.log('\nMisses (bugs that got past a clean review)')
  console.log('-------------------------------------------')
  if (misses.length === 0) {
    console.log('(none recorded - see AGENTS.md for the Missed-By: commit trailer convention)')
  }
  for (const m of misses) {
    const tag = m.couldHaveCaught ?? 'untagged'
    console.log(m.commit.slice(0, 10) + '  missed by ' + m.check + '  [' + tag + ']  id=' + m.id)
  }
  console.log('')
}
