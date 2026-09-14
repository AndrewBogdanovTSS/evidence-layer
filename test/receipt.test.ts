import { describe, expect, it } from 'vitest'
import { checkSamples, citedPaths, parseReceipt } from '../src/core/receipt'

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
