/**
 * `pnpm ci:local` - what this repository's CI would report, before you push.
 *
 * The claim it makes falsifiable: "this branch passes CI", checked here by
 * running each job of `.github/workflows/ci.yml` that a machine can run, in an
 * order that respects what each one reads - and naming, as `unverifiable`,
 * each one it cannot.
 *
 *   phase 1, side by side:  typecheck  |  check:all --enforce (builds dist/, runs the suite)  |  check:ladder per commit
 *   phase 2, side by side:  smoke  |  the action on a fixture review  |  the example's handoff (its own ci:local)
 *
 * Phase 2 waits because it reads `dist/`, which `check:all`'s `pnpm test`
 * rebuilds - run beside it, a job could read a build half-written. Ladder and
 * typecheck read only the source, so they run beside `check:all`.
 *
 * What it deliberately does not do:
 *   - run the Node matrices. CI runs the suite on 22 and 24 and the build on
 *     bare 22.0.0, 22 and 24; this runs on whichever Node runs it, and says so.
 *   - run `action-from-npm`, which fetches the published package - a check of
 *     the last release, not of this checkout.
 *   - start from a clean checkout. It runs on the working tree, and says so
 *     when that differs from the commit.
 *
 * `LOCAL_JOBS` and `NOT_REPRODUCED` name every CI job, and
 * `test/ci-local.test.ts` holds them to the workflow: a job added to CI and
 * not here fails there, rather than going unrun here in silence. The test does
 * not run this script - the script runs the suite, and the suite would run it.
 *
 * Exit codes: 0 every job that ran passed - 1 a job failed - 3 flaky - 2 bad usage.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exitCodeFor, gitCapture, help, parseArgs, report, runAsync, usage } from '../src/index'
import type { Finding } from '../src/index'

const HELP = `
pnpm ci:local [--base <ref>]

Runs this repository's CI jobs on this machine and reports them the way CI
would: typecheck, check:all --enforce and check:ladder side by side, then smoke,
the action on a fixture review and the example's handoff.

  --base  where the commits check:ladder checks start (default origin/master,
          else master) - CI checks every commit a push or pull request brings

exit 0 = every job that ran passed, 1 = a job failed, 3 = flaky, 2 = bad usage
`

/** Each local job, and the CI jobs (`.github/workflows/ci.yml`) whose steps it runs. */
export const LOCAL_JOBS = [
  { name: 'typecheck', ci: ['build'] },
  { name: 'check:all --enforce', ci: ['build', 'test', 'governance'] },
  { name: 'check:ladder, on every new commit', ci: ['governance'] },
  { name: 'smoke', ci: ['smoke'] },
  { name: 'the action, on a fixture review', ci: ['governance'] },
  { name: 'the example\'s handoff', ci: ['example-evidence', 'example-review'] },
] as const satisfies readonly { name: string; ci: readonly string[] }[]

/** CI jobs with nothing here to stand for them, and why. Reported as `unverifiable`, never as a pass. */
export const NOT_REPRODUCED: Record<string, string> = {
  'action-from-npm': 'fetches the published package from npm - it checks the last release, not this checkout',
}

type JobName = (typeof LOCAL_JOBS)[number]['name']

interface Outcome {
  code: number | null
  output: string
  detail: string
}

const LONG = 1_200_000

/** One command, its output captured and printed with colour once it ends, so jobs side by side do not interleave. */
async function step(repo: string, command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const res = await runAsync(command, { cwd: opts.cwd ?? repo, env: opts.env, args, timeoutMs: LONG })
  return { code: res.stopped ? null : res.exitCode, output: res.raw, line: res.command + (res.stopped ? ' (' + res.stopped + ')' : '') }
}

/** Jobs that are several commands: the first that fails ends the job, as a failing step ends a CI job. */
async function steps(...run: (() => ReturnType<typeof step>)[]): Promise<Outcome> {
  let output = ''
  let last = ''
  for (const next of run) {
    const res = await next()
    output += '$ ' + res.line + '\n' + res.output + (res.output.endsWith('\n') ? '' : '\n')
    last = res.line
    if (res.code !== 0) return { code: res.code, output, detail: '`' + res.line + '` ' + (res.code === null ? 'was stopped' : 'exited ' + res.code) }
  }
  return { code: 0, output, detail: run.length === 1 ? '`' + last + '` exited 0' : run.length + ' commands, each exited 0' }
}

