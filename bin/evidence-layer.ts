#!/usr/bin/env node
/**
 * The one executable this package installs.
 *
 * Five checks, one name. The alternative - five separate bins called
 * `check-claims`, `ci-summary`, `journal-report` - would squat five generic
 * names in every consuming project's `node_modules/.bin`, and none of those
 * names says who is making the claim.
 *
 * The colon-separated aliases (`check:claims`, `journal:report`, ...) are the
 * script names this package used while it lived inside another repository.
 * They are kept because a migration that breaks every consumer's `package.json`
 * on the same day it changes their install path makes the honest upgrade more
 * expensive than pinning the old copy forever.
 *
 * Exit codes are the subcommand's own: 0 clean, 1 failed, 2 bad usage, 3 flaky.
 */
import { EXIT } from '../src/core/cli'
import * as ciSummary from '../src/commands/ci-summary'
import * as claims from '../src/commands/claims'
import * as governance from '../src/commands/governance'
import * as journalReport from '../src/commands/journal-report'
import * as journalTag from '../src/commands/journal-tag'
import * as receipt from '../src/commands/receipt'

/** Substituted at build time from `package.json`; `test/cli-bin.test.ts` proves the two still agree. */
declare const __EVIDENCE_LAYER_VERSION__: string

const HELP = `
evidence-layer <command> [options]

  claims <review.md>        is every claim in this review backed by evidence?
  receipt <review.md>       was this review written against this repository?
  ci-summary <file>         render captured check output as a CI summary
  governance                is anything actually running the checks?
  journal report            what the checks have actually found, over time
  journal tag <id> ...      mark a finding real or false, or a miss catchable

  --help                    this text, or a command's own with --help after it
  --version                 the version of this package

exit 0 = clean, 1 = at least one error, 2 = bad usage, 3 = flaky
`

type Command = (argv: string[]) => void

const COMMANDS: Record<string, Command> = {
  claims: claims.run,
  receipt: receipt.run,
  'ci-summary': ciSummary.run,
  governance: governance.run,
  // The names these checks had as scripts in the repository this package was
  // extracted from. Same functions, no second implementation to drift.
  'check:claims': claims.run,
  'check:receipt': receipt.run,
  'ci:summary': ciSummary.run,
  'check:all': governance.run,
  'journal:report': journalReport.run,
  'journal:tag': journalTag.run,
}

/** `journal` is the only command with subcommands, so it is resolved separately rather than flattened into a two-word lookup table. */
function resolveJournal(rest: string[]): { run: Command; argv: string[] } | null {
  const [sub, ...args] = rest
  if (sub === 'report') return { run: journalReport.run, argv: args }
  if (sub === 'tag') return { run: journalTag.run, argv: args }
  return null
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2)

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP.trim())
    process.exit(command === undefined ? EXIT.usage : EXIT.ok)
  }

  if (command === '--version' || command === '-v') {
    console.log(__EVIDENCE_LAYER_VERSION__)
    process.exit(EXIT.ok)
  }

  if (command === 'journal') {
    const resolved = resolveJournal(rest)
    if (!resolved) {
      console.error('unknown journal subcommand: ' + (rest[0] ?? '(none)') + '\n')
      console.log(HELP.trim())
      process.exit(EXIT.usage)
    }
    resolved.run(resolved.argv)
    return
  }

  const run = COMMANDS[command]
  if (!run) {
    console.error('unknown command: ' + command + '\n')
    console.log(HELP.trim())
    process.exit(EXIT.usage)
  }

  run(rest)
}

main()
