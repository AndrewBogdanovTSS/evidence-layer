/**
 * `pnpm check:all` - every check this repository runs, and then: does anything
 * actually run them?
 *
 * The consumer-side half. Reachability, exceptions, the miss journal and the
 * report format all live in the package - see `src/core/governance.ts`. What
 * lives here is the list only this repository knows: which checks it runs, in
 * what order, and which of them are slow enough to be worth skipping under
 * `--fast`.
 *
 * This file is also the reason the package can claim to be its own first
 * consumer. Every command below runs against the repository that contains the
 * code implementing it, so a check that only worked because of something the
 * project it was born in happened to have would fail here rather than in
 * somebody else's CI.
 *
 * Exit codes: 0 warn-only or clean - 1 --enforce and at least one error -
 * 3 a flaky finding with no error present - 2 bad usage.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXIT,
  checkExceptions,
  checkReachability,
  emitReport,
  help,
  parseArgs,
  recordNewMisses,
  report,
  run,
} from '../src/index'
import type { Finding } from '../src/index'

const HELP = `
pnpm check:all [--enforce] [--fast] [--only <check>] [--repo <path>] [--no-json]

Runs every check in this repository, then verifies that something actually runs them.

  --enforce   exit 1 when any finding is an error (default: warn only)
  --fast      skip the checks that have to run the suite or the build
  --only      run one: docs, tests, fixtures, reachability, exceptions
  --no-json   suppress the machine-readable report block

exit 0 = warn-only or clean, 1 = --enforce and at least one error,
3 = a flaky finding with no error present, 2 = bad usage
`

/** Runs another command in this repo and folds its exit code into one finding, flaky included. */
function runCheck(name: string, command: string, repo: string): Finding {
  const result = run(command, { cwd: repo, timeoutMs: 600_000 })
  console.log(result.output)
  return {
    level: result.exitCode === 0 ? 'pass' : result.exitCode === EXIT.flaky ? 'flaky' : 'error',
    claim: name,
    detail: '`' + command + '` exited ' + result.exitCode,
  }
}

/**
 * The negative fixtures, run as checks in their own right.
 *
 * A check nobody has seen fail is indistinguishable from a check that cannot
 * fail, so the reviews that are wrong on purpose are asserted to *stay* wrong.
 * If `bad-claims.md` ever exits 0, something in the linter quietly stopped
 * working, and without this nobody would find out until it mattered.
 */
function checkFixtures(repo: string): Finding[] {
  const reviews = 'examples/plain-node-project/reviews/'
  const expectations: { file: string; exit: number }[] = [
    { file: 'good-claims.md', exit: EXIT.ok },
    { file: 'bad-claims.md', exit: EXIT.failed },
    { file: 'phantom-artifact.md', exit: EXIT.failed },
    { file: 'shotgun-artifact.md', exit: EXIT.ok },
  ]

  return expectations.map(({ file, exit }): Finding => {
    const result = run('pnpm check:claims ' + reviews + file, { cwd: repo, timeoutMs: 120_000 })
    return {
      level: result.exitCode === exit ? 'pass' : 'error',
      claim: 'fixture ' + file + ' still exits ' + exit,
      detail: result.exitCode === exit ? 'as expected' : 'exited ' + result.exitCode + ' instead',
      file: reviews + file,
      expected: exit,
      observed: result.exitCode,
    }
  })
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) help(HELP)

  const here = fileURLToPath(new URL('.', import.meta.url))
  const repo = typeof args.repo === 'string' ? args.repo : join(here, '..')
  const only = typeof args.only === 'string' ? args.only : undefined
  const fast = args.fast === true
  const enforce = args.enforce === true

  const findings: Finding[] = []

  if (!only || only === 'docs') {
    findings.push(runCheck('README claims', 'pnpm check:docs' + (fast ? ' --fast' : ''), repo))
  }
  if ((!only || only === 'tests') && !fast) {
    findings.push(runCheck('the suite, and the package it builds', 'pnpm test', repo))
  }
  if (!only || only === 'fixtures') findings.push(...checkFixtures(repo))
  if (!only || only === 'reachability') findings.push(...checkReachability(repo))
  if (!only || only === 'exceptions') findings.push(...checkExceptions(repo))

  const newMisses = recordNewMisses(repo, join(repo, 'journal.jsonl'))
  if (newMisses.length > 0) {
    findings.push({
      level: 'warning',
      claim: newMisses.length + ' new miss(es) recorded from commit trailers',
      detail: newMisses.map((m) => m.commit.slice(0, 10) + ' missed by ' + m.check).join('; '),
    })
  }

  report('Governance (' + (enforce ? 'enforcing' : 'warn-only') + ')', findings)

  if (args['no-json'] !== true) emitReport(findings, enforce ? 'enforce' : 'warn')

  const failed = findings.some((f) => f.level === 'error')
  if (failed && !enforce) {
    console.log('\nWarn-only: the above would fail the build once enforcement is on.\n')
  }
  const flaky = !failed && findings.some((f) => f.level === 'flaky')
  process.exit(enforce && failed ? EXIT.failed : flaky ? EXIT.flaky : EXIT.ok)
}

main()
