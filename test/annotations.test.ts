/**
 * `--format github`: annotations escaped the way the runner reads them, the
 * review's own text printed only while workflow commands are stopped, and a
 * job summary - with the text mode's exit code.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { annotations, escapeData, escapeProperty, renderFindingsSummary } from '../src/core/annotations'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN = join(root, 'dist', 'bin', 'evidence-layer.mjs')

describe('annotations', () => {
  it('escapes a message so it cannot start a second command, and a property so it cannot end its own', () => {
    expect(escapeData('50%\r\n::add-mask::x')).toBe('50%25%0D%0A::add-mask::x')
    expect(escapeProperty('a,b:c')).toBe('a%2Cb%3Ac')
  })

  it('annotates every finding that is not a pass, titled by its code', () => {
    const lines = annotations([
      { level: 'pass', claim: 'fine', detail: '', code: 'claims/verified' },
      { level: 'error', claim: 'the suite passes', detail: 'carries no grounding tag', file: 'r.md', line: 3, code: 'claims/untagged' },
      { level: 'unverifiable', claim: 'fresh', detail: 'sparse checkout', code: 'seal/unhashable' },
      { level: 'warning', claim: 'no code here', detail: 'd' },
    ])
    expect(lines).toEqual([
      '::error file=r.md,line=3,title=claims/untagged::the suite passes - carries no grounding tag',
      '::warning title=unverifiable%3A seal/unhashable::fresh - sparse checkout',
      '::warning title=no code here::no code here - d',
    ])
  })

  it('summarises only what is not a pass, with table cells that cannot break the table', () => {
    const md = renderFindingsSummary('Claims in r.md', [
      { level: 'pass', claim: 'ok', detail: '', code: 'claims/verified' },
      { level: 'error', claim: 'a | b', detail: 'line one\nline two', code: 'claims/untagged' },
    ])
    expect(md).toContain('## ❌ Claims in r.md: 1 failing')
    expect(md).toContain('| ❌ | `claims/untagged` | a \\| b | line one · line two |')
    expect(md).not.toContain('claims/verified')
  })
})

describe('--format github', () => {
  function review(text: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'el-gh-'))
    writeFileSync(join(dir, 'review.md'), text)
    return dir
  }

  it('prints the review text only while workflow commands are stopped, with a token chosen per run', () => {
    const dir = review('**Claim**: ::add-mask::secret is printed, not obeyed\n')
    const summary = join(dir, 'summary.md')
    const run = () =>
      spawnSync(process.execPath, [BIN, 'claims', 'review.md', '--format', 'github'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
      })
    const first = run()
    const lines = first.stdout.split('\n')
    const stop = lines.findIndex((l) => l.startsWith('::stop-commands::'))
    const token = lines[stop]!.slice('::stop-commands::'.length)
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    const resume = lines.indexOf('::' + token + '::')
    expect(resume).toBeGreaterThan(stop)

    // Before the pause: annotations only. During it: the human report, review text and all.
    expect(lines.slice(0, stop).every((l) => /^::(error|warning) /.test(l))).toBe(true)
    expect(lines.slice(stop + 1, resume).join('\n')).toContain('::add-mask::secret')
    expect(lines.slice(resume + 1).every((l) => l.trim() === '')).toBe(true)

    expect(readFileSync(summary, 'utf8')).toContain('`claims/untagged`')
    expect(run().stdout).not.toContain(token)
    expect(first.status).toBe(spawnSync(process.execPath, [BIN, 'claims', 'review.md'], { cwd: dir }).status)
  })
})
