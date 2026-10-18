/**
 * A review is input from the party this package does not take on trust, so
 * nothing in it may reach a shell.
 *
 * Up to 0.4.0 `receipt` concatenated the receipt's target branch and every
 * Sample integrity path into a shell string. A review carrying `$(...)` in
 * either place ran that command on the machine checking it - in CI, a pull
 * request from a fork. These tests write such a review and check that the
 * marker files its payloads would create never appear.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkReceipt, parseReceipt } from '../src/core/receipt'
import { git, gitCapture } from '../src/core/proc'

function repo(files: Record<string, string>): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'el-inject-'))
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  g('init', '-q')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content)
  g('add', '-A')
  g('commit', '-qm', 'init')
  return { dir, head: g('rev-parse', 'HEAD') }
}

describe('receipt never hands review text to a shell', () => {
  it('runs nothing smuggled into the target branch or a Sample integrity path', () => {
    const { dir, head } = repo({ 'a.js': 'a\n' })
    const marker = join(dir, 'pwned')
    const review = [
      '**HEAD SHA**: ' + head,
      '**Base SHA**: ' + head,
      '**Target branch**: main$(touch ' + marker + '-branch)',
      '',
      '**Sample integrity**:',
      '',
      '| File | First non-blank line |',
      '|---|---|',
      '| `a.js;touch${IFS}' + marker + '-path` | `a` |',
      '| `$(touch ' + marker + '-subst)` | `a` |',
    ].join('\n')

    checkReceipt(parseReceipt(review), review, dir)

    for (const suffix of ['-branch', '-path', '-subst']) {
      expect(existsSync(marker + suffix), 'payload in ' + suffix.slice(1) + ' ran').toBe(false)
    }
  })

  it('still reads a cited file whose name a shell would have mangled', () => {
    const name = 'odd name; $x `y` (z) ünï.md'
    const { dir, head } = repo({ [name]: 'first line\n' })
    expect(gitCapture(['show', head + ':' + name], dir)).toBe('first line')
  })

  it("quotes a file whose first line starts with '> ' as itself - git output is not echo-stripped", () => {
    const { dir, head } = repo({ 'NOTE.md': '> a quoted first line\n' })
    const review = [
      '**HEAD SHA**: ' + head,
      '',
      '**Sample integrity**:',
      '',
      '| File | First non-blank line |',
      '|---|---|',
      '| `NOTE.md` | `> a quoted first line` |',
    ].join('\n')
    const sample = checkReceipt(parseReceipt(review), review, dir).find((f) => f.claim.includes('NOTE.md'))
    expect(sample?.level).toBe('pass')
  })

  it('reports a git that failed as a failure, with stderr kept out of stdout', () => {
    const { dir } = repo({ 'a.js': 'a\n' })
    const res = git(['show', 'no-such-revision:a.js'], dir)
    expect(res.exitCode).not.toBe(0)
    expect(res.stdout).toBe('')
    expect(res.stderr).not.toBe('')
  })
})
