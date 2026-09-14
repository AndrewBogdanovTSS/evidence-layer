/**
 * The published executable, exercised the way a consumer gets it: the built
 * bundle in `dist/`, spawned as a process, judged by its exit code.
 *
 * Everything else in this suite imports TypeScript source. That proves the
 * logic works; it does not prove the thing npm installs works, and the gap
 * between those two is exactly where a broken `exports` map, a missing
 * shebang, or a `--version` that drifted from `package.json` survives a green
 * test run. `pnpm test` builds first so this file can never be checking a
 * stale bundle.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string
  bin: Record<string, string>
}
const BIN = join(root, pkg.bin['evidence-layer']!)

function cli(args: string[], cwd = root): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(
      'no built CLI at ' + BIN + ' - run `pnpm build` first (`pnpm test` does it for you)',
    )
  }
})

describe('the executable package.json points at', () => {
  it('exists where `bin` says it does, and starts with a shebang', () => {
    expect(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('prints a version that agrees with package.json, not one written down twice', () => {
    expect(cli(['--version']).stdout.trim()).toBe(pkg.version)
  })

  it('exits 0 when help was asked for, and 2 when no command was given', () => {
    expect(cli(['--help']).status).toBe(0)
    expect(cli([]).status).toBe(2)
  })

  it('exits 2 on an unknown command rather than silently doing nothing', () => {
    const unknown = cli(['definitely-not-a-command'])
    expect(unknown.status).toBe(2)
    expect(unknown.stderr).toContain('unknown command')
  })

  it('routes --help to the subcommand, and exits 0 there too', () => {
    const claims = cli(['claims', '--help'])
    expect(claims.status).toBe(0)
    expect(claims.stdout).toContain('evidence-layer claims <review.md>')

    const tag = cli(['journal', 'tag', '--help'])
    expect(tag.status).toBe(0)
    expect(tag.stdout).toContain('evidence-layer journal tag')
  })

  it('rejects a journal subcommand it does not have', () => {
    expect(cli(['journal', 'sing']).status).toBe(2)
  })
})

describe('the checks themselves, reached through the executable', () => {
  const backed = [
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

  const unbacked = ['**Claim**: increment(1) returns 2.', '**Grounding**: VERIFIED'].join('\n')

  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'evidence-layer-bin-'))
    writeFileSync(join(dir, 'backed.md'), backed)
    writeFileSync(join(dir, 'unbacked.md'), unbacked)
  })

  it('exits 0 on a review whose claim is backed', () => {
    expect(cli(['claims', join(dir, 'backed.md')]).status).toBe(0)
  })

  it('exits 1 on a review whose claim is not', () => {
    expect(cli(['claims', join(dir, 'unbacked.md')]).status).toBe(1)
  })

  it('exits 2 when the review file does not exist - never 0', () => {
    expect(cli(['claims', join(dir, 'nothing-here.md')]).status).toBe(2)
  })

  it('still answers to the colon-separated names this package shipped with', () => {
    expect(cli(['check:claims', join(dir, 'backed.md')]).status).toBe(0)
  })

  it('runs governance against a repository it has never seen', () => {
    const fixture = join(root, 'examples', 'plain-node-project')
    const result = cli([
      'governance',
      '--repo',
      fixture,
      '--decisions',
      join(fixture, 'docs', 'decisions'),
      '--no-json',
    ])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('is reachable from a wired trigger')
  })

  it('reports an empty journal as empty rather than as a pass', () => {
    const report = cli(['journal', 'report', '--repo', dir])
    expect(report.status).toBe(0)
    expect(report.stdout).toContain('empty')
  })
})

describe('the package as npm would hand it over', () => {
  it('packs only what `files` promises - no src, no tests, no examples', () => {
    // One command string with `shell: true`, rather than an args array: on
    // Windows `npm` is a `.cmd` shim, which Node refuses to execFile directly,
    // and passing args alongside `shell` is deprecated. Nothing here comes
    // from user input.
    const listing = spawnSync('npm pack --dry-run --json', {
      cwd: root,
      encoding: 'utf8',
      shell: true,
    })
    const [tarball] = JSON.parse(listing.stdout) as [{ files: { path: string }[] }]
    const paths = tarball.files.map((f) => f.path)

    expect(paths).toContain('package.json')
    expect(paths).toContain('README.md')
    expect(paths).toContain('LICENSE')
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(true)
    expect(paths.some((p) => p.startsWith('src/'))).toBe(false)
    expect(paths.some((p) => p.startsWith('test/'))).toBe(false)
    expect(paths.some((p) => p.startsWith('examples/'))).toBe(false)
  })
})
