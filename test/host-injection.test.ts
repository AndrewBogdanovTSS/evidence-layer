/**
 * A host's hook input is written, in the parts that matter, by the agent - a
 * file path, a patch, its final message, the review it wrote - and an agent
 * can be steered by anything it read. So nothing in that input may reach a
 * shell, on any event, for either host: the gate calls git with an argument
 * array (`git()` in `src/core/proc.ts`), and these tests feed every field a
 * payload whose marker file appears if a shell ever sees it.
 *
 * The working directory itself is hostile too: a directory may be named
 * `$(touch ...)` on any POSIX filesystem, and the repository here is.
 *
 * And `init` writes a command line the host will hand to its shell, so a
 * value it puts on that line must not be able to run anything either.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hostFixture } from './helpers/fixtures'
import { sh } from './helpers/git'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN = join(root, 'dist', 'bin', 'evidence-layer.mjs')

/** Every way a shell could be talked into running `touch <marker>`. */
const payloads = (marker: string) => [
  '$(touch ' + marker + '-subst)',
  '`touch ' + marker + '-backtick`',
  'x; touch ' + marker + '-semicolon',
  'x | touch ' + marker + '-pipe',
  'x && touch ' + marker + '-and',
  'x\ntouch ' + marker + '-newline',
]

/** A repository in a directory a shell would expand, and a place for markers outside it. */
function hostileRepo(): { dir: string; markers: string } {
  const base = mkdtempSync(join(tmpdir(), 'el-host-inject-'))
  const markers = join(base, 'markers')
  mkdirSync(markers)
  // `touch pwned` would land in whichever directory the shell ran in; the
  // test looks for it in this one and in the repository.
  const dir = join(base, 'repo $(touch pwned) `touch pwned`')
  mkdirSync(dir)
  writeFileSync(join(dir, 'a.js'), 'a\n')
  sh(dir, 'init', '-q')
  sh(dir, 'config', 'user.email', 't@t')
  sh(dir, 'config', 'user.name', 't')
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-qm', 'init')
  return { dir, markers }
}

const hook = (host: string, event: string, stdin: string) =>
  spawnSync(process.execPath, [BIN, 'hook', host, event], { input: stdin, encoding: 'utf8' })

const nothingRan = (dir: string, markers: string) => {
  expect(readdirSync(markers)).toEqual([])
  expect(existsSync(join(dir, 'pwned'))).toBe(false)
  expect(existsSync(join(dir, '..', 'pwned'))).toBe(false)
  expect(existsSync(join(process.cwd(), 'pwned'))).toBe(false)
}

describe('host input never reaches a shell', () => {
  for (const host of ['claude', 'codex'] as const) {
    it(host + ': runs nothing smuggled into the session id, a written path, a patch, the review or the final message', () => {
      const { dir, markers } = hostileRepo()
      const m = join(markers, 'pwned')
      const fixtures = host === 'claude' ? 'claude-code' : 'codex'
      const withHostile = (name: string, fill: Record<string, string>, patch: (data: Record<string, unknown>, p: string) => void) => {
        for (const p of payloads(m)) {
          const data = JSON.parse(hostFixture(fixtures, name, fill)) as Record<string, unknown>
          data.session_id = p
          data.transcript_path = p
          patch(data, p)
          const res = hook(host, name.replace(/\.json$|-write|-apply-patch|-bash/g, ''), JSON.stringify(data))
          expect(res.status, name + ' ' + p).toBe(0)
        }
      }

      withHostile('session-start.json', { CWD: dir }, (data, p) => {
        data.source = p
      })

      // A review whose every claim, tag and receipt field carries a payload.
      const review = payloads(m)
        .map((p) => '**Claim**: ' + p + '\n**Grounding**: VERIFIED[tests-0a1b2c: exit=0]\n')
        .concat(['**HEAD SHA**: ' + '0'.repeat(40), '**Target branch**: ' + payloads(m)[0], '**Sample integrity**: `' + payloads(m)[2] + '` -> `x`'])
        .join('\n')
      writeFileSync(join(dir, 'review.md'), review)

      if (host === 'claude') {
        withHostile('pre-tool-use-write.json', { CWD: dir, PATH: join(dir, 'a.js') }, (data, p) => {
          data.tool_input = { file_path: p, content: p }
        })
      } else {
        withHostile('pre-tool-use-apply-patch.json', { CWD: dir, PATCH: '' }, (data, p) => {
          data.tool_input = { command: ['*** Begin Patch', '*** Update File: ' + p, '*** Move to: ' + p, '*** End Patch'].join('\n') }
        })
      }

      withHostile('stop.json', { CWD: dir, MESSAGE: '' }, (data, p) => {
        data.last_assistant_message = '**Claim**: ' + p + '\n**Grounding**: VERIFIED[tests-0a1b2c: exit=0]'
      })

      nothingRan(dir, markers)
    })
  }

  it('reads a hostile path as a path - the ledger is still refused under a directory a shell would expand', () => {
    const { dir } = hostileRepo()
    const into = join(dir, '.git', 'evidence-layer', 'current.json')
    const claude = hook('claude', 'pre-tool-use', hostFixture('claude-code', 'pre-tool-use-write.json', { CWD: dir, PATH: into }))
    expect(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
    const patch = '*** Begin Patch\n*** Update File: a.js\n*** Move to: .git/evidence-layer/current.json\n*** End Patch'
    const codex = hook('codex', 'pre-tool-use', hostFixture('codex', 'pre-tool-use-apply-patch.json', { CWD: dir, PATCH: patch }))
    expect(JSON.parse(codex.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  })
})

describe('init writes no command a shell could be turned against', () => {
  it('refuses a --review value the host\'s shell would expand, for both hosts, and writes nothing', () => {
    for (const host of ['claude', 'codex']) {
      const { dir, markers } = hostileRepo()
      for (const p of payloads(join(markers, 'pwned'))) {
        const res = spawnSync(process.execPath, [BIN, 'init', host, '--repo', dir, '--review', p], { encoding: 'utf8' })
        expect(res.status, host + ' ' + p).toBe(2)
      }
      expect(existsSync(join(dir, host === 'claude' ? '.claude' : '.codex'))).toBe(false)
      nothingRan(dir, markers)
    }
  })

  it('still writes ordinary review paths, and the written command runs them as paths', () => {
    const { dir } = hostileRepo()
    const res = spawnSync(process.execPath, [BIN, 'init', 'claude', '--repo', dir, '--review', 'docs/review.md,review-2.md'], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    const settings = readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')
    expect(settings).toContain('--review')
    expect(settings).toContain('docs/review.md,review-2.md')
  })
})
