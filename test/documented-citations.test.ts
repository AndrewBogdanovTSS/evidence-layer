// A DOCUMENTED claim that cites a file in backticks is held to the files the
// repository has: the citation a reader cannot check by eye is the one most
// worth checking by machine.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { downgradeClaims, lintClaims } from '../src/core/claims'
import { repositoryPaths } from '../src/core/receipt'
import { sh } from './helpers/git'

const PATHS = new Set(['README.md', 'docs/decisions/0001-start.md', 'src/core/claims.ts'])
const claim = (grounding: string) => '**Claim**: the gate runs at stop.\n**Grounding**: ' + grounding + '\n'
const lint = (md: string, paths?: (() => ReadonlySet<string> | null) | undefined) =>
  lintClaims(md, 'review.md', { prose: false, ...(paths && { paths }) })
const codes = (md: string, paths: ReadonlySet<string> | null = PATHS) => lint(md, () => paths).map((f) => f.code)

describe('DOCUMENTED file citations', () => {
  it('passes a citation to a file the repository has, by its path or by its bare name', () => {
    expect(codes(claim('DOCUMENTED in `docs/decisions/0001-start.md`'))).toEqual(['claims/documented'])
    expect(codes(claim('DOCUMENTED in `./src/core/claims.ts`'))).toEqual(['claims/documented'])
    expect(codes(claim('DOCUMENTED in `claims.ts`'))).toEqual(['claims/documented'])
  })

  it('fails a citation to a file that is not there, naming it and where it looked', () => {
    const findings = lint(claim('DOCUMENTED in `docs/decisions/0009-gone.md`'), () => PATHS)
    expect(findings.map((f) => f.code)).toEqual(['claims/cited-file-missing'])
    expect(findings[0]!.level).toBe('error')
    expect(findings[0]!.detail).toContain('`docs/decisions/0009-gone.md`')
    expect(findings[0]!.detail).toContain('this repository')
    expect(codes(claim('DOCUMENTED in `gone.ts`'))).toEqual(['claims/cited-file-missing'])
  })

  it('fails the claim when one of its cited files is missing, even beside a URL that may be fine', () => {
    expect(codes(claim('DOCUMENTED at https://example.com/spec and `docs/nope.md`'))).toEqual(['claims/cited-file-missing'])
  })

  it('reads a backticked token whose extension no file has as code, not as a failed citation', () => {
    expect(codes(claim('DOCUMENTED at https://example.com/spec, see `Array.prototype` and `example.com`'))).toEqual(['claims/documented'])
  })

  it('never resolves URLs, sections or issue ids, and never lists files for them', () => {
    let listed = 0
    const findings = lint(claim('DOCUMENTED per #12 and § 4.2 and https://example.com/x'), () => (listed++, PATHS))
    expect(findings.map((f) => f.code)).toEqual(['claims/documented'])
    expect(listed).toBe(0)
  })

  it('says unverifiable, not pass, when the files could not be listed', () => {
    const findings = lint(claim('DOCUMENTED in `docs/decisions/0001-start.md`'), () => null)
    expect(findings.map((f) => [f.code, f.level])).toEqual([
      ['claims/cited-file-unchecked', 'unverifiable'],
      ['claims/documented', 'pass'],
    ])
  })

  it('checks nothing beyond the citation being there when no listing is given', () => {
    expect(lint(claim('DOCUMENTED in `docs/nope.md`')).map((f) => f.code)).toEqual(['claims/documented'])
  })

  it('lets the honest fix through: a missing file citation is downgraded to UNVERIFIED', () => {
    const md = claim('DOCUMENTED in `docs/nope.md`')
    const { markdown, downgraded } = downgradeClaims(md, lint(md, () => PATHS))
    expect(downgraded.map((d) => d.code)).toEqual(['claims/cited-file-missing'])
    expect(codes(markdown)).toEqual(['claims/unverified'])
  })
})

describe('repositoryPaths', () => {
  it('lists a commit by its tree and the checkout with untracked files, from the root, never ignored ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'el-paths-'))
    sh(dir, 'init', '-q')
    sh(dir, 'config', 'user.email', 't@t')
    sh(dir, 'config', 'user.name', 't')
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs', 'a.md'), 'a\n')
    writeFileSync(join(dir, '.gitignore'), 'secret.md\n')
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-qm', 'init')
    const head = sh(dir, 'rev-parse', 'HEAD')
    writeFileSync(join(dir, 'docs', 'new.md'), 'n\n')
    writeFileSync(join(dir, 'secret.md'), 's\n')

    expect([...repositoryPaths(dir, head)!].sort()).toEqual(['.gitignore', 'docs/a.md'])
    expect([...repositoryPaths(dir)!].sort()).toEqual(['.gitignore', 'docs/a.md', 'docs/new.md'])
    // From a directory below the root, its files also go by their path from it.
    expect([...repositoryPaths(join(dir, 'docs'))!].sort()).toEqual(['.gitignore', 'a.md', 'docs/a.md', 'docs/new.md', 'new.md'])
    expect([...repositoryPaths(join(dir, 'docs'), head)!].sort()).toEqual(['.gitignore', 'a.md', 'docs/a.md'])
    expect(repositoryPaths(dir, '0'.repeat(40))).toBeNull()
  })
})

describe('repositoryPaths for a review below the root', () => {
  it('names a file also from each directory that holds the review, and from nowhere else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'el-paths-pkg-'))
    sh(dir, 'init', '-q')
    mkdirSync(join(dir, 'packages', 'app', 'reviews'), { recursive: true })
    mkdirSync(join(dir, 'packages', 'lib', 'docs'), { recursive: true })
    writeFileSync(join(dir, 'packages', 'app', 'index.js'), 'a\n')
    writeFileSync(join(dir, 'packages', 'lib', 'docs', 'x.md'), 'x\n')
    const paths = repositoryPaths(dir, undefined, 'packages/app/reviews/review.md')!
    expect(paths.has('index.js')).toBe(true)
    expect(paths.has('app/index.js')).toBe(true)
    expect(paths.has('docs/x.md')).toBe(false)
  })
})
