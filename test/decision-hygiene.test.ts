import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkDecisionHygiene } from '../src/core/decision-hygiene'

let repo: string

/** A decision record shaped like this package's own, with only the frontmatter a test needs. */
function writeRecord(name: string, frontmatter: string[]): void {
  const dir = join(repo, 'docs', 'decisions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), ['---', ...frontmatter, '---', '', '# a decision', ''].join('\n'))
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dh-'))
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('checkDecisionHygiene', () => {
  it('reports 0 active, 0 stale explicitly when there is no decisions directory - never a silent pass', () => {
    const findings = checkDecisionHygiene(repo)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.detail).toBe('0 active, 0 stale (no decisions directory)')
  })

  it('warns, rather than errors, on a record with no status field', () => {
    writeRecord('0001-x.md', ['id: DEC-0001', 'review_by: 2099-01-01'])
    const finding = checkDecisionHygiene(repo).find((f) => f.claim.includes('declares a status'))
    expect(finding?.level).toBe('warning')
  })

  it('passes a record whose status is not accepted, without checking its review date', () => {
    writeRecord('0001-x.md', ['id: DEC-0001', 'status: proposed'])
    const finding = checkDecisionHygiene(repo).find((f) => f.claim.includes('review date'))
    expect(finding?.level).toBe('pass')
    expect(finding?.detail).toContain('not `accepted`')
  })

  it('errors an accepted record with no review_by field - not a valid decision without one', () => {
    writeRecord('0001-x.md', ['id: DEC-0001', 'status: accepted'])
    const finding = checkDecisionHygiene(repo).find((f) => f.claim.includes('valid review_by date'))
    expect(finding?.level).toBe('error')
    expect(finding?.detail).toContain('no `review_by` field')
  })

  it('errors an accepted record whose review_by is not a YYYY-MM-DD date', () => {
    writeRecord('0001-x.md', ['id: DEC-0001', 'status: accepted', 'review_by: someday'])
    const finding = checkDecisionHygiene(repo).find((f) => f.claim.includes('valid review_by date'))
    expect(finding?.level).toBe('error')
    expect(finding?.detail).toContain('not a YYYY-MM-DD date')
  })

  it('passes an accepted record whose review_by has not arrived yet, and counts it active', () => {
    writeRecord('0001-x.md', ['id: DEC-0001', 'status: accepted', 'review_by: 2027-01-01'])
    const findings = checkDecisionHygiene(repo, undefined, new Date('2026-09-16'))
    expect(findings.find((f) => f.claim.includes('is still current'))?.level).toBe('pass')
    expect(findings.find((f) => f.claim === 'decision record hygiene')?.detail).toBe('1 active, 0 stale')
  })

  it('flags a stale accepted record as an error, always - never merely a warning', () => {
    writeRecord('0001-x.md', ['id: DEC-0001', 'status: accepted', 'review_by: 2020-01-01'])
    const findings = checkDecisionHygiene(repo, undefined, new Date('2026-09-16'))
    const finding = findings.find((f) => f.claim.includes('is still current'))
    expect(finding?.level).toBe('error')
    expect(finding?.detail).toContain('has passed')
    expect(findings.find((f) => f.claim === 'decision record hygiene')?.detail).toBe('0 active, 1 stale')
  })

  it('scans only the given directory - a nested archive/ is never read automatically', () => {
    writeRecord('0001-x.md', ['id: DEC-0001', 'status: accepted', 'review_by: 2099-01-01'])
    mkdirSync(join(repo, 'docs', 'decisions', 'archive'), { recursive: true })
    writeFileSync(
      join(repo, 'docs', 'decisions', 'archive', '0000-old.md'),
      ['---', 'id: DEC-0000', 'status: accepted', 'review_by: 2020-01-01', '---', ''].join('\n'),
    )
    const findings = checkDecisionHygiene(repo)
    expect(findings.some((f) => f.claim.includes('DEC-0000'))).toBe(false)
    expect(findings.find((f) => f.claim === 'decision record hygiene')?.detail).toBe('1 active, 0 stale')
  })
})
