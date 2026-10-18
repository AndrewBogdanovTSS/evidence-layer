import { describe, expect, it } from 'vitest'
import { lintClaims } from '../src/core/claims'
import { artifactId, formatArtifact } from '../src/core/artifact'
import { evaluatePredicates, parsePredicates, suggestPredicates } from '../src/core/predicates'

const TESTS = 'ok\n[SUMMARY tests: passed=71 failed=0 skipped=0 todo=0]'
const LINT = '[SUMMARY lint: files=7 ignored=0 errors=0 warnings=0]'

function review(tag: string, opts: { command?: string; output?: string; exitCode?: number; claim?: string } = {}): string {
  const command = opts.command ?? 'pnpm test'
  const output = opts.output ?? TESTS
  const id = artifactId(command, 'f8ae76a', output)
  const block = formatArtifact(command, output, opts.exitCode ?? 0, { id, commit: 'f8ae76a' })
  return (
    '**Claim**: ' + (opts.claim ?? 'The test suite ran 71 passing tests and reports no failures.') + '\n' +
    '**Grounding**: VERIFIED[' + tag.replace('ID', id) + ']\n\n' + block
  )
}
const errors = (md: string) => lintClaims(md, 'review.md').filter((f) => f.level === 'error')

describe('parsePredicates', () => {
  it('reads every operator, two-character ones first', () => {
    const { predicates, problems } = parsePredicates(' exit=0, failed!=1, passed>=71, skipped<=0, todo<1')
    expect(problems).toEqual([])
    expect(predicates.map((p) => p.op)).toEqual(['=', '!=', '>=', '<=', '<'])
  })

  it('rejects an unknown key rather than dropping it', () => {
    expect(parsePredicates('exit_code=0').problems[0]).toContain('`exit_code` is not a predicate key')
  })

  it('has no duration_ms - how long a run took is not a property of the code', () => {
    expect(parsePredicates('duration_ms<500').problems[0]).toContain('not a predicate key')
  })

  it('rejects a fragment that is not key-op-value', () => {
    expect(parsePredicates('exit 0').problems[0]).toContain('is not `<key><op><value>`')
    expect(parsePredicates('exit=0,,failed=0').problems[0]).toContain('empty predicate')
    expect(parsePredicates('  ').problems[0]).toContain('no predicates')
  })

  it('rejects the same key twice - a range is two claims, not one', () => {
    expect(parsePredicates('exit=0, exit=0').problems[0]).toContain('appears more than once')
    expect(parsePredicates('passed>=1, passed<=9').problems[0]).toContain('appears more than once')
  })

  it('takes only = and != on stopped, and only known stop reasons', () => {
    expect(parsePredicates('stopped=timeout').problems).toEqual([])
    expect(parsePredicates('stopped<timeout').problems[0]).toContain('only takes `=` or `!=`')
    expect(parsePredicates('stopped=crashed').problems[0]).toContain('not a stop reason')
  })

  it('takes whole numbers only on numeric keys - no 0x10, no strings compared as text', () => {
    expect(parsePredicates('exit=0x10').problems[0]).toContain('not a whole number')
    expect(parsePredicates('passed>=abc').problems[0]).toContain('not a whole number')
    expect(parsePredicates('passed>=1e3').problems[0]).toContain('not a whole number')
    expect(parsePredicates('passed>=9007199254740993').problems[0]).toContain('not a whole number')
  })
})

describe('evaluatePredicates', () => {
  const artifact = { output: TESTS, exitCode: 0 }

  it('passes when every predicate holds', () => {
    expect(evaluatePredicates(parsePredicates('exit=0, passed>=71, failed=0').predicates, artifact)).toEqual([])
  })

  it('names the predicate that does not hold and the value the artifact has', () => {
    expect(evaluatePredicates(parsePredicates('passed>=100').predicates, artifact)).toEqual([
      '`passed>=100` does not hold - the artifact says passed=71',
    ])
  })

  it('refuses a summary key on an artifact with no work summary', () => {
    expect(evaluatePredicates(parsePredicates('failed=0').predicates, { output: 'ok', exitCode: 0 })[0]).toContain(
      'needs a work summary',
    )
  })

  it('refuses a summary key of the other kind', () => {
    expect(evaluatePredicates(parsePredicates('errors=0').predicates, artifact)[0]).toContain(
      '`errors` is a lint count, but this artifact summarises a tests run',
    )
  })

  it('reads stopped off the exit line, folding the signal name into killed', () => {
    const killed = { output: '', exitCode: 137, stopped: 'killed SIGKILL' as const }
    expect(evaluatePredicates(parsePredicates('stopped=killed').predicates, killed)).toEqual([])
    expect(evaluatePredicates(parsePredicates('stopped=none').predicates, artifact)).toEqual([])
  })
})

