// What a writer that gets a citation wrong is told, and what it is handed:
// the kind and count rules that catch the wrong block, the fix each failing
// finding carries, and `claims --fix`, the one fix applied for the writer.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { artifactId, formatArtifact } from '../src/core/artifact'
import { countProblem, downgradeClaims, kindProblem, kindsNamed, lintClaims } from '../src/core/claims'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN = join(root, 'dist', 'bin', 'evidence-layer.mjs')

const TESTS = 'ok\n[SUMMARY tests: passed=71 failed=0 skipped=2 todo=0]'
const LINT = 'ok\n[SUMMARY lint: files=9 ignored=2 errors=0 warnings=0]'

function run(command: string, output: string, exitCode = 0, commit = 'f8ae76a') {
  const id = artifactId(command, commit, output)
  return { id, command, output, exitCode, block: formatArtifact(command, output, exitCode, { id, commit }) }
}

const claim = (sentence: string, grounding: string) => '**Claim**: ' + sentence + '\n**Grounding**: ' + grounding + '\n'
const failing = (md: string, opts = {}) => lintClaims(md, 'review.md', opts).filter((f) => f.level === 'error')

describe('the kind a claim names', () => {
  it('reads the kinds of run from the words, narrowly', () => {
    expect(kindsNamed('Lint reports no violations.')).toEqual(['lint'])
    expect(kindsNamed('Typecheck reports no errors.')).toEqual(['types'])
    expect(kindsNamed('The test suite ran 71 passing tests.')).toEqual(['tests'])
    expect(kindsNamed('The lockfile matches package.json.')).toEqual(['lockfile'])
    expect(kindsNamed('A dependency audit reports no known vulnerabilities.')).toEqual(['audit'])
    // Ordinary prose names no kind: "type", "suite", "audit" and "vulnerability" alone are not kinds.
    expect(kindsNamed('This type of change keeps the suite small.')).toEqual([])
    expect(kindsNamed('The XSS vulnerability is closed, and audit events are written.')).toEqual([])
  })

  it('fails a lint claim that cites a typecheck run, and offers the lint run that is there', () => {
    const types = run('pnpm typecheck', '')
    const lint = run('pnpm lint', LINT)
    const md = claim('Lint reports no violations.', 'VERIFIED[' + types.id + ': exit=0]') + '\n' + types.block + '\n\n' + lint.block + '\n'
    const [finding] = failing(md)
    expect(finding).toMatchObject({ code: 'claims/kind-mismatch' })
    expect(finding!.detail).toContain('is about lint, but cites `pnpm typecheck`, a typecheck run')
    expect(finding!.fix).toContain('**Claim**: Lint checked 7 files and reports no violations.')
    expect(finding!.fix).toContain('**Grounding**: VERIFIED[' + lint.id + ': exit=0, files=9, ignored=2, errors=0, warnings=0]')
  })

  it('says no run of that kind was gathered when there is none to offer', () => {
    const types = run('pnpm typecheck', '')
    const [finding] = failing(claim('Lint reports no violations.', 'VERIFIED[' + types.id + ']') + '\n' + types.block + '\n')
    expect(finding!.fix).toBe('no lint run was gathered - gather one and cite it, or mark the claim UNVERIFIED')
  })

  it('passes a claim that names its run among others, and one that names no kind', () => {
    const tests = run('pnpm test', TESTS)
    expect(kindProblem(tests, 'The tests for the lint rule pass.')).toBeNull()
    expect(kindProblem(tests, 'increment handles negatives.')).toBeNull()
    // A run no word names is held to nothing.
    expect(kindProblem(run('node scripts/fingerprint.mjs', ''), 'Lint is clean.')).toBeNull()
  })
})

describe('the counts a claim states', () => {
  const tests = run('pnpm test', TESTS)

  it('holds a stated count to the work summary', () => {
    expect(countProblem(tests, 'The suite ran 71 passing tests.')).toBeNull()
    expect(countProblem(tests, 'The suite ran 73 tests.')).toBeNull() // every test, skipped ones too
    expect(countProblem(tests, '0 tests failed and 2 skipped.')).toBeNull()
    expect(countProblem(tests, 'The suite ran 72 passing tests.')).toMatchObject({ expected: 72, observed: 71 })
    expect(countProblem(tests, '3 failures were reported.')).toMatchObject({ expected: 3, observed: 0 })
  })

  it('reads "N files" on a lint run as the files it checked, or all it was given', () => {
    const lint = run('pnpm lint', LINT)
    expect(countProblem(lint, 'Lint checked 7 files.')).toBeNull()
    expect(countProblem(lint, '9 files were linted.')).toBeNull()
    expect(countProblem(lint, 'Lint checked 8 files.')?.detail).toContain('files-ignored=7 and files=9')
  })

  it('reads no count off a sentence about the change, or about what used to be true', () => {
    expect(countProblem(tests, 'The change adds 3 tests and touches 12 files.')).toBeNull()
    expect(countProblem(tests, 'This fixes the 2 failing tests from #12.')).toBeNull()
  })

  it('leaves a count alone when the run has no summary, or summarises the other kind', () => {
    expect(countProblem(run('pnpm test', 'ok'), 'The suite ran 72 passing tests.')).toBeNull()
    expect(countProblem(tests, '12 files were checked.')).toBeNull()
  })

  it('fails the claim, carrying the claim its run does back as the fix', () => {
    const [finding] = failing(claim('The suite ran 72 passing tests.', 'VERIFIED[' + tests.id + ']') + '\n' + tests.block + '\n')
    expect(finding).toMatchObject({ code: 'claims/count-mismatch', expected: 72, observed: 71 })
    expect(finding!.fix).toBe(
      'replace the claim and its grounding with the lines below - or mark the claim UNVERIFIED:\n' +
        '**Claim**: The test suite ran 71 passing tests and reports no failures.\n' +
        '**Grounding**: VERIFIED[' + tests.id + ': exit=0, passed>=71, failed=0]',
    )
  })
})

