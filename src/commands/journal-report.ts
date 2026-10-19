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
import { help, parseArgs, readJournal, stateDir, summariseByCheck, summariseGate, untaggedBlocks } from '../index'

const HELP = `
evidence-layer journal report [--repo <path>] [--include-gate]

Prints the accumulated findings-and-misses journal: per-check real/false/
untagged counts, and open misses awaiting a couldHaveCaught tag.

  --include-gate   also the runtime gate's journal, kept in this checkout's git
                   directory: blocks (and how many were tagged real or false),
                   clean allows, allows without a clean check, refused writes -
                   and each block not yet tagged, by id, ready for \`journal tag\`
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

  if (args['include-gate'] === true) {
    const state = stateDir(repo)
    const gatePath = state ? join(state, 'journal.jsonl') : null
    const entries = gatePath ? readJournal(gatePath) : []
    const g = summariseGate(entries)
    console.log('Runtime gate (this checkout only)')
    console.log('---------------------------------')
    if (g.blocks + g.cleanAllows + g.degradedAllows + g.closedUnchecked + g.denies === 0) {
      console.log('(nothing recorded - the gate has not run in this checkout)')
    } else {
      console.log(
        g.blocks + ' blocked stops (' + g.realBlocks + ' tagged real, ' + g.falseBlocks + ' false), ' +
          g.cleanAllows + ' clean, ' + g.degradedAllows + ' let through without a clean check, ' +
          g.denies + ' refused writes' + (g.medianMs !== null ? ', median ' + g.medianMs + ' ms' : ''),
      )
      if (g.closedUnchecked > 0) {
        console.log(
          g.closedUnchecked + ' blocked episode(s) ended without a clean check (claims removed or review dropped) - ' +
            'an upper bound on escapes, since a change of subject after a block counts too',
        )
      }
      const untagged = untaggedBlocks(entries)
      if (untagged.length > 0) {
        console.log('\nNot yet tagged, newest first (id, time, scope, first finding):')
        for (const b of untagged) console.log(b.id + '  ' + b.ts + '  ' + b.scope + '  ' + b.finding)
      }
      console.log('\nTag a block with: evidence-layer journal tag <id> real|false --gate')
    }
    console.log('')
  }
}