describe('suggestPredicates', () => {
  it('says what the run shows, floor on passed and exact on failures', () => {
    expect(suggestPredicates({ output: TESTS, exitCode: 0 })).toBe('exit=0, passed>=71, failed=0')
    expect(suggestPredicates({ output: LINT, exitCode: 0 })).toBe('exit=0, files=7, ignored=0, errors=0, warnings=0')
    expect(suggestPredicates({ output: 'ok', exitCode: 2 })).toBe('exit=2')
    expect(suggestPredicates({ output: '', exitCode: 124, stopped: 'timeout' })).toBe('stopped=timeout')
  })
})

describe('predicates inside lintClaims', () => {
  it('passes a claim whose predicates hold, and says which', () => {
    const findings = lintClaims(review('ID: exit=0, passed>=71, failed=0'), 'review.md')
    expect(findings.filter((f) => f.level === 'error')).toEqual([])
    expect(findings.find((f) => f.level === 'pass')!.detail).toContain('exit=0, passed>=71, failed=0 hold')
  })

  it('fails a claim whose numbers the artifact contradicts', () => {
    expect(errors(review('ID: passed>=100'))[0]!.detail).toContain('`passed>=100` does not hold')
  })

  it('fails a predicate it cannot parse instead of checking the rest', () => {
    expect(errors(review('ID: exit=0, pased>=71'))[0]!.detail).toContain('cannot be checked')
  })

  it('reports a malformed bracket as an error, never as bare VERIFIED', () => {
    for (const tag of ['ID:', 'id', 'tests-xyz', 'tests-000: exit=0', 'TESTS-abcdef']) {
      const found = errors(review(tag))
      expect(found.length, tag).toBeGreaterThan(0)
      expect(found[0]!.detail, tag).not.toContain('no valid artifact block within')
    }
    const unclosed = review('ID: exit=0').replace(/\]\n/, '\n')
    expect(errors(unclosed)[0]!.detail).toContain('is not an address')
  })

  it('still applies the outcome rules - a weak predicate does not get a zero run through', () => {
    const zero = 'ok\n[SUMMARY tests: passed=0 failed=0 skipped=5 todo=0]'
    const md = review('ID: exit=0, failed=0', { output: zero, claim: 'The test suite reports no failures.' })
    expect(errors(md)[0]!.detail).toContain('checked nothing')
  })

  it('catches a zero run only through the wording or a positive predicate - the wording rules are English', () => {
    // The outcome rules read the claim's words, and they read English. A claim
    // worded in another language is not recognised as a success claim, so a
    // weak predicate leaves a zero run unchallenged; the skeleton's own
    // `passed>=N` is what catches it. Pinned so the limit stays visible.
    const zero = 'ok\n[SUMMARY tests: passed=0 failed=0 skipped=5 todo=0]'
    const russian = 'Тесты проходят без ошибок.'
    expect(errors(review('ID: exit=0, failed=0', { output: zero, claim: russian }))).toEqual([])
    expect(errors(review('ID: exit=0, passed>=1, failed=0', { output: zero, claim: russian }))[0]!.detail).toContain(
      '`passed>=1` does not hold',
    )
    expect(errors(review('ID: exit=0, failed=0', { output: zero, claim: 'Tests pass.' }))[0]!.detail).toContain(
      'checked nothing',
    )
  })

  it('does not read `passed` inside the tag as the claim saying something passed', () => {
    const failing = 'boom\n[SUMMARY tests: passed=3 failed=2 skipped=0 todo=0]'
    const md = review('ID: exit=1, passed>=3, failed=2', {
      output: failing,
      exitCode: 1,
      claim: 'The test suite reports failures.',
    })
    expect(errors(md)).toEqual([])
  })

  it('works with the tag on the claim line itself', () => {
    const id = artifactId('pnpm test', 'f8ae76a', TESTS)
    const md =
      '**Claim**: Tests pass. VERIFIED[' + id + ': exit=0, failed=0, passed>=71]\n\n' +
      formatArtifact('pnpm test', TESTS, 0, { id, commit: 'f8ae76a' })
    expect(errors(md)).toEqual([])
  })
})

describe('one id, one block', () => {
  it('fails two different blocks under the same id', () => {
    const md = review('ID: exit=0')
    const forged = md.replace('Tests 71', 'Tests 99') + '\n\n' + md.split('\n\n')[1]!.replace('ok', 'forged')
    expect(errors(forged).some((f) => f.claim.includes('is one artifact'))).toBe(true)
  })

  it('accepts the same block pasted twice', () => {
    const md = review('ID: exit=0')
    const block = md.split('\n\n')[1]!
    expect(errors(md + '\n\n' + block)).toEqual([])
  })
})
