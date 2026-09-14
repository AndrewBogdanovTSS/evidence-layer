/**
 * The default adapter - the only file in this package allowed to know it is
 * running on Node, and the one piece of the "zero lines of config" promise
 * that needs code rather than a plain default value.
 *
 * Everything under `../core` has no opinion about a project's test runner,
 * build tool, or file layout - it works on markdown text, git output, and
 * `package.json`. The moment a check needs to interpret *this project's*
 * output (a test reporter's summary line, a build folder's size), something
 * has to know the shape of that output, and that something belongs here, not
 * smuggled into core.
 *
 * What "zero-config" means precisely: the reachability, claims, receipt,
 * governance and ci-summary checks need no adapter at all - they operate on
 * text and git, which every project already has. Test-count parsing recognises
 * a handful of common reporter formats out of the box. Anything that asserts a
 * fact specific to one project - a route existing, a dependency being pinned,
 * a build budget - was never claimed to be zero-config, because it cannot be:
 * it is a fact about that project, not about Node.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tries a handful of common test-reporter summary formats and returns the
 * total test count, or `null` when none match. `null` is the honest answer,
 * not a guess - a caller should report `unverifiable`, never assume zero.
 */
export function parseTestCount(output: string): number | null {
  const vitest = /Tests\s+\d+ passed \((\d+)\)/.exec(output)
  if (vitest) return Number(vitest[1])

  const jest = /Tests:\s+\d+ passed,\s*(\d+) total/i.exec(output)
  if (jest) return Number(jest[1])

  const mocha = /(\d+)\s+passing/i.exec(output)
  if (mocha) return Number(mocha[1])

  // Node's built-in test runner: `ℹ tests N` (default "spec" reporter, current
  // versions) or `# tests N` (the TAP reporter, `--test-reporter=tap`). Found
  // by actually running `node --test` against the portability fixture rather
  // than assumed - the default reporter's format is not what a quick web
  // search from memory would suggest.
  const nodeTest = /[ℹ#]\s*tests\s+(\d+)/i.exec(output)
  if (nodeTest) return Number(nodeTest[1])

  return null
}

/** Total byte size of a directory tree. Generic; what the number means to a project's budget is that project's claim, not this function's. */
export function measureDirSize(path: string): number {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name)
    total += entry.isDirectory() ? measureDirSize(full) : statSync(full).size
  }
  return total
}
