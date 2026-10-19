import { describe, expect, it } from 'vitest'
import { artifactId, formatArtifact, formatWorkSummary } from '../src/core/artifact'
import type { InlineClaim } from '../src/core/claims'
import { lintClaims } from '../src/core/claims'

const COMMIT = 'f8ae76a'
const HEAD = COMMIT + '0'.repeat(33)

function block(command: string, output: string, exitCode = 0): { id: string; text: string } {
  const id = artifactId(command, COMMIT, output)
  return { id, text: formatArtifact(command, output, exitCode, { id, commit: COMMIT }) }
}

const tests = block('pnpm test', 'Tests 3 passed (3)\n' + formatWorkSummary('tests', { passed: 3 }))
const failing = block('pnpm lint', '1 error', 1)

// A risk table the caller parses with its own grammar - this module does not.
function review(...rows: string[]): { md: string; claims: InlineClaim[] } {
  const lines = ['| Severity | Area | Description |', '|---|---|---|', ...rows.map((r) => '| High | store | ' + r + ' |'), '', tests.text, '', failing.text]
  return { md: lines.join('\n'), claims: rows.map((r, i) => ({ line: i + 3, text: r })) }
}

const grade = (r: { md: string; claims: InlineClaim[] }, opts = {}) =>
  lintClaims(r.md, 'review.md', { inlineClaims: r.claims, expectedHeadSha: HEAD, prose: false, ...opts })
const codes = (...rows: string[]) => grade(review(...rows)).map((f) => f.code)

describe('inline claims', () => {
  it('grades an addressed VERIFIED cell by the same rules as a claim block', () => {
    const findings = grade(review('suite stays green VERIFIED[' + tests.id + ']'))
    expect(findings.map((f) => f.code)).toEqual(['claims/verified'])
    expect(findings[0]!.line).toBe(3)
  })

  it('evaluates predicates the cell states, and only when it states them', () => {
    expect(codes('tests pass VERIFIED[' + tests.id + ': exit=0, passed>=3]')).toEqual(['claims/verified'])
    expect(codes('tests pass VERIFIED[' + tests.id + ': passed>=4]')).toEqual(['claims/predicate-unmet'])
    expect(codes('tests pass VERIFIED[' + tests.id + ': passed>>4]')).toEqual(['claims/bad-predicate'])
  })

  it('applies the outcome rule: no success claim on a failing run', () => {
    expect(codes('lint passes VERIFIED[' + failing.id + ']')).toEqual(['claims/outcome-mismatch'])
  })

  it('reports a malformed address, an unknown artifact and a wrong commit', () => {
    expect(codes('x VERIFIED[tests]')).toEqual(['claims/malformed-address'])
    expect(codes('x VERIFIED[tests-000000]')).toEqual(['claims/unknown-artifact'])
    const r = review('suite stays green VERIFIED[' + tests.id + ']')
    expect(grade(r, { expectedHeadSha: 'b'.repeat(40) }).map((f) => f.code)).toEqual(['claims/wrong-commit'])
  })

  it('fails a cell with no grade', () => {
    expect(codes('the store leaks between requests')).toEqual(['claims/untagged'])
  })

  it('looks below the cell for a bare VERIFIED block, with the usual deprecation warning', () => {
    expect(codes('suite stays green VERIFIED')).toEqual(['claims/verified-nearby', 'claims/bare-verified'])
  })

  it('needs a DOCUMENTED citation inside the cell - there are no lines below it to borrow', () => {
    expect(codes('DOCUMENTED per https://example.com/spec')).toEqual(['claims/documented'])
    expect(codes('DOCUMENTED')).toEqual(['claims/uncited'])
  })

  it('holds an inline INFERRED to a reason beside the tag, not a numbered chain', () => {
    expect(codes('[INFERRED: fewer unique URLs -> more cache reuse]')).toEqual(['claims/reasoned'])
    expect(codes('INFERRED')).toEqual(['claims/no-reason'])
    expect(codes('[INFERRED: cache]')).toEqual(['claims/no-reason'])
  })

  it('counts inline claims towards the shotgun check with the blocks', () => {
    const r = review(...['a', 'b', 'c'].map((x) => x + ' VERIFIED[' + tests.id + ']'))
    const md = r.md + '\n\n**Claim**: d.\n**Grounding**: VERIFIED[' + tests.id + ']'
    const shotgun = lintClaims(md, 'review.md', { inlineClaims: r.claims, prose: false }).find((f) => f.code === 'claims/shotgun')
    expect(shotgun?.claim).toBe('artifact ' + tests.id + ' backs 4 claims')
  })

  it('does not report "no claims" when the only claims are inline', () => {
    const r = review('suite stays green VERIFIED[' + tests.id + ']')
    expect(lintClaims(r.md, 'review.md', { inlineClaims: r.claims }).map((f) => f.code)).not.toContain('claims/none')
  })

  it('refuses a line that is not in the document', () => {
    const r = review('x UNVERIFIED')
    expect(() => lintClaims(r.md, 'review.md', { inlineClaims: [{ line: 0, text: 'x' }] })).toThrow(RangeError)
    expect(() => lintClaims(r.md, 'review.md', { inlineClaims: [{ line: 999, text: 'x' }] })).toThrow(RangeError)
  })
})
