/**
 * Test reports, read into work summaries - so `VERIFIED[tests-a3f91c:
 * passed>=71, failed=0]` works for a pytest suite, a Maven build or a .NET
 * solution, not only for a project whose test runner prints vitest's line.
 *
 * The claim it makes falsifiable: **"the counts in the summary are the counts
 * in the report this run wrote."** Four readers, one per shape of evidence a
 * test run leaves:
 *
 *   - JUnit XML - the one format nearly every runner can write (`pytest
 *     --junitxml`, Maven Surefire and Gradle, `dotnet test` with a JUnit
 *     logger, `go-junit-report`, `jest-junit`). Counted from the `<testcase>`
 *     elements themselves, not from a suite's `tests=` attribute: some writers
 *     leave the attributes out, and a count read from a summary attribute is
 *     the writer's claim about the cases, not the cases.
 *   - pytest's own closing line (`3 failed, 10 passed, 2 skipped in 0.52s`),
 *     for a suite run without a report file.
 *   - vitest's `Tests` line, for this repository and projects like it.
 *   - Node's built-in runner's totals (`# pass 3` under TAP, which it uses
 *     when its output is captured, or `ℹ pass 3` from the spec reporter).
 *
 * A report file is evidence only about the run that wrote it. One left behind
 * by an earlier run - the test command failed before it got to writing, or
 * wrote somewhere else this time - would hand the earlier run's counts to this
 * one. So a file older than the step is refused, never read, and the bundle
 * says why. Write reports where git does not look (an ignored directory), or
 * the gather will say, correctly, that the tree changed while it ran.
 *
 * What it does not do: decide what a project's report path is, or run
 * anything. The project's test command writes the report; this reads it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { WorkSummary } from '../core/artifact'
import type { StepRun, Summariser } from '../core/gather'

export interface TestCounts {
  passed: number
  failed: number
  skipped: number
  todo: number
}

const tests = (c: TestCounts): WorkSummary => ({ kind: 'tests', counts: { ...c } })

/**
 * Filesystems record modification times coarsely - FAT to two seconds - so a
 * report written in the step's first instant can carry a time just before
 * `startedAt`. Two seconds of slack admits that; the report this guards
 * against is the one from an earlier run, and that is minutes or days old.
 */
const MTIME_SLACK_MS = 2000

/**
 * The counts in one JUnit XML document, or `null` when it is not one.
 *
 * Comments and CDATA are removed first: a test's captured output in
 * `<system-out><![CDATA[...]]>` can contain the text `<failure`, and it is not
 * a failure. A case with `<failure>` or `<error>` failed, one with `<skipped>`
 * was skipped, and any other case - `<flakyFailure>` and `<rerunFailure>`
 * included, which record a retry that then passed - passed.
 */
export function parseJUnitXml(xml: string): TestCounts | null {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
  if (!/<testsuites?\b/.test(text)) return null
  const counts: TestCounts = { passed: 0, failed: 0, skipped: 0, todo: 0 }
  for (const match of text.matchAll(/<testcase\b[^>]*?(\/?)>/g)) {
    if (match[1] === '/') {
      counts.passed++
      continue
    }
    const end = text.indexOf('</testcase>', match.index! + match[0].length)
    const body = text.slice(match.index! + match[0].length, end === -1 ? undefined : end)
    if (/<(?:failure|error)\b/.test(body)) counts.failed++
    else if (/<skipped\b/.test(body)) counts.skipped++
    else counts.passed++
  }
  return counts
}

/**
 * The counts in pytest's closing line, or `null` when the output has none.
 *
 * `failed` includes errors (a test that could not even be set up did not pass),
 * `skipped` includes `xfailed` (expected to fail, and did - not a pass) and
 * `deselected` (not run), and `xpassed` counts as passed. `no tests ran` is
 * all zeros, which the outcome rules read as a run that checked nothing.
 */
export function parsePytestSummary(output: string): TestCounts | null {
  const LINE = /^=*\s*((?:\d+ [a-z]+(?:, )?)+|no tests ran)(?: in [\d.]+s(?: \([^)]*\))?)\s*=*$/
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => LINE.test(l))
    .at(-1)
  if (!line) return null
  const counts: TestCounts = { passed: 0, failed: 0, skipped: 0, todo: 0 }
  for (const [, n, word] of line.matchAll(/(\d+) ([a-z]+)/g)) {
    const value = Number(n)
    if (word === 'passed' || word === 'xpassed') counts.passed += value
    else if (word === 'failed' || word === 'error' || word === 'errors') counts.failed += value
    else if (word === 'skipped' || word === 'xfailed' || word === 'deselected') counts.skipped += value
  }
  return counts
}

