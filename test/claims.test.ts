import { describe, expect, it } from 'vitest'
import { lintClaims } from '../src/core/claims'
import { artifactId, formatArtifact } from '../src/core/artifact'

const F = '`'.repeat(3)
const lint = (md: string, opts?: { expectedHeadSha?: string }) => lintClaims(md, 'test.md', opts)
const errors = (md: string, opts?: { expectedHeadSha?: string }) => lint(md, opts).filter((f) => f.level === 'error')
const warnings = (md: string) => lint(md).filter((f) => f.level === 'warning')

const LEGACY_ARTIFACT = [F + 'artifact', '$ pnpm test', 'Tests 71 passed (71)', 'exit: 0', F].join('\n')

function addressed(command: string, output: string, commit: string): { id: string; block: string } {
  const id = artifactId(command, commit, output)
  return { id, block: formatArtifact(command, output, 0, { id, commit }) }
}

describe('grounding tags', () => {
  it('fails a claim with no tag at all', () => {
    expect(errors('**Claim**: the engine is deterministic.')[0]!.detail).toContain('no grounding tag')
  })

  it('passes legacy bare VERIFIED when an artifact block follows, with a deprecation warning', () => {
    const md = '**Claim**: the suite passes.\n**Grounding**: VERIFIED\n\n' + LEGACY_ARTIFACT
    expect(errors(md)).toHaveLength(0)
    expect(warnings(md).some((w) => w.detail.includes('VERIFIED[id]'))).toBe(true)
  })

  it('fails legacy VERIFIED with no artifact block', () => {
    const md = '**Claim**: the suite passes.\n**Grounding**: VERIFIED\n\nTrust me.'
    expect(errors(md)[0]!.detail).toContain('no valid artifact block')
  })

  it('accepts VERIFIED[id] addressed anywhere in the document, not just nearby', () => {
    const { id, block } = addressed('pnpm test', 'ok', 'f8ae76a')
    const md = block + '\n\nsome unrelated prose\n\n**Claim**: the suite passes.\n**Grounding**: VERIFIED[' + id + ']'
    const found = errors(md)
    expect(found).toHaveLength(0)
  })

  it('does not warn about the deprecated syntax when the addressed form is used', () => {
    const { id, block } = addressed('pnpm test', 'ok', 'f8ae76a')
    const md = block + '\n\n**Claim**: x.\n**Grounding**: VERIFIED[' + id + ']'
    expect(warnings(md)).toHaveLength(0)
  })

  it('rejects a phantom artifact id', () => {
    const md = '**Claim**: the suite passes.\n**Grounding**: VERIFIED[tests-000000]'
    expect(errors(md)[0]!.detail).toContain('does not exist in this document')
  })

  it('rejects an artifact collected at a different commit than the review claims', () => {
    const { id, block } = addressed('pnpm test', 'ok', 'aaaaaaa')
    const md = block + '\n\n**Claim**: x.\n**Grounding**: VERIFIED[' + id + ']'
    const found = errors(md, { expectedHeadSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
    expect(found[0]!.detail).toContain('collected at')
  })

  it('accepts a matching commit prefix against a full expected sha', () => {
    const { id, block } = addressed('pnpm test', 'ok', 'f8ae76a')
    const md = block + '\n\n**Claim**: x.\n**Grounding**: VERIFIED[' + id + ']'
    expect(errors(md, { expectedHeadSha: 'f8ae76a0cd2194fcef3e6c69cf9478c4a5bc07ab' })).toHaveLength(0)
  })

  it('warns - not errors - when one id backs more than the shotgun threshold of claims', () => {
    const { id, block } = addressed('pnpm test', 'ok', 'f8ae76a')
    const claims = Array.from(
      { length: 3 },
      (_, i) => '**Claim**: claim ' + i + '.\n**Grounding**: VERIFIED[' + id + ']',
    ).join('\n\n')
    const md = block + '\n\n' + claims
    expect(errors(md)).toHaveLength(0)
    expect(warnings(md).some((w) => w.detail.includes('at most'))).toBe(true)
  })

  it('does not warn when an id backs claims at or under the threshold', () => {
    const { id, block } = addressed('pnpm test', 'ok', 'f8ae76a')
    const claims = Array.from(
      { length: 2 },
      (_, i) => '**Claim**: claim ' + i + '.\n**Grounding**: VERIFIED[' + id + ']',
    ).join('\n\n')
    const md = block + '\n\n' + claims
    expect(warnings(md).some((w) => w.detail.includes('at most'))).toBe(false)
  })

  it('accepts a repo file as a citation for DOCUMENTED', () => {
    const md = '**Claim**: the boundary is enforced.\n**Grounding**: DOCUMENTED - see `eslint.config.js`.'
    expect(errors(md)).toHaveLength(0)
  })

  it('fails DOCUMENTED that cites nothing', () => {
    expect(errors('**Claim**: the guideline says so.\n**Grounding**: DOCUMENTED')[0]!.detail).toContain('cites nothing')
  })

  it('requires two or more steps for INFERRED', () => {
    const one = '**Claim**: it follows.\n**Grounding**: INFERRED\n\n1. only one step.'
    expect(errors(one)[0]!.detail).toContain('1 numbered step')

    const two = '**Claim**: it follows.\n**Grounding**: INFERRED\n\n1. first.\n2. second.'
    expect(errors(two)).toHaveLength(0)
  })

  it('treats an honest UNVERIFIED as a pass, not a failure', () => {
    expect(lint('**Claim**: worth doing.\n**Grounding**: UNVERIFIED')[0]!.level).toBe('pass')
  })
})

describe('prose that cannot be wrong', () => {
  it('flags a vague comparative', () => {
    expect(errors('The new timer is more robust.')).toHaveLength(1)
  })

  it('accepts the same sentence when it admits it is unchecked', () => {
    expect(errors('UNVERIFIED: the new timer is more robust.')).toHaveLength(0)
  })

  it('flags unchecked equivalence', () => {
    expect(errors('The two paths should be equivalent.')).toHaveLength(1)
  })

  it('flags a success word with no stated effect', () => {
    expect(errors('I ran it locally and it works.')).toHaveLength(1)
  })

  it('accepts a success word with an effect nearby', () => {
    const md = 'The clear delay is fixed.\n\n**Effect**: the CLEARING phase now ends after 400 ms; fingerprints unchanged.'
    expect(errors(md)).toHaveLength(0)
  })

  it('warns rather than fails on flattery', () => {
    const found = lint("You're probably right about that.")
    expect(found.some((f) => f.level === 'warning')).toBe(true)
    expect(found.some((f) => f.level === 'error')).toBe(false)
  })

  it('does not flag an untagged, ordinary opinion - the taste boundary this layer does not judge', () => {
    // This is the documented boundary from `docs/evidence-layer.md`, not the
    // roadmap's original suggested wording ("cleaner"), which is already
    // banned language by design rather than an example of unjudged taste.
    expect(errors('This will be hard to maintain.')).toHaveLength(0)
  })
})

describe('false positives - the reason people switch checkers off', () => {
  it('ignores everything inside a fenced block', () => {
    const md = ['Quoting a bad review:', '', F, 'it works and is more robust', F].join('\n')
    expect(errors(md)).toHaveLength(0)
  })

  it('does not fire on ordinary English containing "the same"', () => {
    expect(errors('This is the same review, repaired.')).toHaveLength(0)
  })

  it('does not treat a hypothetical as a success claim', () => {
    expect(errors('It could not be tested without a GPU.')).toHaveLength(0)
  })
})
