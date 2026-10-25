/**
 * The `uses: ...evidence-layer@v<version>` lines a reader copies: found by file
 * and line, rewritten to a release in place, and - in this repository - naming
 * the version package.json has, which is what `check:docs` holds them to and
 * what `pnpm release` rewrites them to.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACTION_REF_FILES, findActionRefs, pinActionRefs } from '../scripts/action-refs'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'el-refs-'))
  for (const file of ACTION_REF_FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), files[file] ?? '')
  }
  return dir
}

const README = [
  '# x',
  '```yaml',
  '- uses: actions/checkout@v5',
  '- uses: Someone/evidence-layer@v0.7.0',
  '  with:',
  '    claims: review.md',
  '```',
  'Prose naming `@v0.6.0` is history, not a ref.',
  '',
].join('\n')
const WORKFLOW = 'steps:\n      - uses: Someone/evidence-layer@v0.7.0 # pinned\n      - uses: Someone/evidence-layer-fork@v1.0.0\n'

describe('action refs', () => {
  it('finds each ref by file and line, and nothing that only looks like one', () => {
    const dir = repoWith({ [ACTION_REF_FILES[0]!]: README, [ACTION_REF_FILES[1]!]: WORKFLOW })
    expect(findActionRefs(dir, 'evidence-layer')).toEqual([
      { file: ACTION_REF_FILES[0], line: 4, version: '0.7.0' },
      { file: ACTION_REF_FILES[1], line: 2, version: '0.7.0' },
    ])
  })

  it('rewrites every ref to the release and touches nothing else', () => {
    const dir = repoWith({ [ACTION_REF_FILES[0]!]: README, [ACTION_REF_FILES[1]!]: WORKFLOW })
    expect(pinActionRefs(dir, 'evidence-layer', '0.8.0')).toEqual(ACTION_REF_FILES)
    expect(readFileSync(join(dir, ACTION_REF_FILES[0]!), 'utf8')).toBe(README.replace('@v0.7.0', '@v0.8.0'))
    expect(readFileSync(join(dir, ACTION_REF_FILES[1]!), 'utf8')).toBe(WORKFLOW.replace('@v0.7.0', '@v0.8.0'))
    // Again, it is already there: no file changes.
    expect(pinActionRefs(dir, 'evidence-layer', '0.8.0')).toEqual([])
  })

  it('in this repository, every ref names the version package.json has', () => {
    const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string }
    const refs = findActionRefs(root, name)
    // Each file shows at least one; the example's workflow uses the action in two jobs.
    expect([...new Set(refs.map((r) => r.file))]).toEqual(ACTION_REF_FILES)
    expect(refs.every((r) => r.version === version)).toBe(true)
  })
})
