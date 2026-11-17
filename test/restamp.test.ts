/**
 * `restamp` (DEC-0010, C4): after gathering again, a review moves onto the
 * new run in one step - blocks replaced from the current bundle, ids rewritten
 * in grade tags only, and never a sentence or a predicate changed to fit.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { artifactId, formatArtifact, formatWorkSummary } from '../src/core/artifact'
import { lintClaims } from '../src/core/claims'
import { restampReview } from '../src/core/restamp'
import { publishRun, readKeptRuns, sourceFingerprint } from '../src/core/seal'
import type { Run } from '../src/core/seal'
import { gatherOneStep, gatherableRepo, printAndExit } from './helpers/gather'
import { sh, tempRepo } from './helpers/git'
import { budget } from './helpers/budget'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN = join(root, 'dist', 'bin', 'evidence-layer.mjs')
const F = '`'.repeat(3)

interface Made {
  id: string
  text: string
  command: string
  output: string
  step: string
}

const make = (step: string, command: string, output: string): Made => {
  const id = artifactId(command, 'f8ae76a', output)
  return { id, text: formatArtifact(command, output, 0, { id, commit: 'f8ae76a' }), command, output, step }
}

function publish(dir: string, blocks: Made[]): Run {
  const fp = sourceFingerprint(dir, ['review.md'])
  if ('unverifiable' in fp) throw new Error(fp.unverifiable)
  return publishRun(dir, {
    headSha: sh(dir, 'rev-parse', 'HEAD'),
    source: fp.fingerprint,
    excluded: ['review.md'],
    bundle: '# Evidence bundle\n\n' + blocks.map((b) => b.text).join('\n\n') + '\n',
    artifacts: blocks.map((b) => ({ id: b.id, command: b.command, exitCode: 0, output: b.output, step: b.step })),
  })
}

const tests = (passed: number, note: string) => make('test', 'pnpm test', note + '\n' + formatWorkSummary('tests', { passed }))
const earlierThan = (dir: string, current: Run) => readKeptRuns(dir, undefined, current.seal.runId)

describe('restampReview', () => {
  it('replaces the block with the current run\'s and rewrites the id in the grade tag - and nowhere else', () => {
    const dir = tempRepo('el-restamp-', { 'src/a.js': 'a\n' })
    const old = tests(3, 'ok in 1.2s')
    publish(dir, [old])
    writeFileSync(join(dir, 'src/a.js'), 'changed\n')
    const next = tests(3, 'ok in 1.4s')
    const current = publish(dir, [next])
    const review = [
      '**Claim**: The test suite ran 3 passing tests and reports no failures.',
      '**Grounding**: VERIFIED[' + old.id + ': exit=0, passed>=3, failed=0]',
      '',
      old.text,
      '',
      'An aside that happens to name ' + old.id + ' in prose.',
      '',
      F + 'markdown',
      '**Grounding**: VERIFIED[' + old.id + ']',
      F,
    ].join('\n')
    const { markdown, moved, left } = restampReview(review, current, earlierThan(dir, current))
    expect(moved).toEqual([{ from: old.id, to: next.id, command: 'pnpm test', line: 4 }])
    expect(left).toEqual([])
    const lines = markdown.split('\n')
    // The sentence and the predicates are as written; only the address moved.
    expect(lines[0]).toBe('**Claim**: The test suite ran 3 passing tests and reports no failures.')
    expect(lines[1]).toBe('**Grounding**: VERIFIED[' + next.id + ': exit=0, passed>=3, failed=0]')
    expect(markdown).toContain(next.text)
    expect(markdown).not.toContain(old.text)
    expect(markdown).toContain('An aside that happens to name ' + old.id + ' in prose.')
    expect(markdown).toContain(F + 'markdown\n**Grounding**: VERIFIED[' + old.id + ']\n' + F)
  })

  it('never makes a claim pass by moving it: a predicate the new run does not meet is still an error', () => {
    const dir = tempRepo('el-restamp-', { 'src/a.js': 'a\n' })
    const old = tests(3, 'ok')
    publish(dir, [old])
    const current = publish(dir, [tests(2, 'one test removed')])
    const review = '**Claim**: The suite ran 3 passing tests.\n**Grounding**: VERIFIED[' + old.id + ': passed>=3]\n\n' + old.text + '\n'
    const { markdown } = restampReview(review, current, earlierThan(dir, current))
    expect(markdown).toContain(': passed>=3]')
    expect(lintClaims(markdown, 'review.md').filter((f) => f.level === 'error').map((f) => f.code)).toEqual(['claims/count-mismatch'])
  })

  it('matches by step where the command changed between the two runs, as a diff\'s range does at every commit', () => {
    const dir = tempRepo('el-restamp-', { 'src/a.js': 'a\n' })
    const old = make('diff', 'git diff --stat aaaaaaa...bbbbbbb', ' src/a.js | 1 +')
    publish(dir, [old])
    const next = make('diff', 'git diff --stat aaaaaaa...ccccccc', ' src/a.js | 2 +-')
    const current = publish(dir, [next])
    const { moved } = restampReview(old.text + '\n', current, earlierThan(dir, current))
    expect(moved.map((m) => [m.from, m.to])).toEqual([[old.id, next.id]])
  })

  it('leaves a block the current run has nothing for, and says why - and leaves the current run\'s own blocks alone', () => {
    const dir = tempRepo('el-restamp-', { 'src/a.js': 'a\n' })
    const lint = make('lint', 'pnpm lint', 'no problems')
    publish(dir, [lint])
    const kept = tests(3, 'ok')
    const current = publish(dir, [kept])
    const review = lint.text + '\n\n' + kept.text + '\n'
    const { markdown, moved, left } = restampReview(review, current, earlierThan(dir, current))
    expect(moved).toEqual([])
    expect(left.map((l) => [l.id, l.line])).toEqual([[lint.id, 1]])
    expect(left[0]!.why).toContain('no artifact for the `lint` step')
    expect(markdown).toBe(review)
  })
})

describe('evidence-layer restamp', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })

  it('moves a review onto the new run after a code change, checks it as claims --seal does, and writes nothing on --dry-run', async () => {
    const dir = gatherableRepo('el-restamp-cli-')
    const first = await gatherOneStep(dir, printAndExit('lint ok'))
    const id = (first.result.steps[0] as { id: string }).id
    const block = new RegExp(F + 'artifact:' + id + '@[0-9a-f]+\\n[\\s\\S]*?' + F).exec(first.text)![0]
    const review = join(dir, 'review.md')
    writeFileSync(review, '**Claim**: Lint reports no violations.\n**Grounding**: VERIFIED[' + id + ': exit=0]\n\n' + block + '\n')

    // The code changes, and the honest answer is to gather again: a new id.
    writeFileSync(join(dir, 'src', 'a.js'), 'changed\n')
    const second = await gatherOneStep(dir, printAndExit('lint ok, one file more'))
    const next = (second.result.steps[0] as { id: string }).id
    expect(next).not.toBe(id)
    expect(cli('claims', review, '--seal', '--repo', dir).status).toBe(1)

    const before = readFileSync(review, 'utf8')
    const dry = cli('restamp', review, '--repo', dir, '--dry-run')
    expect(dry.stdout).toContain('would move ' + review + ':4  ' + id + ' -> ' + next)
    expect(dry.status).toBe(0)
    expect(readFileSync(review, 'utf8')).toBe(before)

    const done = cli('restamp', review, '--repo', dir)
    expect(done.stdout).toContain('moved ' + review + ':4  ' + id + ' -> ' + next)
    expect(done.status).toBe(0)
    expect(readFileSync(review, 'utf8')).toContain('VERIFIED[' + next + ': exit=0]')
    expect(cli('claims', review, '--seal', '--repo', dir).status).toBe(0)
    // Run again, there is nothing left to move, and it says so.
    expect(cli('restamp', review, '--repo', dir).stdout).toContain('nothing to move')
  }, budget(60_000))

  it('says there is no run to move onto, rather than passing or calling it bad usage', () => {
    const dir = tempRepo('el-restamp-cli-', { 'a.js': 'a\n' })
    writeFileSync(join(dir, 'review.md'), '**Claim**: x.\n**Grounding**: UNVERIFIED\n')
    const res = cli('restamp', join(dir, 'review.md'), '--repo', dir)
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('no evidence has been gathered')
    expect(cli('restamp', join(dir, 'missing.md'), '--repo', dir).status).toBe(2)
  })
})
