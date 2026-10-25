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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXIT,
  checkDecisionHygiene,
  checkExceptions,
  checkReachability,
  emitReport,
  help,
  parseArgs,
  recordNewMisses,
  report,
  run,
} from '../src/index'
import type { Finding, RunResult } from '../src/index'
import { setupLadder } from '../demo/ladder.mjs'

const HELP = `
pnpm check:all [--enforce] [--fast] [--only <check>] [--repo <path>] [--no-json]

Runs every check in this repository, then verifies that something actually runs them.

  --enforce   exit 1 when any finding is an error (default: warn only)
  --fast      skip the checks that have to run the suite or the build
  --only      run one: docs, deps, tests, fixtures, reachability, exceptions, decisions
  --no-json   suppress the machine-readable report block

exit 0 = warn-only or clean, 1 = --enforce and at least one error,
3 = a flaky finding with no error present, 2 = bad usage
`

/** Runs another command in this repo and prints what it said. */
function runPrinted(command: string, repo: string): RunResult {
  const result = run(command, { cwd: repo, timeoutMs: 600_000 })
  // `raw`, not `output`: this is printed for a person to read, and the colour
  // the sub-check emitted is the fastest way to see which line failed.
  console.log(result.raw)
  return result
}

/** Folds a command's exit code into one finding, flaky included. */
function toFinding(name: string, result: RunResult): Finding {
  return {
    level: result.exitCode === 0 ? 'pass' : result.exitCode === EXIT.flaky ? 'flaky' : 'error',
    claim: name,
    detail: '`' + result.command + '` exited ' + result.exitCode,
  }
}

/** Runs another command in this repo and folds its exit code into one finding, flaky included. */
function runCheck(name: string, command: string, repo: string): Finding {
  return toFinding(name, runPrinted(command, repo))
}

/**
 * `check:docs`, handed the suite run this script already made, so that it
 * reads the README's test count from that instead of making a second one.
 * With no run to hand over - `--only docs`, or `--fast`, which skips that
 * claim anyway - it runs exactly as it does on its own.
 */
function checkDocs(repo: string, fast: boolean, suite: RunResult | undefined): Finding {
  const name = 'README claims'
  if (!suite) return runCheck(name, 'pnpm check:docs' + (fast ? ' --fast' : ''), repo)
  const dir = mkdtempSync(join(tmpdir(), 'evidence-layer-suite-'))
  try {
    const file = join(dir, 'output.txt')
    // `output`, not `raw`: the normalised text `check:docs` parses when it
    // runs the suite itself, so the count is read from the same thing.
    writeFileSync(file, suite.output)
    // Quoted the way `check:docs` quotes the CLI's path. The directory is one
    // this script just made, not text from a review, but on Windows it sits
    // under the user's profile, whose name may hold a space.
    return runCheck(name, 'pnpm check:docs --suite-output "' + file + '"', repo)
  } finally {
    rmSync(dir, { recursive: true, force: true })
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
    { file: 'predicate-mismatch.md', exit: EXIT.failed },
  ]

  const findings = expectations.map(({ file, exit }): Finding => {
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
  return [...findings, ...checkLadderFixtures(repo)]
}

/**
 * The ladder demo's two commits, rebuilt on top of HEAD and checked. They are
 * not files but refs (see `demo/ladder.mjs`), so they are recreated first -
 * idempotently, outside `refs/heads/`, touching neither the working tree nor
 * the index. A clone where git refuses that gets `unverifiable`, not a pass.
 */
function checkLadderFixtures(repo: string): Finding[] {
  try {
    setupLadder()
  } catch (error) {
    return [
      {
        level: 'unverifiable',
        claim: 'the ladder fixtures exit what they should',
        detail: 'could not build the fixture commits: ' + (error instanceof Error ? error.message : String(error)),
      },
    ]
  }
  const expectations = [
    { ref: 'demo/ladder-bad', exit: EXIT.failed },
    { ref: 'demo/ladder-refactor', exit: EXIT.ok },
  ]
  return expectations.map(({ ref, exit }): Finding => {
    const result = run('pnpm check:ladder ' + ref, { cwd: repo, timeoutMs: 120_000 })
    return {
      level: result.exitCode === exit ? 'pass' : 'error',
      claim: 'fixture ' + ref + ' still exits ' + exit,
      detail: result.exitCode === exit ? 'as expected' : 'exited ' + result.exitCode + ' instead',
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

  // The suite first, and once. `check:docs` needs a suite run to read the
  // README's test count from, and it used to make its own: two full runs of
  // the same suite at the same commit, minutes each on Windows. Going first
  // also means the docs check reads the CLI this run just built, not whatever
  // the previous build left in `dist/`.
  const suite = (!only || only === 'tests') && !fast ? runPrinted('pnpm test', repo) : undefined
  if (suite) findings.push(toFinding('the suite, and the package it builds', suite))
  if (!only || only === 'docs') findings.push(checkDocs(repo, fast, suite))
  if (!only || only === 'deps') {
    findings.push(runCheck('package.json dependencies', 'pnpm check:deps', repo))
  }
  if (!only || only === 'fixtures') findings.push(...checkFixtures(repo))
  if (!only || only === 'reachability') findings.push(...checkReachability(repo))
  if (!only || only === 'exceptions') findings.push(...checkExceptions(repo))
  if (!only || only === 'decisions') findings.push(...checkDecisionHygiene(repo))

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
