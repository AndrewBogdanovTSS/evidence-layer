// How many git processes one stop costs. Its own file, because the module
// mock below wraps the real `spawnSync` for every test in the file.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ git: [] as string[][] }))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawnSync: vi.fn((command: string, args: string[], opts: object) => {
      if (command === 'git') calls.git.push(args)
      return real.spawnSync(command, args, opts)
    }),
  }
})

const { artifactId, formatArtifact } = await import('../src/core/artifact')
const { decide } = await import('../src/core/gate')
const { publishRun, sourceFingerprint } = await import('../src/core/seal')
const { sh } = await import('./helpers/git')

describe('one stop', () => {
  it('fingerprints the tree once, and finds the repository and its state once, however many texts it checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'el-cost-'))
    sh(dir, 'init', '-q')
    sh(dir, 'config', 'user.email', 't@t')
    sh(dir, 'config', 'user.name', 't')
    writeFileSync(join(dir, 'a.js'), 'a\n')
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-qm', 'init')
    decide({ kind: 'session-start', cwd: dir, sessionId: 's', source: 'startup' })

    const head = sh(dir, 'rev-parse', 'HEAD')
    const output = 'ok\n[SUMMARY tests: passed=3 failed=0 skipped=0 todo=0]'
    const id = artifactId('pnpm test', head, output)
    const block = formatArtifact('pnpm test', output, 0, { id, commit: head })
    const fp = sourceFingerprint(dir, ['review.md', 'evidence.local.md'])
    if ('unverifiable' in fp) throw new Error(fp.unverifiable)
    publishRun(dir, {
      headSha: head,
      source: fp.fingerprint,
      excluded: ['evidence.local.md', 'review.md'],
      bundle: '# Evidence bundle\n\n' + block + '\n',
      artifacts: [{ id, command: 'pnpm test', exitCode: 0, output }],
    })
    const claim = '**Claim**: the suite ran 3 passing tests.\n**Grounding**: VERIFIED[' + id + ': passed>=3]\n'
    writeFileSync(join(dir, 'review.md'), '# Review\n\n' + claim + '\n' + block + '\n')

    calls.git = []
    const decision = decide({ kind: 'stop', cwd: dir, sessionId: 's', reentry: false, message: claim })
    expect(decision).toMatchObject({ action: 'allow', level: 'pass' })
    const count = (...prefix: string[]) => calls.git.filter((a) => prefix.every((p, i) => a[i] === p)).length
    expect(count('write-tree')).toBe(1)
    expect(count('rev-parse', '--show-toplevel')).toBe(1)
    expect(count('rev-parse', '--git-path', 'evidence-layer')).toBe(1)
  }, 30_000)
})
