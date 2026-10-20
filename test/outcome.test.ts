import { describe, expect, it } from 'vitest'
import {
  findArtifactBlocks,
  formatArtifact,
  formatExitLine,
  formatWorkSummary,
  parseWorkSummary,
  workDone,
} from '../src/core/artifact'
import type { StopReason } from '../src/core/artifact'
import { lintClaims, outcomeProblem, readsAsIncomplete, readsAsSuccess } from '../src/core/claims'
import { generateClaimSkeleton } from '../src/core/skeleton'

const F = '`'.repeat(3)

/** A one-claim review citing one addressed artifact. */
function review(claim: string, command: string, output: string, exitCode: number, stopped?: StopReason): string {
  const id = 'cmd-abcdef'
  return ['**Claim**: ' + claim, '**Grounding**: VERIFIED[' + id + ']', '', formatArtifact(command, output, exitCode, { id, stopped })].join(
    '\n',
  )
}

const errorsOf = (md: string, opts?: { requireWorkSummary?: boolean }) =>
  lintClaims(md, 'review.md', opts).filter((f) => f.level === 'error')

describe('exit line grammar', () => {
  it('writes the stop reason after the code', () => {
    expect(formatExitLine(124, 'timeout')).toBe('exit: 124 (timeout)')
    expect(formatExitLine(137, 'killed SIGKILL')).toBe('exit: 137 (killed SIGKILL)')
    expect(formatExitLine(0)).toBe('exit: 0')
  })

  it.each<StopReason>(['timeout', 'overflow', 'killed SIGKILL'])('round-trips %s through the parser', (stopped) => {
    const [block] = findArtifactBlocks(formatArtifact('pnpm typecheck', 'partial', 124, { stopped }).split('\n'))
    expect(block?.stopped).toBe(stopped)
    expect(block?.exitCode).toBe(124)
  })

  it('leaves `stopped` absent on a plain exit line', () => {
    expect(findArtifactBlocks(formatArtifact('pnpm test', 'ok', 0).split('\n'))[0]).not.toHaveProperty('stopped')
  })

  it('rejects a reason it does not know rather than guessing at it', () => {
    expect(findArtifactBlocks([F + 'artifact', '$ pnpm test', 'ok', 'exit: 0 (probably fine)', F])).toHaveLength(0)
  })

  it('exposes the quoted output between the command line and the exit line', () => {
    const [block] = findArtifactBlocks([F + 'artifact', '', '$ pnpm test', 'line one', '', 'line two', 'exit: 0', '', F])
    expect(block?.output).toBe('line one\n\nline two')
  })
})

describe('work summary', () => {
  it('formats and parses the lint line', () => {
    const line = formatWorkSummary('lint', { files: 7, ignored: 1, errors: 0, warnings: 0 })
    expect(line).toBe('[SUMMARY lint: files=7 ignored=1 errors=0 warnings=0]')
    const summary = parseWorkSummary('some eslint output\n' + line + '\n')
    expect(summary).toEqual({ kind: 'lint', counts: { files: 7, ignored: 1, errors: 0, warnings: 0 } })
    expect(workDone(summary!)).toBe(6)
  })

  it('counts passed tests as the work a test run did', () => {
    expect(workDone(parseWorkSummary(formatWorkSummary('tests', { passed: 3, skipped: 2 }))!)).toBe(3)
  })

  it('reads only the last non-blank line, so a summary the tool printed earlier cannot stand in', () => {
    const output = formatWorkSummary('tests', { passed: 9 }) + '\nreal output after it'
    expect(parseWorkSummary(output)).toBeNull()
  })

  it('rejects a summary missing a key', () => {
    expect(parseWorkSummary('[SUMMARY lint: files=7 ignored=0]')).toBeNull()
  })
})

describe('readsAsSuccess / readsAsIncomplete', () => {
  it.each([
    ['Lint reports no violations.', true],
    ['Typecheck passes.', true],
    ['The suite does not pass.', false],
    ['Typecheck reports errors.', false],
    ['Lint checked 7 files and reports no violations.', true],
    ['The test suite ran 0 tests to completion - 3 skipped, 0 todo.', false],
  ])('%s -> %s', (text, expected) => {
    expect(readsAsSuccess(text)).toBe(expected)
  })

  it('recognises the skeleton sentence for a stopped run', () => {
    expect(readsAsIncomplete('Typecheck did not complete - it timed out before reporting a result.')).toBe(true)
    expect(readsAsIncomplete('Typecheck reports errors.')).toBe(false)
  })
})

