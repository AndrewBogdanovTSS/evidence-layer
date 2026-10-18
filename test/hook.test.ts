/**
 * The runtime gate as a host runs it: the built executable, hook input on
 * stdin, the decision on stdout - and an exit code that is always 0, because
 * Claude Code reads a non-zero exit as a decision of its own.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { claudeCode } from '../src/hosts/claude-code'
import { OWNED_COMMAND_RE, SELF_LAUNCHER, isOwnRepository, mergeClaudeSettings } from '../src/commands/init'
import { hostFixture } from './helpers/fixtures'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN = join(root, 'dist', 'bin', 'evidence-layer.mjs')
const LAUNCHER = join(root, 'plugins', 'evidence-layer', 'scripts', 'run-hook.mjs')
const fixture = (name: string, fill: Record<string, string>) => hostFixture('claude-code', name, fill)

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'el-hook-'))
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  g('init', '-q')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.js'), 'a\n')
  g('add', '-A')
  g('commit', '-qm', 'init')
  return dir
}

function hook(event: string, stdin: string, extra: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BIN, 'hook', 'claude', event, ...extra], { input: stdin, encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr }
}

describe('the claude-code adapter, against the documented input', () => {
  it('reads each event the gate handles, and nothing it does not', () => {
    const cwd = '/work'
    expect(claudeCode.parse('session-start', fixture('session-start.json', { CWD: cwd }))).toMatchObject({
      kind: 'session-start',
      cwd,
      source: 'startup',
    })
    expect(claudeCode.parse('pre-tool-use', fixture('pre-tool-use-write.json', { CWD: cwd, PATH: '/work/x.js' }))).toMatchObject({
      kind: 'pre-write',
      paths: ['/work/x.js'],
    })
    expect(claudeCode.parse('pre-tool-use', fixture('pre-tool-use-bash.json', { CWD: cwd }))).toBeNull()
    expect(claudeCode.parse('stop', fixture('stop.json', { CWD: cwd, MESSAGE: 'done' }))).toMatchObject({
      kind: 'stop',
      reentry: false,
      message: 'done',
    })
  })

  it('throws on input it cannot read, rather than guessing', () => {
    expect(() => claudeCode.parse('stop', 'not json')).toThrow('not JSON')
    expect(() => claudeCode.parse('stop', '{"cwd":"/x"}')).toThrow('session_id')
  })

  it('renders each decision in the documented output shape, and nothing for a plain allow', () => {
    const base = { outcome: 'checked' as const, level: null, findings: [] }
    expect(JSON.parse(claudeCode.render({ ...base, action: 'context', text: 'hi' }, 'session-start'))).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' },
    })
    expect(JSON.parse(claudeCode.render({ ...base, action: 'deny', reason: 'no' }, 'pre-write'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
    })
    expect(JSON.parse(claudeCode.render({ ...base, action: 'block', reason: 'fix' }, 'stop'))).toEqual({
      decision: 'block',
      reason: 'fix',
    })
    expect(claudeCode.render({ ...base, action: 'allow' }, 'stop')).toBe('')
    expect(JSON.parse(claudeCode.render({ ...base, action: 'allow', message: 'note' }, 'stop'))).toEqual({ systemMessage: 'note' })
  })
})

describe('evidence-layer hook, as a process', () => {
  it('blocks an unbacked review at stop, through stdout, with exit 0', () => {
    const dir = repo()
    expect(hook('session-start', fixture('session-start.json', { CWD: dir })).status).toBe(0)
    writeFileSync(join(dir, 'review.md'), '**Claim**: the suite passes.\n')
    const res = hook('stop', fixture('stop.json', { CWD: dir, MESSAGE: 'done' }))
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout).decision).toBe('block')
  })

  it('never exits non-zero - not on garbage input, an unknown event, or a crash', () => {
    for (const [event, stdin] of [
      ['stop', 'not json'],
      ['stop', ''],
      ['session-start', '{"cwd":"/nonexistent"}'],
      ['no-such-event', '{}'],
    ] as const) {
      const res = hook(event, stdin)
      expect(res.status, event + ' ' + stdin).toBe(0)
    }
    expect(JSON.parse(hook('stop', 'not json').stdout).systemMessage).toContain('could not run')
  })

  it('under --fail-closed, blocks a stop it could not check instead of allowing it', () => {
    const res = hook('stop', 'not json', ['--fail-closed'])
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout).decision).toBe('block')
  })

  it('denies a Write into the ledger and says nothing about an ordinary one', () => {
    const dir = repo()
    const denied = hook('pre-tool-use', fixture('pre-tool-use-write.json', { CWD: dir, PATH: join(dir, '.git/evidence-layer/x.json') }))
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    expect(hook('pre-tool-use', fixture('pre-tool-use-write.json', { CWD: dir, PATH: join(dir, 'a.js') })).stdout).toBe('')
  })
})

describe('evidence-layer init claude', () => {
  it('adds one entry per event and keeps every hook that is not its own', () => {
    const theirs = { type: 'command', command: 'prettier --write' }
    const merged = mergeClaudeSettings(
      { model: 'x', hooks: { PreToolUse: [{ matcher: 'Write', hooks: [theirs] }] } },
      [],
    )
    expect(merged.model).toBe('x')
    expect(merged.hooks!.PreToolUse![0]).toEqual({ matcher: 'Write', hooks: [theirs] })
    expect(Object.keys(merged.hooks!)).toEqual(['PreToolUse', 'SessionStart', 'Stop'])
    for (const groups of Object.values(merged.hooks!)) {
      expect(groups.flatMap((g) => g.hooks).filter((h) => OWNED_COMMAND_RE.test(h.command))).toHaveLength(1)
    }
  })

  it('replaces its own entries in place - twice, or with new flags, is still one entry each', () => {
    const once = mergeClaudeSettings({}, [])
    const twice = mergeClaudeSettings(once, [])
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    const strict = mergeClaudeSettings(twice, ['--strict'])
    expect(strict.hooks!.Stop).toHaveLength(1)
    expect(strict.hooks!.Stop![0]!.hooks[0]!.command).toMatch(/hook claude stop --strict$/)
  })

  it('does not claim a hook that merely mentions evidence-layer', () => {
    expect(OWNED_COMMAND_RE.test('echo evidence-layer is great')).toBe(false)
    expect(OWNED_COMMAND_RE.test('npx evidence-layer claims review.md')).toBe(false)
    expect(OWNED_COMMAND_RE.test('node "$CLAUDE_PROJECT_DIR/other/scripts/run-hook.mjs" stop')).toBe(false)
  })

  it('in its own repository wires the plugin launcher, and replaces the installed-package entries with it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'el-init-self-'))
    writeFileSync(join(dir, 'package.json'), '{"name":"evidence-layer"}')
    mkdirSync(join(dir, 'plugins', 'evidence-layer', 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'plugins', 'evidence-layer', 'scripts', 'run-hook.mjs'), '')
    expect(isOwnRepository(dir)).toBe(true)
    expect(isOwnRepository(mkdtempSync(join(tmpdir(), 'el-init-')))).toBe(false)

    writeFileSync(join(dir, 'package.json'), '{"name":"someone-else"}')
    spawnSync(process.execPath, [BIN, 'init', 'claude', '--repo', dir], { encoding: 'utf8' })
    writeFileSync(join(dir, 'package.json'), '{"name":"evidence-layer"}')
    spawnSync(process.execPath, [BIN, 'init', 'claude', '--repo', dir], { encoding: 'utf8' })
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'))
    for (const groups of Object.values(settings.hooks) as { hooks: { command: string }[] }[][]) {
      const commands = groups.flatMap((g) => g.hooks.map((h) => h.command))
      expect(commands).toHaveLength(1)
      expect(commands[0]!.startsWith(SELF_LAUNCHER + ' ')).toBe(true)
      expect(OWNED_COMMAND_RE.test(commands[0]!)).toBe(true)
    }
  })

  it('writes the same bytes when run again, writes nothing on --dry-run, and honours --local', () => {
    const dir = mkdtempSync(join(tmpdir(), 'el-init-'))
    const run = (...args: string[]) => spawnSync(process.execPath, [BIN, 'init', 'claude', '--repo', dir, ...args], { encoding: 'utf8' })
    expect(run('--dry-run').status).toBe(0)
    expect(existsSync(join(dir, '.claude'))).toBe(false)
    run()
    const first = readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')
    run()
    expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).toBe(first)
    run('--local')
    expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(true)
  })
})

describe('the plugin launcher', () => {
  function project(withPackage: 'none' | 'this' | 'old' | 'self' | 'self-unbuilt'): string {
    const dir = repo()
    if (withPackage === 'self' || withPackage === 'self-unbuilt') {
      // A checkout of this package: its own package.json, and dist/ only once built.
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: manifest.name, bin: manifest.bin, evidenceLayer: manifest.evidenceLayer }))
      if (withPackage === 'self') symlinkSync(join(root, 'dist'), join(dir, 'dist'))
    }
    if (withPackage === 'this') {
      mkdirSync(join(dir, 'node_modules'))
      symlinkSync(root, join(dir, 'node_modules', 'evidence-layer'))
    }
    if (withPackage === 'old') {
      mkdirSync(join(dir, 'node_modules', 'evidence-layer'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'evidence-layer', 'package.json'), '{"name":"evidence-layer","version":"0.4.0"}')
    }
    return dir
  }
  const launch = (dir: string, event: string, stdin: string, extra: string[] = []) =>
    spawnSync(process.execPath, [LAUNCHER, event, ...extra], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    })

  it('says the gate is inactive when the package is missing or too old, and blocks nothing', () => {
    for (const kind of ['none', 'old'] as const) {
      const dir = project(kind)
      const started = launch(dir, 'session-start', fixture('session-start.json', { CWD: dir }))
      expect(started.status).toBe(0)
      expect(JSON.parse(started.stdout).hookSpecificOutput.additionalContext).toContain('inactive')
      expect(launch(dir, 'stop', fixture('stop.json', { CWD: dir, MESSAGE: 'x' })).stdout).toBe('')
    }
  })

  it('under --fail-closed, blocks a stop when the package is missing', () => {
    const dir = project('none')
    const res = launch(dir, 'stop', fixture('stop.json', { CWD: dir, MESSAGE: 'x' }), ['--fail-closed'])
    expect(JSON.parse(res.stdout).decision).toBe('block')
  })

  it('hands the hook to the installed package, in the same process', () => {
    const dir = project('this')
    const started = launch(dir, 'session-start', fixture('session-start.json', { CWD: dir }))
    expect(JSON.parse(started.stdout).hookSpecificOutput.additionalContext).toContain('**Claim**')
    writeFileSync(join(dir, 'review.md'), '**Claim**: the suite passes.\n')
    expect(JSON.parse(launch(dir, 'stop', fixture('stop.json', { CWD: dir, MESSAGE: 'x' })).stdout).decision).toBe('block')
  })

  it('in a checkout of this package, runs its build - and says the gate is inactive until there is one', () => {
    const built = project('self')
    expect(JSON.parse(launch(built, 'session-start', fixture('session-start.json', { CWD: built })).stdout).hookSpecificOutput.additionalContext).toContain('**Claim**')

    const unbuilt = project('self-unbuilt')
    const started = launch(unbuilt, 'session-start', fixture('session-start.json', { CWD: unbuilt }))
    expect(started.status).toBe(0)
    expect(JSON.parse(started.stdout).hookSpecificOutput.additionalContext).toMatch(/inactive.*pnpm build/)
    expect(launch(unbuilt, 'stop', fixture('stop.json', { CWD: unbuilt, MESSAGE: 'x' })).stdout).toBe('')
  })
})
