import { describe, expect, it } from 'vitest'
import { extractReport, renderSummary } from '../src/core/ci-summary'
import type { Report } from '../src/core/ci-summary'

const wrap = (json: unknown, noise = 'some console output\n') =>
  noise + '---GOVERNANCE-JSON-BEGIN---\n' + JSON.stringify(json) + '\n---GOVERNANCE-JSON-END---\n' + noise

const clean: Report = {
  schema: 1,
  mode: 'warn',
  generatedAt: '2026-08-31T00:00:00.000Z',
  summary: '3 checked - 0 failed, 0 warnings, 0 unverifiable',
  findings: [{ level: 'pass', claim: 'README claims', detail: 'exited 0' }],
}

describe('extractReport', () => {
  it('finds the block among ordinary console output', () => {
    expect(extractReport(wrap(clean))?.summary).toBe(clean.summary)
  })

  it('returns null when the block is absent', () => {
    expect(extractReport('just logs, no report here')).toBeNull()
  })

  it('returns null on a corrupt block rather than throwing', () => {
    expect(extractReport('---GOVERNANCE-JSON-BEGIN---\n{ nope\n---GOVERNANCE-JSON-END---')).toBeNull()
  })
})

describe('renderSummary', () => {
  it('reports a clean run as clean', () => {
    const md = renderSummary(clean, 'warn')
    expect(md).toContain('Governance: clean')
    expect(md).toContain('README claims')
  })

  it('says errors would fail once enforcement is on, in warn mode', () => {
    const md = renderSummary(
      { ...clean, findings: [{ level: 'error', claim: 'unwired', detail: 'nothing reaches it' }] },
      'warn',
    )
    expect(md).toContain('would fail once enforcement is on')
    expect(md).not.toContain('Governance: clean')
  })

  it('fails outright in enforce mode', () => {
    const md = renderSummary(
      { ...clean, mode: 'enforce', findings: [{ level: 'error', claim: 'unwired', detail: 'x' }] },
      'enforce',
    )
    expect(md).toContain('❌ Governance: 1 failing')
  })

  it('escapes pipes so one detail cannot break the table', () => {
    const md = renderSummary({ ...clean, findings: [{ level: 'warning', claim: 'a | b', detail: 'c | d' }] }, 'warn')
    const row = md.split('\n').find((l) => l.includes('a \\| b'))
    expect(row).toBeDefined()
    expect(row).toContain('c \\| d')
  })

  it('folds a multi-line detail onto one row', () => {
    const md = renderSummary({ ...clean, findings: [{ level: 'error', claim: 'x', detail: 'first\n        second' }] }, 'warn')
    expect(md).not.toMatch(/first\n\s+second/)
    expect(md).toContain('first &middot; second')
  })

  it('renders a flaky finding with its own icon and does not count it as clean', () => {
    const md = renderSummary({ ...clean, findings: [{ level: 'flaky', claim: 'x', detail: 'y' }] }, 'warn')
    expect(md).not.toContain('Every invariant')
    expect(md).toContain('🔁')
  })

  it('says "no report" when there is no report - the branch that matters most', () => {
    const md = renderSummary(null, 'warn')
    expect(md).toContain('no report')
    expect(md).toContain('did not run')
    // Not "does this text ever contain the word clean" - the prose legitimately
    // explains that this differs from a clean run. The thing that must never
    // happen is rendering the actual clean-run verdict heading.
    expect(md).not.toContain('## ✅ Governance: clean')
  })
})
