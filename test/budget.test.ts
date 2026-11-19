/**
 * A test's own time budget goes through `budget()`, so it cannot undercut
 * the platform's default (see `helpers/budget.ts`).
 *
 * Nothing else would notice a new bare `30_000`: CI runs Linux, where the
 * number written is the budget, and only a Windows run finds it too tight -
 * which is how nine of them became sixteen before anyone looked.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { budget } from './helpers/budget'

const here = fileURLToPath(new URL('.', import.meta.url))

// A literal budget closing a test - `}, 30_000)` - or a suite option -
// `{ timeout: 20_000 }`. Literals elsewhere (a clock advanced by fake timers,
// a file's mtime) are values under test, not budgets, and a comment is not code.
const BARE = /^\s*\}, [\d_]+\)\s*$|^(?!\s*\/\/).*\btimeout: [\d_]+\b/

describe('a time budget', () => {
  it('is the number written on Linux, and never below the default anywhere', () => {
    if (process.platform === 'win32') {
      expect(budget(30_000)).toBeGreaterThanOrEqual(60_000)
      expect(budget(60_000)).toBeGreaterThan(60_000)
    } else {
      expect(budget(30_000)).toBe(30_000)
    }
  })

  it('is never a bare number in a test file', () => {
    const bare = readdirSync(here)
      .filter((f) => f.endsWith('.test.ts'))
      .flatMap((f) =>
        readFileSync(join(here, f), 'utf8')
          .split(/\r?\n/)
          .flatMap((line, i) => (BARE.test(line) ? [f + ':' + (i + 1) + '  ' + line.trim()] : [])),
      )
    expect(bare).toEqual([])
  })
})
