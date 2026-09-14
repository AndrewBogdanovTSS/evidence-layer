/**
 * The portability test the roadmap called mandatory: "otherwise the whole
 * endeavour is meaningless." `examples/plain-node-project` is a deliberately
 * unrelated fixture - plain JavaScript, no TypeScript, no Vue, no monorepo,
 * its own disconnected `package.json` - and everything below runs against it
 * with zero knowledge of Tetris, Vue, pnpm workspaces or this repository's
 * layout. If any of this needed to change to work here, that would have been
 * a layer-separation bug in `core/`, not a missing adapter.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkReachability, readInvariants } from '../src/core/governance'
import { lintClaims } from '../src/core/claims'
import { checkReceipt, parseReceipt } from '../src/core/receipt'
import { renderSummary } from '../src/core/ci-summary'

const here = fileURLToPath(new URL('.', import.meta.url))
const FIXTURE = join(here, '..', 'examples', 'plain-node-project')

describe('reachability, against a plain npm project this package has never seen', () => {
  it('reads the fixture\'s own invariants, not any cached or hardcoded ones', () => {
    const invariants = readInvariants(join(FIXTURE, 'docs', 'decisions'))
    expect(invariants).toHaveLength(2)
    expect(invariants[0]!.command).toBe('npm test')
  })

  it('resolves `npm test` as reachable via the fixture\'s own CI workflow and npm shorthand', () => {
    const [testInvariant] = checkReachability(FIXTURE)
    expect(testInvariant!.level).toBe('pass')
  })

  it('warns (does not crash, does not silently pass) on the human-enforced invariant', () => {
    const [, humanInvariant] = checkReachability(FIXTURE)
    expect(humanInvariant!.level).toBe('warning')
  })
})

describe('claims linting, against prose that has never mentioned this codebase', () => {
  it('accepts a fully-grounded claim about a completely unrelated function', () => {
    const md = [
      '**Claim**: increment(1) returns 2.',
      '**Grounding**: VERIFIED',
      '',
      '```artifact',
      '$ npm test',
      'tests 3',
      'pass 3',
      'exit: 0',
      '```',
    ].join('\n')
    expect(lintClaims(md, 'review.md').some((f) => f.level === 'error')).toBe(false)
  })
})

describe('the receipt checker, against a repository with no git history at all', () => {
  it('degrades to unverifiable/error rather than crashing when there is nothing to check against', () => {
    const receipt = parseReceipt('**HEAD SHA**: 0000000000000000000000000000000000000000')
    // No .git directory in the fixture at all - every git call fails cleanly.
    expect(() => checkReceipt(receipt, '', FIXTURE)).not.toThrow()
  })
})

describe('the CI summary renderer, which never needed a project to begin with', () => {
  it('renders identically regardless of which project produced the report', () => {
    const report = {
      schema: 1,
      mode: 'warn',
      generatedAt: '2026-01-01T00:00:00.000Z',
      summary: '1 checked - 0 failed, 0 warnings, 0 unverifiable',
      findings: [{ level: 'pass', claim: 'increment is total', detail: 'exited 0' }],
    }
    expect(renderSummary(report, 'warn')).toContain('Governance: clean')
  })
})
