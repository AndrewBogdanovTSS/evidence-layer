import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gatherEvidence } from '../src/core/gather'
import { checkDiffCount, checkReceipt, checkSamples, citedPaths, parseReceipt } from '../src/core/receipt'
import { generateReceiptSkeleton } from '../src/core/skeleton'
import { sh, tempRepo } from './helpers/git'

const RECEIPT_ONE_SAMPLE = [
  '**Repo path**: /somewhere',
  '**Branch**: master',
  '**HEAD SHA**: f8ae76a0cd2194fcef3e6c69cf9478c4a5bc07ab',
  '**Target branch**: demo-base',
  '**Base SHA**: ed53edc0ed94345a89de5e7cf2fb4edc93f7fe45',
  '**Diff stat**: 9 files changed, 15 insertions(+), 12 deletions(-)',
  '**Files in diff**: 9',
  '**Files opened during review**: 4',
  "**Sample integrity**: `apps/web/app/lib/three.ts` -> `import { COLS } from '@tetris/core'`",
].join('\n')

describe('parseReceipt', () => {
  it('reads every field, including the legacy single-sample shape', () => {
    const r = parseReceipt(RECEIPT_ONE_SAMPLE)
    expect(r.branch).toBe('master')
    expect(r.targetBranch).toBe('demo-base')
    expect(r.headSha).toHaveLength(40)
    expect(r.samples).toHaveLength(1)
    expect(r.samplePath).toBe('apps/web/app/lib/three.ts')
  })

  it('collects every Sample integrity line, not just the first', () => {
    const md =
      RECEIPT_ONE_SAMPLE +
      '\n**Sample integrity**: `eslint.config.js` -> `import tseslint from \'typescript-eslint\'`'
    expect(parseReceipt(md).samples).toHaveLength(2)
  })

  it('reads the table form, unescaping pipes and code-span padding', () => {
    const md = [
      '**Sample integrity**:',
      '',
      '| File | First non-blank line |',
      '| --- | --- |',
      "| `t.ts` | `export type Level = 'pass' \\| 'error'` |",
      '| `p.md` | `` # Adopt `evidence-layer` now `` |',
      '',
      'Prose after the table is not a row.',
    ].join('\n')
    expect(parseReceipt(md).samples).toEqual([
      { path: 't.ts', line: "export type Level = 'pass' | 'error'" },
      { path: 'p.md', line: '# Adopt `evidence-layer` now' },
    ])
  })

  it('keeps line-form and table entries in document order when a review mixes them', () => {
    const md = [
      '**Sample integrity**: `a.ts` -> `import a`',
      '',
      '| File | First non-blank line |',
      '|---|---|',
      '| `b.ts` | `import b` |',
    ].join('\n')
    expect(parseReceipt(md).samples.map((s) => s.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('reads a line-form quote behind a longer delimiter, and a legacy one greedily as before', () => {
    const md = [
      '**Sample integrity**: `p.md` -> `` # Adopt `evidence-layer` now ``',
      '**Sample integrity**: `q.md` -> `# Adopt `evidence-layer` now`',
    ].join('\n')
    expect(parseReceipt(md).samples.map((s) => s.line)).toEqual([
      '# Adopt `evidence-layer` now',
      '# Adopt `evidence-layer` now',
    ])
  })

  it('ignores a table whose header is not the sample header', () => {
    const md = ['| Severity | File |', '|---|---|', '| high | `a.ts` |'].join('\n')
    expect(parseReceipt(md).samples).toEqual([])
  })

  it('reads a count as the first number in its field, not every digit run together', () => {
    expect(parseReceipt('**Files in diff**: 22 (1 not committed)').filesInDiff).toBe(22)
    expect(Number.isNaN(parseReceipt('**Files in diff**: none').filesInDiff)).toBe(true)
  })

  it('leaves a missing field undefined rather than guessing at it', () => {
    expect(parseReceipt('**Branch**: master').headSha).toBeUndefined()
  })
})

describe('citedPaths', () => {
  it('extracts every distinct path from path:line citations, in order, deduplicated', () => {
    const md = 'see `a.ts:1` and `b.ts:5`, also `a.ts:1` again'
    expect(citedPaths(md)).toEqual(['a.ts', 'b.ts'])
  })

  it('returns nothing when there are no citations', () => {
    expect(citedPaths('just prose')).toEqual([])
  })
})

describe('checkSamples - one quote per cited file (v2)', () => {
  it('fails when a cited file has no matching sample - the cheapest-file-quoted gap', () => {
    const receipt = parseReceipt(RECEIPT_ONE_SAMPLE)
    const md = RECEIPT_ONE_SAMPLE + '\n\nsee `eslint.config.js:22` for the boundary rule.'
    const findings = checkSamples(receipt, md, '.')
    const missing = findings.find((f) => f.file === 'eslint.config.js')
    expect(missing?.level).toBe('error')
    expect(missing?.detail).toContain('no Sample integrity line quotes it')
  })

  it('does not require a sample for a file nothing cites', () => {
    // Only apps/web/app/lib/three.ts is cited, and it has a sample - eslint
    // config is never mentioned, so nothing should demand a quote for it.
    const receipt = parseReceipt(RECEIPT_ONE_SAMPLE)
    const md = RECEIPT_ONE_SAMPLE + '\n\nsee `apps/web/app/lib/three.ts:1` for the import.'
    // three.ts's quote will fail against a real git show in this test's cwd,
    // but the point here is only that eslint.config.js generates no finding.
    const findings = checkSamples(receipt, md, '.')
    expect(findings.some((f) => f.file === 'eslint.config.js')).toBe(false)
  })

  it('falls back to requiring at least one sample when the review cites nothing', () => {
    const receipt = parseReceipt('**Sample integrity**: `a.ts` -> `x`')
    expect(checkSamples(receipt, '**Sample integrity**: `a.ts` -> `x`', '.')).toHaveLength(1)
  })

  it('fails outright when there are no citations and no sample at all', () => {
    const receipt = parseReceipt('')
    const findings = checkSamples(receipt, '', '.')
    expect(findings[0]!.level).toBe('error')
  })
})

describe('checkDiffCount - the diff the receipt describes is the diff git computes', () => {
  const twoFileChange = () => {
    const dir = tempRepo('el-receipt-', { 'a.js': 'a\n' })
    const base = sh(dir, 'rev-parse', 'HEAD')
    writeFileSync(join(dir, 'a.js'), 'a2\n')
    writeFileSync(join(dir, 'b.js'), 'b\n')
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-qm', 'change')
    return { dir, base, head: sh(dir, 'rev-parse', 'HEAD') }
  }
  const receipt = (head: string, base: string, files: string) =>
    ['**HEAD SHA**: ' + head, '**Base SHA**: ' + base, '**Files in diff**: ' + files].join('\n')

  it('fails a receipt that undercounts its diff, with the count git gives as the fix', () => {
    const { dir, base, head } = twoFileChange()
    const [finding] = checkDiffCount(parseReceipt(receipt(head, base, '1')), dir)
    expect(finding).toMatchObject({ level: 'error', code: 'receipt/diff-count-mismatch', expected: 1, observed: 2 })
    expect(finding!.fix).toContain('**Files in diff**: 2')
  })

  it('passes the count git gives, and is part of checkReceipt', () => {
    const { dir, base, head } = twoFileChange()
    const md = receipt(head, base, '2')
    expect(checkReceipt(parseReceipt(md), md, dir).find((f) => f.code.startsWith('receipt/diff-count'))?.code).toBe('receipt/diff-count')
  })

  it('says nothing when the base is not a commit here - the base check speaks to that', () => {
    const { dir, head } = twoFileChange()
    expect(checkDiffCount(parseReceipt(receipt(head, 'e'.repeat(40), '1')), dir)).toEqual([])
  })
})

describe('the receipt the gatherer writes', () => {
  it('holds as it stands: receipt on a fresh bundle reports no error, only that no file was opened yet', async () => {
    const dir = tempRepo('el-receipt-', { 'a.js': 'a\n' })
    sh(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    writeFileSync(join(dir, 'a.js'), 'a2\n')
    writeFileSync(join(dir, 'b.js'), 'b\n')
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-qm', 'change')
    const out = join(dir, 'evidence.local.md')
    await gatherEvidence({ repo: dir, base: 'origin/main', out, seal: false, skip: ['lint', 'typecheck', 'lockfile', 'test'] })
    const bundle = readFileSync(out, 'utf8')
    expect(bundle).toContain('## Suggested access receipt')
    const receipt = parseReceipt(bundle)
    expect(receipt).toMatchObject({ targetBranch: 'main', filesInDiff: 2, filesOpened: 0, headSha: sh(dir, 'rev-parse', 'HEAD') })
    const findings = checkReceipt(receipt, bundle, dir)
    expect(findings.filter((f) => f.level === 'error')).toEqual([])
    expect(findings.find((f) => f.code === 'receipt/files-unopened')?.detail).toBe('0 opened of 2 in the diff')
  }, 30_000)

  it('writes no field at all, and says why, when the base it was given is no branch on origin - half a receipt would be errors', () => {
    const text = generateReceiptSkeleton({ branch: 'work', headSha: 'a'.repeat(40), gatheredAgainst: 'HEAD~3' })
    expect(parseReceipt(text)).toMatchObject({ branch: undefined, headSha: undefined, filesOpened: undefined })
    expect(text).toContain('gathered against HEAD~3, which is not a branch on origin')
  })
})
