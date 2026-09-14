import { describe, expect, it } from 'vitest'
import { EXIT, exitCodeFor, parseArgs, summarise } from '../src/core/cli'

describe('parseArgs', () => {
  it('handles values, bare flags and positionals', () => {
    const args = parseArgs(['review.md', '--base', 'origin/master', '--strict'])
    expect(args._).toEqual(['review.md'])
    expect(args.base).toBe('origin/master')
    expect(args.strict).toBe(true)
  })
})

describe('the exit-code contract', () => {
  it('passes when nothing failed', () => {
    expect(exitCodeFor([{ level: 'pass', claim: 'a', detail: '' }])).toBe(EXIT.ok)
  })

  it('fails on any error', () => {
    expect(exitCodeFor([{ level: 'error', claim: 'a', detail: '' }])).toBe(EXIT.failed)
  })

  it('does not fail on unverifiable by default, and does under --strict', () => {
    const findings = [{ level: 'unverifiable' as const, claim: 'a', detail: '' }]
    expect(exitCodeFor(findings)).toBe(EXIT.ok)
    expect(exitCodeFor(findings, true)).toBe(EXIT.failed)
  })

  it('exits with its own code for flaky - distinct from both pass and a real failure', () => {
    expect(exitCodeFor([{ level: 'flaky', claim: 'a', detail: '' }])).toBe(EXIT.flaky)
  })

  it('a real error takes priority over a flaky finding in the same run', () => {
    const findings = [
      { level: 'flaky' as const, claim: 'a', detail: '' },
      { level: 'error' as const, claim: 'b', detail: '' },
    ]
    expect(exitCodeFor(findings)).toBe(EXIT.failed)
  })
})

describe('summarise', () => {
  it('counts every outcome, including flaky', () => {
    const findings = [
      { level: 'pass' as const, claim: 'a', detail: '' },
      { level: 'flaky' as const, claim: 'b', detail: '' },
    ]
    expect(summarise(findings)).toContain('1 flaky')
  })
})