describe('the fix a failing finding carries', () => {
  it('turns a placeholder-filled bracket into the run\'s own grounding', () => {
    const tests = run('pnpm test', TESTS)
    const md = claim('The suite passes.', 'VERIFIED[' + tests.id + ': <predicates>]') + '\n' + tests.block + '\n'
    const [finding] = failing(md)
    expect(finding!.code).toBe('claims/bad-predicate')
    expect(finding!.fix).toContain('**Grounding**: VERIFIED[' + tests.id + ': exit=0, passed>=71, failed=0]')
  })

  it('offers the one run of the same kind for an id that does not resolve, with its block to copy when it is elsewhere', () => {
    const tests = run('pnpm test', TESTS)
    const md = claim('The suite passes.', 'VERIFIED[tests-0a1b2c]')
    const [finding] = failing(md, { suggestFrom: tests.block })
    expect(finding!.code).toBe('claims/unknown-artifact')
    expect(finding!.fix).toContain('copy the ' + tests.id + ' block from the evidence bundle into the review unedited')
    expect(finding!.fix).toContain('VERIFIED[' + tests.id + ':')
    // Two runs to choose between is a judgement - the fix lists them instead of choosing.
    const other = run('pnpm test -- --shard 2', TESTS)
    const [two] = failing(md, { suggestFrom: tests.block + '\n\n' + other.block })
    expect(two!.fix).toBe('mark the claim UNVERIFIED, or cite one of these runs as VERIFIED[<id>]: ' + tests.id + ', ' + other.id)
  })

  it('never offers a sentence the run does not back - a failing run gets a failure claim', () => {
    const red = run('pnpm test', 'not ok\n[SUMMARY tests: passed=70 failed=1 skipped=0 todo=0]', 1)
    const [finding] = failing(claim('The suite passes.', 'VERIFIED[' + red.id + ']') + '\n' + red.block + '\n')
    expect(finding!.code).toBe('claims/outcome-mismatch')
    expect(finding!.fix).toContain('**Claim**: The test suite reports failures.')
    // Applied as written, the fix passes.
    const fixed = claim('The test suite reports failures.', 'VERIFIED[' + red.id + ': exit=1, passed>=70, failed=1]') + '\n' + red.block + '\n'
    expect(failing(fixed)).toEqual([])
  })
})

describe('downgradeClaims', () => {
  it('marks each failing claim UNVERIFIED, leaves the passing ones, and the result passes', () => {
    const tests = run('pnpm test', TESTS)
    const md = [
      claim('The suite ran 72 passing tests.', 'VERIFIED[' + tests.id + ': passed>=72]'),
      claim('The suite ran 71 passing tests.', 'VERIFIED[' + tests.id + ': passed>=71]'),
      '**Claim**: the module is easy to extend.',
      '',
      claim('The spec says so.', 'DOCUMENTED'),
      tests.block,
      '',
    ].join('\n')
    const { markdown, downgraded } = downgradeClaims(md, lintClaims(md, 'review.md'))
    expect(downgraded.map((d) => d.code)).toEqual(['claims/count-mismatch', 'claims/untagged', 'claims/uncited'])
    expect(markdown).toContain('**Claim**: The suite ran 72 passing tests.\n**Grounding**: UNVERIFIED\n')
    expect(markdown).toContain('**Grounding**: VERIFIED[' + tests.id + ': passed>=71]')
    expect(markdown).toContain('**Claim**: the module is easy to extend.\n**Grounding**: UNVERIFIED\n')
    expect(lintClaims(markdown, 'review.md').filter((f) => f.level === 'error')).toEqual([])
  })

  it('keeps CRLF line endings, and changes nothing when nothing fails', () => {
    const md = '**Claim**: a.\r\n**Grounding**: UNVERIFIED\r\n\r\n**Claim**: b.\r\n'
    const { markdown } = downgradeClaims(md, lintClaims(md, 'review.md'))
    expect(markdown).toBe('**Claim**: a.\r\n**Grounding**: UNVERIFIED\r\n\r\n**Claim**: b.\r\n**Grounding**: UNVERIFIED\r\n')
    expect(downgradeClaims(markdown, lintClaims(markdown, 'review.md'))).toEqual({ markdown, downgraded: [] })
  })
})

describe('claims --fix', () => {
  it('writes the downgrade into the review, says what it marked, and exits on the check that follows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'el-fix-'))
    const tests = run('pnpm test', TESTS)
    const path = join(dir, 'review.md')
    writeFileSync(path, claim('The suite ran 72 passing tests.', 'VERIFIED[' + tests.id + ']') + '\n' + tests.block + '\n')
    const before = spawnSync(process.execPath, [BIN, 'claims', path], { encoding: 'utf8' })
    expect(before.status).toBe(1)
    expect(before.stdout).toContain('fix: replace the claim and its grounding')

    const fixed = spawnSync(process.execPath, [BIN, 'claims', path, '--fix', '--format', 'json'], { encoding: 'utf8' })
    expect(fixed.status).toBe(0)
    expect(fixed.stderr).toContain('marked UNVERIFIED: ' + path + ':1 (claims/count-mismatch)')
    expect(JSON.parse(fixed.stdout).schema).toBe(5)
    expect(readFileSync(path, 'utf8')).toContain('**Grounding**: UNVERIFIED\n')
  })
})
