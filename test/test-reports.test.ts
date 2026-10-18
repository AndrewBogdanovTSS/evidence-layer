/**
 * Test reports into work summaries: the counts are the report's, a report the
 * run did not write is refused, and the gatherer appends the line itself -
 * after the tool, where `parseWorkSummary` looks.
 */
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseJUnitXml, parsePytestSummary, parseVitestSummary, summariseJUnit, summarisePytest } from '../src/adapters/test-reports'
import { classifyCommand, parseWorkSummary } from '../src/core/artifact'
import { gatherEvidence } from '../src/core/gather'
import type { StepRun } from '../src/core/gather'
import { tempRepo } from './helpers/git'

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'reports')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

const step = (over: Partial<StepRun> = {}): StepRun => ({
  step: 'test',
  command: 'pytest',
  output: '',
  exitCode: 0,
  repo: tmpdir(),
  startedAt: Date.now(),
  ...over,
})

describe('the recorded reports', () => {
  it('reads pytest\'s JUnit report and its closing line to the same counts', () => {
    // 2 passed (one printing `<failure>` in its output), a failure and a fixture
    // error, a skip and an xfail.
    const expected = { passed: 2, failed: 2, skipped: 2, todo: 0 }
    expect(parseJUnitXml(fixture('pytest-junit.xml'))).toEqual(expected)
    expect(parsePytestSummary(fixture('pytest-output.txt'))).toEqual(expected)
  })

  it('reads vitest\'s Tests line, and its JUnit report as that report records it', () => {
    expect(parseVitestSummary(fixture('vitest-output.txt'))).toEqual({ passed: 1, failed: 1, skipped: 2, todo: 1 })
    // vitest's JUnit writer records `it.fails` as a pass and `todo` as skipped:
    // the counts are the report's, not a second guess at the runner's intent.
    expect(parseJUnitXml(fixture('vitest-junit.xml'))).toEqual({ passed: 2, failed: 1, skipped: 2, todo: 0 })
  })
})

describe('classifyCommand, for the runners these reports come from', () => {
  it('reads pytest, rspec and phpunit as test runs, and mypy, pyright, ruff, flake8 and pylint by what they check', () => {
    for (const c of ['pytest -q --junitxml=r.xml', 'bundle exec rspec', 'vendor/bin/phpunit', 'dotnet test', 'mvn -B test']) {
      expect(classifyCommand(c), c).toBe('tests')
    }
    for (const c of ['mypy .', 'pyright']) expect(classifyCommand(c), c).toBe('types')
    for (const c of ['ruff check .', 'flake8', 'pylint src']) expect(classifyCommand(c), c).toBe('lint')
  })
})

describe('parseJUnitXml', () => {
  it('counts cases, not a suite\'s own attributes, and ignores text inside CDATA and comments', () => {
    const xml =
      '<testsuites><testsuite tests="99" failures="0"><testcase name="a"/>' +
      '<testcase name="b"><system-out><![CDATA[<failure>not one]]></system-out></testcase>' +
      '<!-- <testcase name="ghost"><failure/></testcase> -->' +
      '<testcase name="c"><error message="x"/></testcase>' +
      '<testcase name="d"><flakyFailure/></testcase></testsuite></testsuites>'
    expect(parseJUnitXml(xml)).toEqual({ passed: 3, failed: 1, skipped: 0, todo: 0 })
  })

  it('reads an empty suite as zero tests, and a document that is not JUnit as nothing', () => {
    expect(parseJUnitXml('<testsuite tests="0"></testsuite>')).toEqual({ passed: 0, failed: 0, skipped: 0, todo: 0 })
    expect(parseJUnitXml('<html><testcase/></html>')).toBeNull()
  })
})

describe('parsePytestSummary and parseVitestSummary', () => {
  it('reads pytest\'s line in its decorated, quiet and empty forms', () => {
    expect(parsePytestSummary('==== 3 failed, 10 passed, 1 deselected, 2 warnings in 1.20s (0:00:01) ====')).toEqual({
      passed: 10,
      failed: 3,
      skipped: 1,
      todo: 0,
    })
    expect(parsePytestSummary('5 passed in 0.01s')).toEqual({ passed: 5, failed: 0, skipped: 0, todo: 0 })
    expect(parsePytestSummary('no tests ran in 0.01s')).toEqual({ passed: 0, failed: 0, skipped: 0, todo: 0 })
    expect(parsePytestSummary('collected 5 items')).toBeNull()
  })

  it('refuses a vitest line whose parts do not add up to its total', () => {
    expect(parseVitestSummary(' Tests  3 passed | 2 mystery (5)')).toBeNull()
  })
})

