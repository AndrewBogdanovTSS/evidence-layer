import { describe, expect, it } from 'vitest'
import { generateClaimSkeleton, generateSampleSkeleton } from '../src/core/skeleton'
import { findArtifactBlocks } from '../src/core/artifact'
import { findClaims, lintClaims } from '../src/core/claims'

const artifact = (command: string, exitCode: number, id: string, commit = 'f8ae76a') => ({
  command,
  output: 'ok',
  exitCode,
  id,
  commit,
})

describe('generateClaimSkeleton', () => {
  it('emits a Claim/Grounding/artifact triple per artifact', () => {
    const skeleton = generateClaimSkeleton([artifact('pnpm test', 0, 'tests-aaaaaa')])
    expect(skeleton).toContain('**Claim**:')
    expect(skeleton).toContain('**Grounding**: VERIFIED[tests-aaaaaa]')
    expect(skeleton).toContain('```artifact:tests-aaaaaa@f8ae76a')
  })

  it('never asserts success language when the exit code says otherwise', () => {
    const skeleton = generateClaimSkeleton([artifact('pnpm test', 1, 'tests-bbbbbb')])
    expect(skeleton).toContain('reports failures')
    expect(skeleton).not.toContain('reports no failures')
  })

  it('skips the diff kind - it is context, not a claim a reader would grade', () => {
    const skeleton = generateClaimSkeleton([artifact('git diff --stat a...b', 0, 'diff-cccccc')])
    expect(skeleton.trim()).toBe('')
  })

  it('produces claims that the linter accepts unmodified - the whole point of the skeleton', () => {
    const artifacts = [artifact('pnpm test', 0, 'tests-dddddd')]
    const skeleton = generateClaimSkeleton(artifacts)
    const findings = lintClaims(skeleton, 'skeleton.md')
    expect(findings.some((f) => f.level === 'error')).toBe(false)
  })

  it('round-trips through the artifact parser - the skeleton it writes is what the checker reads', () => {
    const skeleton = generateClaimSkeleton([artifact('pnpm test', 0, 'tests-eeeeee')])
    const lines = skeleton.split('\n')
    expect(findArtifactBlocks(lines)[0]?.id).toBe('tests-eeeeee')
    expect(findClaims(lines, new Set())[0]?.gradeId).toBe('tests-eeeeee')
  })
})

describe('generateSampleSkeleton', () => {
  it('emits one Sample integrity line per file supplied', () => {
    const md = generateSampleSkeleton([{ path: 'a.ts', line: 'import x' }, { path: 'b.ts', line: 'import y' }])
    expect(md.split('\n')).toHaveLength(2)
  })

  it('notes an omitted count when the caller capped the list, without inventing entries', () => {
    const md = generateSampleSkeleton([{ path: 'a.ts', line: 'import x' }], 5)
    expect(md).toContain('5 more changed files omitted')
  })

  it('omits the note entirely when nothing was left out', () => {
    expect(generateSampleSkeleton([{ path: 'a.ts', line: 'x' }])).not.toContain('omitted')
  })
})
