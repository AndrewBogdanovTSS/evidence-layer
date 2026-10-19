import { describe, expect, it } from 'vitest'
import { GRADE_WINDOW, lintClaims } from '../src/core/claims'

const F = '`'.repeat(3)
const codes = (md: string, gradeWindow?: number) =>
  lintClaims(md, 'test.md', gradeWindow === undefined ? {} : { gradeWindow }).map((f) => f.code)

// A claim, `gap` lines of prose, then its grade.
const spaced = (gap: number) =>
  ['**Claim**: the design keeps one owner per store.', ...Array.from({ length: gap }, (_, i) => 'Context line ' + (i + 1) + '.'), '**Grounding**: UNVERIFIED'].join('\n')

describe('how far below a claim its grade may sit', () => {
  it('finds the grade within the default window and not past it', () => {
    expect(GRADE_WINDOW).toBe(2)
    expect(codes(spaced(1))).toContain('claims/unverified')
    expect(codes(spaced(2))).toContain('claims/untagged')
  })

  it('widens to the window the caller asks for', () => {
    expect(codes(spaced(4), 5)).toContain('claims/unverified')
    expect(codes(spaced(5), 5)).toContain('claims/untagged')
  })

  it('reads only the claim line itself at a window of 0', () => {
    expect(codes('**Claim**: x. **Grounding**: UNVERIFIED', 0)).toContain('claims/unverified')
    expect(codes('**Claim**: x.\n**Grounding**: UNVERIFIED', 0)).toContain('claims/untagged')
  })

  it('does not count a fenced example between a claim and its grade against the window', () => {
    const md = ['**Claim**: the call site passes the id through.', F + 'ts', 'a()', 'b()', 'c()', 'd()', F, '**Grounding**: UNVERIFIED'].join('\n')
    expect(codes(md)).toContain('claims/unverified')
    expect(codes(md)).not.toContain('claims/untagged')
  })

  it('never takes a grade from inside a fenced block', () => {
    const md = ['**Claim**: the example shows the tag.', F + 'md', '**Grounding**: UNVERIFIED', F].join('\n')
    expect(codes(md)).toContain('claims/untagged')
  })

  it('stops at the next claim, so a claim never borrows the grade below it', () => {
    const md = ['**Claim**: first, ungraded.', '**Claim**: second.', '**Grounding**: UNVERIFIED'].join('\n')
    expect(codes(md, 5)).toEqual(['claims/untagged', 'claims/unverified'])
  })

  it('refuses a window that is not a whole number of lines', () => {
    expect(() => codes(spaced(1), -1)).toThrow(RangeError)
    expect(() => codes(spaced(1), 1.5)).toThrow(RangeError)
  })
})