function ladderBase(repo: string, named: string | undefined): string | undefined {
  const resolves = (ref: string) => gitCapture(['rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}'], repo) !== null
  if (named !== undefined) return resolves(named) ? named : usage(HELP)
  return ['origin/master', 'master'].find(resolves)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) help(HELP)
  if (args.base !== undefined && typeof args.base !== 'string') usage(HELP)
  const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
  const head = gitCapture(['rev-parse', 'HEAD'], repo)
  if (!head) usage(HELP)
  const dirty = (gitCapture(['status', '--porcelain'], repo) ?? '') !== ''
  const base = ladderBase(repo, args.base as string | undefined)

  console.log('ci:local - the jobs of .github/workflows/ci.yml, at ' + head.slice(0, 10) + ', on Node ' + process.versions.node)
  if (dirty) console.log('the working tree has uncommitted changes: they are in this run, and would not be in CI\'s')

  const outcomes = new Map<JobName, Outcome>()
  const finish = (name: JobName) => (outcome: Outcome) => {
    outcomes.set(name, outcome)
    console.log('\n=== ' + name + ' ' + '='.repeat(Math.max(0, 66 - name.length)))
    process.stdout.write(outcome.output)
    console.log((outcome.code === 0 ? 'done: ' : 'FAILED: ') + outcome.detail)
  }

  // Everything a commit range covers, oldest first, merges left out - the loop CI's governance job runs.
  const commits = base ? (gitCapture(['rev-list', '--no-merges', '--reverse', base + '..HEAD'], repo) ?? '').split('\n').filter(Boolean) : [head]
  const ladder = async (): Promise<Outcome> => {
    if (commits.length === 0) return { code: 0, output: '', detail: 'no commits beyond ' + base + ' to check' }
    const out = await steps(...commits.map((c) => () => step(repo, 'pnpm', ['check:ladder', c])))
    const range = base ? commits.length + ' commit(s) beyond ' + base : 'HEAD alone - neither origin/master nor master resolves'
    return { ...out, detail: out.code === 0 ? range + ', each passing' : out.detail }
  }

  console.log('\nphase 1: typecheck, check:all --enforce and check:ladder, side by side...')
  await Promise.all([
    steps(() => step(repo, 'pnpm', ['typecheck'])).then(finish('typecheck')),
    steps(() => step(repo, 'pnpm', ['check:all', '--enforce'])).then(finish('check:all --enforce')),
    ladder().then(finish('check:ladder, on every new commit')),
  ])

  console.log('\nphase 2, on the build check:all made: smoke, the action, the example\'s handoff, side by side...')
  const scratch = mkdtempSync(join(tmpdir(), 'el-ci-local-'))
  const copy = join(scratch, 'widget-counter')
  await Promise.all([
    steps(() => step(repo, process.execPath, ['scripts/smoke.mjs'])).then(finish('smoke')),
    // As the runner starts it: inputs in INPUT_*, and no GITHUB_OUTPUT to write to.
    steps(() =>
      step(repo, process.execPath, ['action/run.mjs'], {
        env: { ...process.env, GITHUB_WORKSPACE: repo, GITHUB_OUTPUT: '', INPUT_CLAIMS: 'examples/plain-node-project/reviews/good-claims.md' },
      }),
    ).then(finish('the action, on a fixture review')),
    // CI gathers in a standalone copy and holds the suggested claims to the
    // bundle on another runner; the example's own ci:local does both, the
    // review's checks reading the bundle from a separate directory.
    steps(
      () => step(repo, process.execPath, ['examples/plain-node-project/scripts/standalone.mjs', copy]),
      () => step(repo, process.execPath, ['scripts/ci-local.mjs', '--base', 'HEAD', '--review-skeleton'], { cwd: copy }),
    ).then(finish('the example\'s handoff')),
  ])

  const findings: Finding[] = LOCAL_JOBS.map(({ name, ci }) => {
    const o = outcomes.get(name)!
    return {
      level: o.code === 0 ? 'pass' : o.code === 3 ? 'flaky' : 'error',
      claim: name + ' (CI: ' + ci.join(', ') + ')',
      detail: o.detail,
    }
  })
  for (const [job, why] of Object.entries(NOT_REPRODUCED)) {
    findings.push({ level: 'unverifiable', claim: job + ' (CI) - not run here', detail: why })
  }
  findings.push({
    level: 'unverifiable',
    claim: 'the Node matrices (CI: test on 22 and 24, smoke on 22.0.0, 22 and 24) - one Node here',
    detail: 'everything above ran on Node ' + process.versions.node,
  })
  if (dirty) findings.push({ level: 'warning', claim: 'a clean checkout of the commit', detail: 'the working tree has uncommitted changes, so this ran on more than the commit CI would' })

  report('ci:local - what CI would report for ' + head.slice(0, 10), findings)
  // Kept when the handoff failed, so its copy can be looked at.
  if (outcomes.get('the example\'s handoff')?.code === 0) rmSync(scratch, { recursive: true, force: true })
  else console.log('\nthe example\'s standalone copy is kept at ' + copy)
  process.exit(exitCodeFor(findings))
}

// Run as a script, not when a test imports the job lists.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
