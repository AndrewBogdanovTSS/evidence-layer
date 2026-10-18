/**
 * Throwaway git repositories for tests that need a real checkout.
 *
 * One copy, imported, because the ladder's clone check holds tests to the same
 * rule as source: a test file that grows its own renamed `sh` is a second
 * implementation that can drift from the first.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Runs git in `dir` with an argument array - no shell - and returns its trimmed stdout. */
export function sh(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

/** A new repository holding `files`, committed once, by an identity set locally so no global config is read. */
export function tempRepo(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  sh(dir, 'init', '-q')
  sh(dir, 'config', 'user.email', 't@t')
  sh(dir, 'config', 'user.name', 't')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-qm', 'init')
  return dir
}
