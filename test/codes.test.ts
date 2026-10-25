/**
 * Reason codes as a contract: every registered code is one some check can
 * produce, no released code is ever dropped, and `--format json` is one
 * document carrying them, with the exit code the text mode would have given.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { downgradeClaims, lintClaims } from '../src/core/claims'
import { CODES } from '../src/core/codes'
import type { CodedFinding } from '../src/core/codes'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN = join(root, 'dist', 'bin', 'evidence-layer.mjs')
const REVIEWS = [
  ...readdirSync(join(root, 'examples', 'plain-node-project', 'reviews')).map((f) => join('examples', 'plain-node-project', 'reviews', f)),
  ...readdirSync(join(root, 'demo', 'reviews')).map((f) => join('demo', 'reviews', f)),
].filter((f) => f.endsWith('.md'))

const cli = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' })

describe('the reason-code registry', () => {
  it('names only codes some check produces', () => {
    const dirs = ['src/core', 'src/commands']
    const source = dirs
      .flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith('.ts') && f !== 'codes.ts').map((f) => join(root, d, f)))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n')
    expect(Object.keys(CODES).filter((code) => !source.includes("'" + code + "'"))).toEqual([])
  })

  it('keeps every code it has released', () => {
    const released = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'codes-released.json'), 'utf8')) as {
      since: Record<string, string[]>
    }
    expect(Object.values(released.since).flat().filter((code) => !(code in CODES))).toEqual([])
  })

  it('gives every finding over the example reviews a registered code', () => {
    for (const review of REVIEWS) {
      const findings = lintClaims(readFileSync(join(root, review), 'utf8'), review)
      expect(findings.length).toBeGreaterThan(0)
      for (const f of findings) expect(f.code !== undefined && f.code in CODES, review + ': ' + f.detail).toBe(true)
    }
  })
})

// An exit code alone would let a fixture fail for some other reason than the
// one it is named for, and nobody would notice the rule it shows had stopped
// firing. So each is held to the codes it exists to show, and to nothing else.
describe('the example reviews that fail on purpose', () => {
  const failing = (review: string) => {
    const path = join('examples', 'plain-node-project', 'reviews', review)
    const markdown = readFileSync(join(root, path), 'utf8')
    return { markdown, findings: lintClaims(markdown, path), errors: (fs: CodedFinding[]) => fs.filter((f) => f.level === 'error') }
  }

  it.each([
    ['kind-mismatch.md', ['claims/kind-mismatch']],
    ['count-mismatch.md', ['claims/count-mismatch']],
    ['outcome-mismatch.md', ['claims/outcome-mismatch']],
    ['fix-me.md', ['claims/bad-predicate', 'claims/count-mismatch', 'claims/kind-mismatch']],
  ])('%s fails with %j and nothing else', (review, codes) => {
    const { findings, errors } = failing(review)
    expect([...new Set(errors(findings).map((f) => f.code))].sort()).toEqual(codes)
    expect(findings.filter((f) => f.level === 'warning' || f.level === 'unverifiable')).toEqual([])
  })

  it('outcome-mismatch.md passes the claim each run does back', () => {
    const { findings } = failing('outcome-mismatch.md')
    expect(findings.filter((f) => f.code === 'claims/verified').length).toBe(3)
  })

  it('fix-me.md is clean once every failing claim is marked UNVERIFIED', () => {
    const { markdown, findings, errors } = failing('fix-me.md')
    const { markdown: fixed, downgraded } = downgradeClaims(markdown, findings)
    expect(downgraded.length).toBe(3)
    expect(errors(lintClaims(fixed, 'fix-me.md'))).toEqual([])
  })
})

describe('--format json', () => {
  const asJson = (...args: string[]) => {
    const text = cli(...args)
    const json = cli(...args, '--format', 'json')
    // The whole of stdout, not a block found inside it.
    const report = JSON.parse(json.stdout) as { schema: number; check: string; findings: { level: string; code?: string }[] }
    return { text, json, report }
  }

  it('prints one report for claims and receipt, with the text mode\'s exit code', () => {
    for (const review of ['examples/plain-node-project/reviews/good-claims.md', 'examples/plain-node-project/reviews/predicate-mismatch.md']) {
      const { text, json, report } = asJson('claims', review)
      expect(json.status).toBe(text.status)
      expect(report.schema).toBe(5)
      expect(report.check).toBe('claims')
      expect(report.findings.every((f) => f.code !== undefined && f.code in CODES)).toBe(true)
    }
    const { text, json, report } = asJson('receipt', 'demo/reviews/bad-receipt.md')
    expect(json.status).toBe(text.status)
    expect(report.check).toBe('receipt')
    expect(report.findings.every((f) => f.code !== undefined && f.code in CODES)).toBe(true)
  })

  it('prints only the report for governance - no text, no delimiters', () => {
    const { text, json, report } = asJson('governance', '--no-journal')
    expect(json.status).toBe(text.status)
    expect(json.stdout).not.toContain('---GOVERNANCE-JSON-BEGIN---')
    expect(report.check).toBe('governance')
    expect(report.findings.every((f) => f.code !== undefined && f.code in CODES)).toBe(true)
  })

  it('refuses a format it does not know, rather than falling back to text', () => {
    expect(cli('claims', 'examples/plain-node-project/reviews/good-claims.md', '--format', 'xml').status).toBe(2)
  })
})
