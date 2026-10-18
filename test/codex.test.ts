/**
 * The Codex host: its adapter against inputs written from Codex's generated
 * schemas, the hook command speaking its protocol, and `init codex` writing a
 * `hooks.json` whose command really runs the way Codex runs it - through
 * `$SHELL -lc`, from wherever in the repository the session is.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { claudeCode } from '../src/hosts/claude-code'
import { codex, patchPaths } from '../src/hosts/codex'
import { CODEX_LAUNCHER, OWNED_COMMAND_RE, mergeCodexHooks } from '../src/commands/init'
import { hostFixture } from './helpers/fixtures'
import { tempRepo } from './helpers/git'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN = join(root, 'dist', 'bin', 'evidence-layer.mjs')
const fixture = (name: string, fill: Record<string, string>) => hostFixture('codex', name, fill)

const patch = (...lines: string[]) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

const hook = (event: string, stdin: string) => {
  const res = spawnSync(process.execPath, [BIN, 'hook', 'codex', event], { input: stdin, encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout.trim() }
}

describe('the codex adapter, against the published schemas', () => {
  it('reads every path an apply_patch touches - added, updated, deleted, and moved to', () => {
    expect(
      patchPaths(
        patch(
          '*** Add File: docs/new.md',
          '+hello',
          '*** Update File: src/a.ts',
          '*** Move to: src/b.ts',
          '@@',
          '-x',
          '+y',
          '*** Delete File: old.txt',
          '*** Update File: src/a.ts',
        ),
      ),
    ).toEqual(['docs/new.md', 'src/a.ts', 'src/b.ts', 'old.txt'])
  })

  it('turns each event into the gate\'s, and a shell command into nothing', () => {
    const cwd = '/repo'
    expect(codex.parse('session-start', fixture('session-start.json', { CWD: cwd }))).toEqual({
      kind: 'session-start',
      cwd,
      sessionId: '019a3f6c-2d1e-7a9b-8c8d-9e7f1a2b3c4d',
      source: 'startup',
    })
    expect(codex.parse('pre-tool-use', fixture('pre-tool-use-apply-patch.json', { CWD: cwd, PATCH: patch('*** Update File: a.js') }))).toMatchObject({
      kind: 'pre-write',
      paths: ['a.js'],
    })
    expect(codex.parse('pre-tool-use', fixture('pre-tool-use-bash.json', { CWD: cwd }))).toBeNull()
    expect(codex.parse('stop', fixture('stop.json', { CWD: cwd, MESSAGE: 'done' }))).toMatchObject({ kind: 'stop', reentry: false, message: 'done' })
  })

  it('reads a Stop whose last message is null - Codex sends that when a turn ends without one', () => {
    const stdin = JSON.stringify({ ...JSON.parse(fixture('stop.json', { CWD: '/repo', MESSAGE: '' })), last_assistant_message: null })
    expect(codex.parse('stop', stdin)).not.toHaveProperty('message')
  })

  it('renders through the same protocol code as Claude Code - one implementation, not a copy', () => {
    expect(codex.render).toBe(claudeCode.render)
  })

  it('throws on input it cannot read, rather than guessing', () => {
    expect(() => codex.parse('stop', 'not json')).toThrow()
    expect(() => codex.parse('stop', '{"cwd":"/repo"}')).toThrow(/session_id/)
  })
})

describe('evidence-layer hook codex, as a process', () => {
  it('denies an apply_patch into the ledger, wherever in the patch it is, and says nothing about an ordinary one', () => {
    const dir = tempRepo('el-codex-', { 'a.js': 'a\n' })
    const into = patch('*** Update File: a.js', '@@', '-a', '+b', '*** Add File: .git/evidence-layer/current.json', '+{}')
    const denied = hook('pre-tool-use', fixture('pre-tool-use-apply-patch.json', { CWD: dir, PATCH: into }))
    expect(denied.status).toBe(0)
    expect(JSON.parse(denied.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(hook('pre-tool-use', fixture('pre-tool-use-apply-patch.json', { CWD: dir, PATCH: patch('*** Update File: a.js') })).stdout).toBe('')
  })

  it('never exits non-zero - not on garbage input, an unknown event, or an empty stdin', () => {
    for (const [event, stdin] of [['stop', 'not json'], ['pre-tool-use', '[]'], ['nope', '{}'], ['session-start', '']]) {
      expect(hook(event!, stdin!).status, event + ' ' + stdin).toBe(0)
    }
  })

  it('blocks a stop over an unbacked review with Codex\'s block shape, and exits 0', () => {
    const dir = tempRepo('el-codex-', { 'a.js': 'a\n' })
    hook('session-start', fixture('session-start.json', { CWD: dir }))
    writeFileSync(join(dir, 'review.md'), '**Claim**: the suite passes.\n')
    const res = hook('stop', fixture('stop.json', { CWD: dir, MESSAGE: 'done' }))
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ decision: 'block', reason: expect.stringContaining('no grounding tag') })
  })
})

describe('evidence-layer init codex', () => {
  it('keeps every hook that is not its own, and is one entry per event however often it runs', () => {
    const theirs = { type: 'command', command: 'my-policy.sh' }
    const once = mergeCodexHooks({ hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [theirs] }] } }, [])
    const twice = mergeCodexHooks(once, ['--strict'])
    expect(twice.hooks!.PreToolUse![0]).toEqual({ matcher: '^Bash$', hooks: [theirs] })
    for (const groups of Object.values(twice.hooks!)) {
      const ours = groups.flatMap((g) => g.hooks).filter((h) => OWNED_COMMAND_RE.test(h.command))
      expect(ours).toHaveLength(1)
      expect(OWNED_COMMAND_RE.test(ours[0]!.commandWindows as string)).toBe(true)
    }
    expect(twice.hooks!.PreToolUse![1]!.matcher).toBe('apply_patch|Edit|Write')
  })

  it('writes .codex/hooks.json, and refuses --local, which Codex has no file for', () => {
    const dir = tempRepo('el-codex-init-', { 'a.js': 'a\n' })
    const run = (...args: string[]) => spawnSync(process.execPath, [BIN, 'init', 'codex', '--repo', dir, ...args], { encoding: 'utf8' })
    expect(run('--local').status).toBe(2)
    expect(existsSync(join(dir, '.codex'))).toBe(false)
    const res = run()
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('/hooks')
    expect(JSON.parse(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8')).hooks.Stop).toHaveLength(1)
  })

  it('writes a command that runs as Codex runs it - `sh -lc`, from a subdirectory of the project', () => {
    const dir = tempRepo('el-codex-sh-', { 'src/a.js': 'a\n' })
    mkdirSync(join(dir, 'node_modules'))
    symlinkSync(root, join(dir, 'node_modules', 'evidence-layer'))
    const command = CODEX_LAUNCHER.command + ' session-start'
    const res = spawnSync('sh', ['-lc', command], {
      cwd: join(dir, 'src'),
      input: fixture('session-start.json', { CWD: join(dir, 'src') }),
      encoding: 'utf8',
    })
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout).hookSpecificOutput.additionalContext).toContain('**Claim**')
  })
})