describe('summariseJUnit', () => {
  const report = '<testsuite><testcase name="a"/><testcase name="b"><skipped/></testcase></testsuite>'

  it('refuses a report older than the run - it describes an earlier one', () => {
    const repo = mkdtempSync(join(tmpdir(), 'el-junit-'))
    writeFileSync(join(repo, 'junit.xml'), report)
    const old = (Date.now() - 60_000) / 1000
    utimesSync(join(repo, 'junit.xml'), old, old)
    expect(summariseJUnit('junit.xml')(step({ repo }))).toEqual({ unavailable: expect.stringContaining('older than this run') })
    expect(summariseJUnit('missing.xml')(step({ repo }))).toEqual({ unavailable: expect.stringContaining('no JUnit report at missing.xml') })
  })

  it('sums a directory\'s reports from this run, leaving out the ones an earlier run left behind', () => {
    const repo = mkdtempSync(join(tmpdir(), 'el-junit-'))
    mkdirSync(join(repo, 'surefire'))
    writeFileSync(join(repo, 'surefire', 'TEST-A.xml'), report)
    writeFileSync(join(repo, 'surefire', 'TEST-B.xml'), report)
    writeFileSync(join(repo, 'surefire', 'TEST-Deleted.xml'), '<testsuite><testcase><failure/></testcase></testsuite>')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(join(repo, 'surefire', 'TEST-Deleted.xml'), old, old)
    expect(summariseJUnit('surefire')(step({ repo }))).toEqual({ kind: 'tests', counts: { passed: 2, failed: 0, skipped: 2, todo: 0 } })
  })
})

describe('gatherEvidence with a summariser', () => {
  const repo = () => tempRepo('el-gather-sum-', { '.gitignore': 'reports/\n', 'a.py': 'x = 1\n' })

  it('appends the report\'s counts to the test step\'s output, and the skeleton names them', async () => {
    const dir = repo()
    const out = join(dir, 'evidence.local.md')
    // A test command that writes its report where git does not look, like `pytest --junitxml=reports/junit.xml`.
    const write =
      "require('fs').mkdirSync('reports',{recursive:true});require('fs').writeFileSync('reports/junit.xml'," +
      JSON.stringify(fixture('pytest-junit.xml')) +
      ");console.log('1 failed, 2 passed, 1 skipped, 1 xfailed, 1 error in 0.02s')"
    writeFileSync(join(dir, 'pytest.js'), write)
    const result = await gatherEvidence({
      repo: dir,
      base: 'HEAD',
      out,
      skip: ['lint', 'typecheck', 'lockfile'],
      plan: { testCommand: () => 'node pytest.js' },
      summaries: { test: summariseJUnit('reports/junit.xml') },
    })
    const bundle = readFileSync(out, 'utf8')
    expect(bundle).toContain('[SUMMARY tests: passed=2 failed=2 skipped=2 todo=0]')
    expect(bundle).toMatch(/VERIFIED\[tests-[0-9a-f]{6}: exit=0, passed>=2, failed=2\]/)
    expect(result.sealed).toBe(true)
  })

  it('says why there is no summary, rather than leaving one out silently', async () => {
    const dir = repo()
    const out = join(dir, 'evidence.local.md')
    await gatherEvidence({
      repo: dir,
      base: 'HEAD',
      out,
      skip: ['lint', 'typecheck', 'lockfile'],
      plan: { testCommand: () => 'node -e "console.log(\'no summary here\')"' },
      summaries: { test: summarisePytest() },
    })
    const bundle = readFileSync(out, 'utf8')
    expect(bundle).toContain('_No work summary: the output has no pytest summary line._')
    expect(bundle).not.toContain('[SUMMARY')
  })

  it('holds a summariser to the grammar - a wrong kind or a missing count is refused', async () => {
    const dir = repo()
    const out = join(dir, 'evidence.local.md')
    await gatherEvidence({
      repo: dir,
      base: 'HEAD',
      out,
      skip: ['lint', 'typecheck', 'lockfile'],
      plan: { testCommand: () => 'node -e "1"' },
      summaries: { test: () => ({ kind: 'tests', counts: { passed: 3 } }) },
    })
    expect(readFileSync(out, 'utf8')).toContain('_No work summary: the summariser gave no usable count for failed, skipped, todo._')
    expect(parseWorkSummary(readFileSync(out, 'utf8'))).toBeNull()
  })
})
