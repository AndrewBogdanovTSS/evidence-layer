import { describe, expect, it } from 'vitest'
import { generateClaimSkeleton, generateSampleSkeleton, summaryCommand } from '../src/core/skeleton'
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
    expect(skeleton).toContain('**Grounding**: VERIFIED[tests-aaaaaa: exit=0]')
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

  it('fills in predicates read off the run, which the linter then holds the artifact to', () => {
    const output = 'ok\n[SUMMARY tests: passed=71 failed=0 skipped=0 todo=0]'
    const skeleton = generateClaimSkeleton([{ ...artifact('pnpm test', 0, 'tests-abcdef'), output }])
    expect(skeleton).toContain('**Grounding**: VERIFIED[tests-abcdef: exit=0, passed>=71, failed=0]')
    expect(lintClaims(skeleton, 'skeleton.md').filter((f) => f.level === 'error')).toEqual([])
  })

  it('writes predicates for a failing run that the linter accepts as a failure claim', () => {
    const output = 'boom\n[SUMMARY tests: passed=3 failed=2 skipped=0 todo=0]'
    const skeleton = generateClaimSkeleton([{ ...artifact('pnpm test', 1, 'tests-abcdef'), output }])
    expect(skeleton).toContain('VERIFIED[tests-abcdef: exit=1, passed>=3, failed=2]')
    expect(lintClaims(skeleton, 'skeleton.md').filter((f) => f.level === 'error')).toEqual([])
  })

  it('writes lint predicates from a lint summary', () => {
    const output = '[SUMMARY lint: files=7 ignored=0 errors=0 warnings=0]'
    const skeleton = generateClaimSkeleton([{ ...artifact('pnpm lint', 0, 'lint-abcdef'), output }])
    expect(skeleton).toContain('VERIFIED[lint-abcdef: exit=0, files=7, ignored=0, errors=0, warnings=0]')
    expect(lintClaims(skeleton, 'skeleton.md').filter((f) => f.level === 'error')).toEqual([])
  })

  it('writes only the stop reason for a run that never finished', () => {
    const skeleton = generateClaimSkeleton([{ ...artifact('pnpm test', 137, 'tests-abcdef'), stopped: 'killed SIGKILL' as const }])
    expect(skeleton).toContain('VERIFIED[tests-abcdef: stopped=killed]')
    expect(lintClaims(skeleton, 'skeleton.md').filter((f) => f.level === 'error')).toEqual([])
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

describe('the fold option', () => {
  it('folds each artifact block under its Grounding line, which stays outside the fold', () => {
    const skeleton = generateClaimSkeleton(
      [artifact('BRAND=canvas NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck', 0, 'types-aaaaaa')],
      { fold: true },
    )
    expect(skeleton.split('\n')).toEqual([
      '**Claim**: Typecheck reports no errors.',
      '**Grounding**: VERIFIED[types-aaaaaa: exit=0]',
      '',
      '<details>',
      '<summary>📄 <b>Output</b> - <code>BRAND=canvas pnpm typecheck</code> - exit 0, 3 lines</summary>',
      '<div style="height:8px"></div>',
      '',
      '```artifact:types-aaaaaa@f8ae76a',
      '$ BRAND=canvas NODE_OPTIONS=--max-old-space-size=8192 pnpm typecheck',
      'ok',
      'exit: 0',
      '```',
      '',
      '</details>',
      '',
    ])
  })

  it('keeps a folded skeleton acceptable to the linter and readable by the artifact parser', () => {
    const output = 'ok\n[SUMMARY tests: passed=3 failed=0 skipped=0 todo=0]'
    const skeleton = generateClaimSkeleton([{ ...artifact('pnpm test src/a.test.ts', 0, 'tests-abcdef'), output }], { fold: true })
    const lines = skeleton.split('\n')
    expect(lintClaims(skeleton, 'skeleton.md').filter((f) => f.level === 'error')).toEqual([])
    expect(findArtifactBlocks(lines)[0]?.id).toBe('tests-abcdef')
    expect(findClaims(lines, new Set())[0]?.gradeId).toBe('tests-abcdef')
  })

  it('names no path in a summary - a verifier reading prose would take it for a citation', () => {
    const skeleton = generateClaimSkeleton([artifact('pnpm eslint src/a.ts src/b.ts --max-warnings 0', 0, 'lint-abcdef')], { fold: true })
    const summary = skeleton.split('\n').find((line) => line.startsWith('<summary>'))
    expect(summary).toBe('<summary>📄 <b>Output</b> - <code>pnpm eslint 0</code> - exit 0, 3 lines</summary>')
  })

  it('states a stop reason in the summary, as the exit line does', () => {
    const skeleton = generateClaimSkeleton([{ ...artifact('pnpm typecheck', 124, 'types-bbbbbb'), stopped: 'timeout' as const }], { fold: true })
    expect(skeleton).toContain('<code>pnpm typecheck</code> - exit 124 (timeout), 3 lines</summary>')
  })

  it('folds the Sample integrity table under a summary that counts files without naming them', () => {
    const samples = [{ path: 'src/a.ts', line: 'import x' }, { path: 'src/b.ts', line: 'import y' }]
    const md = generateSampleSkeleton(samples, 0, { fold: true })
    expect(md.split('\n')).toEqual([
      '<details>',
      '<summary>🔍 <b>Sample integrity</b> - 2 files</summary>',
      '<div style="height:8px"></div>',
      '',
      '| File | First non-blank line |',
      '|---|---|',
      '| `src/a.ts` | `import x` |',
      '| `src/b.ts` | `import y` |',
      '',
      '</details>',
    ])
    expect(parseReceipt(md).samples).toEqual(samples)
  })

  it('keeps the omitted-files note inside a folded table and counts one file in the singular', () => {
    const md = generateSampleSkeleton([{ path: 'a.ts', line: 'import x' }], 4, { fold: true })
    expect(md).toContain('<summary>🔍 <b>Sample integrity</b> - 1 file</summary>')
    expect(md.indexOf('<!-- 4 more changed files omitted')).toBeLessThan(md.indexOf('</details>'))
  })
})

describe('summaryCommand', () => {
  it('keeps environment assignments and drops NODE_OPTIONS, even when quoted with spaces', () => {
    expect(summaryCommand("BRAND=vans NODE_OPTIONS='--max-old-space-size=8192 --trace-warnings' pnpm typecheck")).toBe('BRAND=vans pnpm typecheck')
  })

  it('drops --flags and every path-like word, POSIX or Windows', () => {
    expect(summaryCommand('pnpm test src/a.test.ts C:\\repo\\b.test.ts --no-watch')).toBe('pnpm test')
  })

  it('returns an empty name when every word is dropped, and the summary then leaves the command out', () => {
    expect(summaryCommand('./scripts/check.sh --all')).toBe('')
    const skeleton = generateClaimSkeleton([artifact('./scripts/check.sh', 0, 'cmd-aaaaaa')], { fold: true })
    expect(skeleton).toContain('<summary>📄 <b>Output</b> - exit 0, 3 lines</summary>')
  })

  it('escapes HTML in the name, since the summary is HTML', () => {
    const skeleton = generateClaimSkeleton([artifact('pnpm lint 2>&1', 0, 'lint-aaaaaa')], { fold: true })
    expect(skeleton).toContain('<code>pnpm lint 2&gt;&amp;1</code>')
  })
})
