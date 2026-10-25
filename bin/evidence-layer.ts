#!/usr/bin/env node
/**
 * The one executable this package installs.
 *
 * Every command, one name. The alternative - a separate bin per command,
 * `check-claims`, `ci-summary`, `journal-report` - would squat a handful of
 * generic names in every consuming project's `node_modules/.bin`, and none of
 * those names says who is making the claim.
 *
 * The colon-separated aliases (`check:claims`, `journal:report`, ...) are the
 * script names this package used while it lived inside another repository.
 * They are kept because a migration that breaks every consumer's `package.json`
 * on the same day it changes their install path makes the honest upgrade more
 * expensive than pinning the old copy forever.
 *
 * Each command is loaded only when it is the one asked for. An agent's hook
 * starts this executable on every tool call, and a hook that paid to load
 * governance, the journal reader and the CI renderer just to answer "may this
 * file be written" would spend its whole budget on code it never runs.
 *
 * Exit codes are the subcommand's own: 0 clean, 1 failed, 2 bad usage, 3 flaky.
 */
import { EXIT } from '../src/core/cli'

/** Substituted at build time from `package.json`; `test/bin.test.ts` proves the two still agree. */
declare const __EVIDENCE_LAYER_VERSION__: string

const HELP = `
evidence-layer <command> [options]

  claims <review.md>        is every claim in this review backed by evidence?
  receipt <review.md>       was this review written against this repository?
  ci-summary <file>         render captured check output as a CI summary
  governance                is anything actually running the checks?
  journal report            what the checks have actually found, over time
  journal tag <id> ...      mark a finding real or false, or a miss catchable
  hook <host> <event>       the runtime gate, as an agent host's hook runs it
  init claude|codex         add the runtime gate to a project's Claude Code or Codex hooks

  --help                    this text, or a command's own with --help after it
  --version                 the version of this package

exit 0 = clean, 1 = at least one error, 2 = bad usage, 3 = flaky
(hook always exits 0 - its decision is in its output, in the host's protocol)
`

type Command = (argv: string[]) => void | Promise<void>
type Loader = () => Promise<Command>

const claims: Loader = async () => (await import('../src/commands/claims')).run
const receipt: Loader = async () => (await import('../src/commands/receipt')).run
const ciSummary: Loader = async () => (await import('../src/commands/ci-summary')).run
const governance: Loader = async () => (await import('../src/commands/governance')).run
const journalReport: Loader = async () => (await import('../src/commands/journal-report')).run
const journalTag: Loader = async () => (await import('../src/commands/journal-tag')).run
const hook: Loader = async () => (await import('../src/commands/hook')).run
const init: Loader = async () => (await import('../src/commands/init')).run

const COMMANDS: Record<string, Loader> = {
  claims,
  receipt,
  'ci-summary': ciSummary,
  governance,
  hook,
  init,
  // The names these checks had as scripts in the repository this package was
  // extracted from. Same functions, no second implementation to drift.
  'check:claims': claims,
  'check:receipt': receipt,
  'ci:summary': ciSummary,
  'check:all': governance,
  'journal:report': journalReport,
  'journal:tag': journalTag,
}

/** `journal` is the only command with subcommands, so it is resolved separately rather than flattened into a two-word lookup table. */
function resolveJournal(rest: string[]): { load: Loader; argv: string[] } | null {
  const [sub, ...args] = rest
  if (sub === 'report') return { load: journalReport, argv: args }
  if (sub === 'tag') return { load: journalTag, argv: args }
  return null
}

async function main(): Promise<void> {
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
    await (await resolved.load())(resolved.argv)
    return
  }

  const load = COMMANDS[command]
  if (!load) {
    console.error('unknown command: ' + command + '\n')
    console.log(HELP.trim())
    process.exit(EXIT.usage)
  }

  await (await load())(rest)
}

await main()