/**
 * The counts in vitest's `Tests` line (`Tests  2 failed | 69 passed (71)`), or
 * `null` when there is none - or when its parts do not add up to the total it
 * states, which means a format this does not understand, not a number to trust.
 */
export function parseVitestSummary(output: string): TestCounts | null {
  const match = [...output.matchAll(/^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/gm)].at(-1)
  if (!match) return null
  const counts: TestCounts = { passed: 0, failed: 0, skipped: 0, todo: 0 }
  for (const [, n, word] of match[1]!.matchAll(/(\d+) ([a-z]+(?: [a-z]+)?)/g)) {
    const value = Number(n)
    if (word === 'passed') counts.passed += value
    else if (word === 'failed') counts.failed += value
    else if (word === 'skipped') counts.skipped += value
    else if (word === 'todo') counts.todo += value
    else if (word === 'expected fail') counts.skipped += value
  }
  const total = counts.passed + counts.failed + counts.skipped + counts.todo
  return total === Number(match[2]) ? counts : null
}

/**
 * The counts in `node --test`'s closing totals, or `null` when there are none
 * or they do not add up to the `tests` total they state. Node prints them as
 * TAP comments (`# pass 3`) when its output is not a terminal - which is how a
 * gatherer captures it - and with `ℹ` from the spec reporter. A cancelled test
 * did not pass, so it counts as failed.
 */
export function parseNodeTestSummary(output: string): TestCounts | null {
  const totals = new Map<string, number>()
  for (const [, key, n] of output.matchAll(/^[ℹ#]\s*(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm)) totals.set(key!, Number(n))
  if (!['tests', 'pass', 'fail', 'skipped', 'todo'].every((k) => totals.has(k))) return null
  const counts: TestCounts = {
    passed: totals.get('pass')!,
    failed: totals.get('fail')! + (totals.get('cancelled') ?? 0),
    skipped: totals.get('skipped')!,
    todo: totals.get('todo')!,
  }
  return counts.passed + counts.failed + counts.skipped + counts.todo === totals.get('tests') ? counts : null
}

/**
 * Reads the JUnit report(s) a test step wrote. Each path is a file, or a
 * directory whose `*.xml` files are summed (Surefire writes one per class).
 * Relative paths are relative to the repository.
 *
 * A named file that is missing, older than the step, or not JUnit makes the
 * summary unavailable - with the reason. In a directory, files older than the
 * step are left out, since a class deleted since the last run leaves its old
 * report behind; a directory with no file from this run is unavailable too.
 */
export function summariseJUnit(paths: string | string[]): Summariser {
  return (run: StepRun) => {
    const total: TestCounts = { passed: 0, failed: 0, skipped: 0, todo: 0 }
    const fresh = (file: string) => statSync(file).mtimeMs + MTIME_SLACK_MS >= run.startedAt
    for (const path of Array.isArray(paths) ? paths : [paths]) {
      const full = isAbsolute(path) ? path : join(run.repo, path)
      if (!existsSync(full)) return { unavailable: 'no JUnit report at ' + path + ' - did the test command write one?' }
      const files = statSync(full).isDirectory()
        ? readdirSync(full).filter((f) => f.endsWith('.xml')).map((f) => ({ file: join(full, f), shown: join(path, f) })).filter((f) => fresh(f.file))
        : [{ file: full, shown: path }]
      if (files.length === 0) return { unavailable: 'no JUnit report in ' + path + ' was written by this run' }
      for (const { file, shown } of files) {
        if (!fresh(file)) return { unavailable: 'the JUnit report at ' + shown + ' is older than this run - it describes an earlier one' }
        const counts = parseJUnitXml(readFileSync(file, 'utf8'))
        if (!counts) return { unavailable: shown + ' is not a JUnit XML report' }
        for (const key of ['passed', 'failed', 'skipped', 'todo'] as const) total[key] += counts[key]
      }
    }
    return tests(total)
  }
}

/** Reads pytest's closing line from the test step's output. */
export function summarisePytest(): Summariser {
  return (run: StepRun) => {
    const counts = parsePytestSummary(run.output)
    return counts ? tests(counts) : { unavailable: 'the output has no pytest summary line' }
  }
}

/** Reads `node --test`'s totals from the test step's output. */
export function summariseNodeTest(): Summariser {
  return (run: StepRun) => {
    const counts = parseNodeTestSummary(run.output)
    return counts ? tests(counts) : { unavailable: 'the output has no `node --test` totals that add up' }
  }
}

/** Reads vitest's `Tests` line from the test step's output. */
export function summariseVitest(): Summariser {
  return (run: StepRun) => {
    const counts = parseVitestSummary(run.output)
    return counts ? tests(counts) : { unavailable: 'the output has no vitest `Tests` line that adds up' }
  }
}
