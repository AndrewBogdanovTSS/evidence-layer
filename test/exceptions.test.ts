import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkExceptions, parseExceptions } from '../src/core/exceptions'

const TABLE = [
  '# Exceptions',
  '',
  '| Date | Commit | Issued by | Check | Reason | Expires |',
  '|---|---|---|---|---|---|',
  '| 2026-09-01 | a1b2c3d | you | check:docs | build check needs a build nobody ran | 2099-01-01 |',
  '| 2020-01-01 | e4f5a6b | you | fingerprint | investigating a suspected engine bug | 2020-02-01 |',
].join('\n')

describe('parseExceptions', () => {
  it('reads one row per exception, skipping the header and separator', () => {
    expect(parseExceptions(TABLE)).toHaveLength(2)
  })

  it('reads every column', () => {
    const [first] = parseExceptions(TABLE)
    expect(first).toEqual({
      date: '2026-09-01',
      commit: 'a1b2c3d',
      issuedBy: 'you',
      check: 'check:docs',
      reason: 'build check needs a build nobody ran',
      expires: '2099-01-01',
    })
  })

  it('ignores lines with the wrong shape rather than guessing', () => {
    expect(parseExceptions('not a table row')).toHaveLength(0)
  })
})

let repo: string
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'exc-'))
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('checkExceptions', () => {
  it('reports 0 active, 0 expired explicitly when the file does not exist - never a silent pass', () => {
    const findings = checkExceptions(repo)
    expect(findings[0]!.detail).toBe('0 active, 0 expired (no exceptions file)')
  })

  it('counts an unexpired exception as active, not as a finding', () => {
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'governance-exceptions.md'), TABLE)
    const findings = checkExceptions(repo, 'docs/governance-exceptions.md', new Date('2026-09-06'))
    const summary = findings.find((f) => f.detail.includes('active'))
    expect(summary?.detail).toContain('1 active')
  })

  it('flags an expired exception as an error, always - never merely a warning', () => {
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'governance-exceptions.md'), TABLE)
    const findings = checkExceptions(repo, 'docs/governance-exceptions.md', new Date('2026-09-06'))
    const expired = findings.find((f) => f.claim.includes('fingerprint'))
    expect(expired?.level).toBe('error')
    expect(expired?.detail).toContain('expired')
  })

  it('rejects an exception with no valid expiry date - an exception without one is not valid', () => {
    const noExpiry = TABLE.replace('2099-01-01', 'someday')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'governance-exceptions.md'), noExpiry)
    const findings = checkExceptions(repo, 'docs/governance-exceptions.md', new Date('2026-09-06'))
    expect(findings.some((f) => f.level === 'error' && f.detail.includes('not a YYYY-MM-DD date'))).toBe(true)
  })
})