describe('outcome rules in lintClaims', () => {
  it('rejects a success claim over a non-zero exit', () => {
    const [e] = errorsOf(review('Tests pass.', 'pnpm test', 'FAIL a.test.ts', 1))
    expect(e?.detail).toContain('exited 1')
  })

  it('accepts a failure claim over a non-zero exit - that is what a failing run verifies', () => {
    expect(errorsOf(review('The test suite reports failures.', 'pnpm test', 'FAIL a.test.ts', 1))).toHaveLength(0)
  })

  it('rejects "reports errors" over a run the time limit stopped', () => {
    const [e] = errorsOf(review('Typecheck reports errors.', 'pnpm typecheck', 'partial', 124, 'timeout'))
    expect(e?.detail).toContain('stopped before it finished (timeout)')
  })

  it('rejects a success claim over a stopped run', () => {
    expect(errorsOf(review('Typecheck passes.', 'pnpm typecheck', 'partial', 124, 'timeout'))).toHaveLength(1)
  })

  it('accepts "did not complete" over a stopped run', () => {
    const md = review('Typecheck did not complete - it was killed by SIGKILL.', 'pnpm typecheck', 'x', 137, 'killed SIGKILL')
    expect(errorsOf(md)).toHaveLength(0)
  })

  it('rejects "lint passes" over a run where every file was ignored', () => {
    const output = 'File ignored because of a matching ignore pattern\n' + formatWorkSummary('lint', { files: 2, ignored: 2 })
    const [e] = errorsOf(review('Lint reports no violations.', 'pnpm eslint a.ts b.ts', output, 0))
    expect(e?.detail).toContain('checked nothing')
  })

  it('rejects "tests pass" over a run with 0 passing tests', () => {
    const output = formatWorkSummary('tests', { passed: 0, skipped: 4 })
    expect(errorsOf(review('The test suite reports no failures.', 'pnpm test', output, 0))[0]?.detail).toContain('checked nothing')
  })

  it('rejects "no violations" over a lint run that exited 0 with warnings', () => {
    const output = formatWorkSummary('lint', { files: 3, warnings: 2 })
    expect(errorsOf(review('Lint reports no violations.', 'pnpm eslint .', output, 0))[0]?.detail).toContain('reports problems')
  })

  it('holds a test run to its counts when a path it was given names another kind', () => {
    // Classified from the whole line, `typecheck.test.ts` made this a `types`
    // run, and the test rules - this one included - never applied.
    const output = formatWorkSummary('tests', { passed: 0, skipped: 4 })
    const command = 'pnpm test src/typecheck.test.ts --no-watch'
    expect(errorsOf(review('The test suite reports no failures.', command, output, 0))[0]?.detail).toContain('checked nothing')
  })

  it('rejects a summary of the wrong kind', () => {
    const output = formatWorkSummary('tests', { passed: 5 })
    expect(errorsOf(review('Lint reports no violations.', 'pnpm eslint .', output, 0))[0]?.detail).toContain('describes a tests run')
  })

  it('accepts a success claim over a summary that shows real work', () => {
    const output = formatWorkSummary('lint', { files: 7 })
    expect(errorsOf(review('Lint reports no violations.', 'pnpm eslint .', output, 0))).toHaveLength(0)
  })

  it('lets a summary-less success through by default, and rejects it when summaries are required', () => {
    const md = review('Tests pass.', 'pnpm test', 'Tests 71 passed (71)', 0)
    expect(errorsOf(md)).toHaveLength(0)
    expect(errorsOf(md, { requireWorkSummary: true })[0]?.detail).toContain('no work summary')
  })

  it('never asks a whole-project command for a summary', () => {
    expect(outcomeProblem({ command: 'pnpm typecheck', output: '', exitCode: 0 }, 'Typecheck passes.', { requireWorkSummary: true })).toBeNull()
  })

  it('applies the same rules to a bare VERIFIED', () => {
    const md = ['**Claim**: Tests pass.', '**Grounding**: VERIFIED', '', formatArtifact('pnpm test', 'FAIL', 1)].join('\n')
    expect(errorsOf(md).some((e) => e.detail.includes('exited 1'))).toBe(true)
  })
})

describe('skeleton over the new grammar', () => {
  const base = { output: 'ok', id: 'cmd-abcdef', commit: 'f8ae76a' }

  it('writes the stop reason onto the exit line and says how the run stopped', () => {
    const skeleton = generateClaimSkeleton([{ ...base, command: 'pnpm typecheck', exitCode: 137, stopped: 'killed SIGKILL' }])
    expect(skeleton).toContain('Typecheck did not complete - it was killed by SIGKILL before reporting a result.')
    expect(skeleton).toContain('exit: 137 (killed SIGKILL)')
  })

  it.each([
    ['lint', 'pnpm eslint .', { files: 7, ignored: 2 }, 'Lint checked 5 files and reports no violations.'],
    ['lint', 'pnpm eslint .', { files: 2, ignored: 2 }, 'Lint checked no files - every file given to it was ignored.'],
    ['lint', 'pnpm eslint .', { files: 2, warnings: 1 }, 'Lint reports violations.'],
    ['tests', 'pnpm test', { passed: 71 }, 'The test suite ran 71 passing tests and reports no failures.'],
    ['tests', 'pnpm test', { passed: 0, skipped: 3 }, 'The test suite ran 0 tests to completion - 3 skipped, 0 todo.'],
  ] as const)('%s %j -> %s, and the linter accepts it unmodified', (kind, command, counts, sentence) => {
    const output = formatWorkSummary(kind, counts)
    const skeleton = generateClaimSkeleton([{ ...base, command, output, exitCode: 0 }])
    expect(skeleton.split('\n')[0]).toBe('**Claim**: ' + sentence)
    expect(errorsOf(skeleton, { requireWorkSummary: true })).toHaveLength(0)
  })
})
