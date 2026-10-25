/**
 * The example project's reference loop, run end to end on a standalone copy:
 * its evidence script gathers and seals, a review made of the suggested
 * claims passes `claims --seal`, and editing the code afterwards makes the
 * same review fail - by name, with the file that changed.
 *
 * The copy is made by the project's own `npm run standalone`, because inside
 * this checkout the project is not a repository: git, and so every hook and
 * seal, would answer for evidence-layer instead.
 *
 * This is what `examples/plain-node-project/README.md` tells a reader to do,
 * so a step the README describes that stopped working fails here first.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sh } from './helpers/git'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN = join(root, 'dist', 'bin', 'evidence-layer.mjs')

const EXAMPLE = join(root, 'examples', 'plain-node-project')
const standalone = (...args: string[]) =>
  spawnSync(process.execPath, [join(EXAMPLE, 'scripts', 'standalone.mjs'), ...args], { cwd: EXAMPLE, encoding: 'utf8' })

/**
 * The example as someone would have it - its own repository, evidence-layer
 * installed - made by the project's own `npm run standalone`, so the script
 * the README sends a reader to is the one these tests run on.
 */
function standaloneCopy(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'el-example-')), 'widget-counter')
  const res = standalone(dir)
  expect(res.status, res.stderr).toBe(0)
  sh(dir, 'config', 'user.email', 't@t')
  sh(dir, 'config', 'user.name', 't')
  return dir
}

const claims = (dir: string) => {
  const res = spawnSync(process.execPath, [BIN, 'claims', 'review.md', '--seal', '--format', 'json'], { cwd: dir, encoding: 'utf8' })
  return { status: res.status, findings: (JSON.parse(res.stdout) as { findings: { level: string; code: string; detail: string }[] }).findings }
}

describe('npm run standalone', () => {
  it('makes a repository of its own, with the checkout linked in and nothing of the template left over', () => {
    const dir = standaloneCopy()
    // Inside the checkout the answer is evidence-layer's top level, which is
    // why the copy exists: every hook and seal asks git this.
    expect(realpathSync(sh(EXAMPLE, 'rev-parse', '--show-toplevel'))).toBe(realpathSync(root))
    expect(realpathSync(sh(dir, 'rev-parse', '--show-toplevel'))).toBe(realpathSync(dir))
    expect(sh(dir, 'status', '--porcelain')).toBe('')
    expect(realpathSync(join(dir, 'node_modules', 'evidence-layer'))).toBe(realpathSync(root))
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string>; devDependencies: Record<string, string> }
    expect(pkg.devDependencies['evidence-layer']).toBe('file:' + root)
    expect(pkg.scripts.standalone).toBeUndefined()
    expect(existsSync(join(dir, 'scripts', 'standalone.mjs'))).toBe(false)
    expect(existsSync(join(dir, 'evidence.local.md'))).toBe(false)
  })

  it('refuses a directory that already has something in it, and copies nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'el-example-taken-'))
    writeFileSync(join(dir, 'keep.txt'), 'mine\n')
    const res = standalone(dir)
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('not empty')
    expect(readdirSync(dir)).toEqual(['keep.txt'])
  })
})

describe('examples/plain-node-project, end to end', () => {
  it('gathers with counts, passes a review of the suggested claims, and fails it once the code changes', () => {
    const dir = standaloneCopy()
    const gathered = spawnSync(process.execPath, ['scripts/evidence.mjs', '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    expect(gathered.status, gathered.stderr).toBe(0)
    expect(gathered.stdout).toContain('sealed as run')

    const bundle = readFileSync(join(dir, 'evidence.local.md'), 'utf8')
    expect(bundle).toContain('[SUMMARY tests: passed=3 failed=0 skipped=0 todo=0]')
    expect(bundle).toMatch(/## lint\n\n_Not run: /)

    // The review is the skeleton the bundle suggests, left as it is.
    const suggested = /## Suggested claims\n([\s\S]*?)(?:\n## |$)/.exec(bundle)![1]!
    expect(suggested).toMatch(/VERIFIED\[tests-[0-9a-f]{6}: exit=0, passed>=3, failed=0\]/)
    writeFileSync(join(dir, 'review.md'), suggested)

    const clean = claims(dir)
    expect(clean.status).toBe(0)
    expect(clean.findings.every((f) => f.level === 'pass')).toBe(true)
    expect(clean.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['claims/verified', 'seal/provenance', 'seal/fresh']))

    writeFileSync(join(dir, 'index.js'), readFileSync(join(dir, 'index.js'), 'utf8').replace('n + 1', 'n + 2'))
    const stale = claims(dir)
    expect(stale.status).toBe(1)
    expect(stale.findings.find((f) => f.code === 'seal/stale')?.detail).toContain('index.js')
  })

  it('fails the gather when the suite fails, with the bundle still written - so CI can gather instead of running npm test', () => {
    const dir = standaloneCopy()
    writeFileSync(join(dir, 'index.js'), readFileSync(join(dir, 'index.js'), 'utf8').replace('n + 1', 'n + 2'))
    const failing = spawnSync(process.execPath, ['scripts/evidence.mjs', '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    expect(failing.status).toBe(1)
    expect(failing.stderr).toContain('failed: test')
    expect(readFileSync(join(dir, 'evidence.local.md'), 'utf8')).toContain('[SUMMARY tests: passed=0 failed=3')
  })

  it('runs the hook commands its .claude and .codex files hold, the way each host runs them', () => {
    const dir = standaloneCopy()
    const command = (file: string) =>
      (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks
        .SessionStart!.at(-1)!.hooks[0]!.command
    const input = JSON.stringify({ session_id: 's', cwd: join(dir, 'test'), hook_event_name: 'SessionStart', source: 'startup' })

    // Claude Code: its own shell, with $CLAUDE_PROJECT_DIR.
    const claude = spawnSync('sh', ['-c', command('.claude/settings.json')], {
      cwd: join(dir, 'test'),
      input,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    })
    // Codex: `$SHELL -lc` in the session's directory, with no project variable.
    const codex = spawnSync('sh', ['-lc', command('.codex/hooks.json')], { cwd: join(dir, 'test'), input, encoding: 'utf8' })
    for (const res of [claude, codex]) {
      expect(res.status, res.stderr).toBe(0)
      expect(JSON.parse(res.stdout).hookSpecificOutput.additionalContext).toContain('**Claim**')
    }
  })
})
