/**
 * `evidence-layer journal tag <id> real|false` or `... --caught yes|no`
 *
 * Fully portable, same cwd convention as `journal-report.ts`: the journal
 * belongs to whichever project is running this, resolved from `process.cwd()`
 * or `--repo`, never from this file's own location inside the shared package.
 *
 * Tagging happens at the moment of fixing, by whoever fixed it - not as a
 * separate ritual, and not reconstructed later. Reconstructing it later is
 * expensive enough that nobody will do it, which is exactly why the field
 * exists as a one-line command rather than a form.
 *
 * Exit codes: 0 tagged - 1 unknown id - 2 bad usage.
 */
import { join } from 'node:path'
import { EXIT, help, parseArgs, tagEntry, usage } from '../index'

const HELP = `
evidence-layer journal tag <entry-id> real|false          # a check's finding was real or false
evidence-layer journal tag <entry-id> --caught yes|no     # could an existing check have caught this miss
evidence-layer journal tag <entry-id> ... [--repo <path>] # default repo is the current directory
`

export function run(argv: string[]): void {
  const args = parseArgs(argv)
  if (args.help) help(HELP)

  const repo = typeof args.repo === 'string' ? args.repo : process.cwd()
  const journalPath = join(repo, 'journal.jsonl')

  const [id, verdict] = args._ as string[]
  if (!id) usage(HELP)

  const patch =
    args.caught === 'yes' || args.caught === 'no'
      ? { couldHaveCaught: args.caught as 'yes' | 'no' }
      : verdict === 'real' || verdict === 'false'
        ? { verified: verdict as 'real' | 'false' }
        : null
  if (!patch) usage(HELP)

  const ok = tagEntry(journalPath, id, patch)
  if (!ok) {
    console.error('no journal entry with id ' + id)
    process.exit(EXIT.failed)
  }
  console.log('tagged ' + id)
  process.exit(EXIT.ok)
}
