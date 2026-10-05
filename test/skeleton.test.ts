import { describe, expect, it } from 'vitest'
import { generateClaimSkeleton, generateSampleSkeleton } from '../src/core/skeleton'
import { findArtifactBlocks } from '../src/core/artifact'
import { findClaims, lintClaims } from '../src/core/claims'
import { parseReceipt } from '../src/core/receipt'

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

  it('says a timed-out run did not complete, instead of reading its 124 as a failure', () => {
    const skeleton = generateClaimSkeleton([{ ...artifact('pnpm typecheck', 124, 'types-ffffff'), timedOut: true }])
    expect(skeleton.split('\n')[0]).toBe('**Claim**: Typecheck did not complete - it timed out before reporting a result.')
    expect(skeleton).not.toContain('reports errors')
    expect(skeleton).toContain('exit: 124')
  })

  it('names the command generically when a timed-out command has no known kind', () => {
    const skeleton = generateClaimSkeleton([{ ...artifact('node build.mjs', 124, 'cmd-aaaaaa'), timedOut: true }])
    expect(skeleton).toContain('**Claim**: This command did not complete - it timed out before reporting a result.')
  })

  it('still makes no claim for a diff, even one that timed out', () => {
    const skeleton = generateClaimSkeleton([{ ...artifact('git diff --stat a...b', 124, 'diff-dddddd'), timedOut: true }])
    expect(skeleton.trim()).toBe('')
  })

  it('reads 124 as a timeout only when the caller says so - a real tool may exit 124', () => {
    const skeleton = generateClaimSkeleton([artifact('pnpm typecheck', 124, 'types-aaaaaa')])
    expect(skeleton).toContain('Typecheck reports errors.')
  })

  it('produces a timed-out claim that the linter accepts unmodified', () => {
    const skeleton = generateClaimSkeleton([{ ...artifact('pnpm test', 124, 'tests-ffffff'), timedOut: true }])
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
  it('emits one table row per file supplied, under a single label', () => {
    const md = generateSampleSkeleton([{ path: 'a.ts', line: 'import x' }, { path: 'b.ts', line: 'import y' }])
    expect(md).toBe(
      [
        '**Sample integrity**:',
        '',
        '| File | First non-blank line |',
        '|---|---|',
        '| `a.ts` | `import x` |',
        '| `b.ts` | `import y` |',
      ].join('\n'),
    )
  })

  it('keeps a quote with backticks or pipes inside one intact cell', () => {
    const md = generateSampleSkeleton([
      { path: 'p.md', line: '# Adopt `evidence-layer` now' },
      { path: 't.ts', line: "export type Level = 'pass' | 'error'" },
    ])
    expect(md).toContain('| `p.md` | `` # Adopt `evidence-layer` now `` |')
    expect(md).toContain("| `t.ts` | `export type Level = 'pass' \\| 'error'` |")
  })

  it('round-trips: parseReceipt reads back exactly the lines it was given', () => {
    const samples = [
      { path: 'a.ts', line: 'import x' },
      { path: 'p.md', line: '# Adopt `evidence-layer` now' },
      { path: 't.ts', line: "export type Level = 'pass' | 'error'" },
      { path: 'f.md', line: '```ts' },
      { path: 'g.md', line: '`x`' },
    ]
    expect(parseReceipt(generateSampleSkeleton(samples, 3)).samples).toEqual(samples)
  })

  it('notes an omitted count when the caller capped the list, without inventing entries', () => {
    const md = generateSampleSkeleton([{ path: 'a.ts', line: 'import x' }], 5)
    expect(md).toContain('5 more changed files omitted')
  })

  it('omits the note entirely when nothing was left out', () => {
    expect(generateSampleSkeleton([{ path: 'a.ts', line: 'x' }])).not.toContain('omitted')
  })
})
