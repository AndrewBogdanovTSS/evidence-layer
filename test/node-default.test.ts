import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { measureDirSize, parseTestCount } from '../src/adapters/node-default'

describe('parseTestCount', () => {
  it('reads vitest\'s summary line', () => {
    expect(parseTestCount('Tests  71 passed (71)')).toBe(71)
  })

  it('reads jest\'s summary line', () => {
    expect(parseTestCount('Tests:       12 passed, 12 total')).toBe(12)
  })

  it('reads mocha\'s summary line', () => {
    expect(parseTestCount('  8 passing (12ms)')).toBe(8)
  })

  it('reads node\'s built-in test runner - the default spec reporter format', () => {
    // `ℹ tests N`, not `# tests N` (that is only the TAP reporter) - confirmed
    // by actually running `node --test` against the portability fixture in
    // examples/plain-node-project rather than assumed from memory.
    expect(parseTestCount('ℹ tests 3\nℹ pass 3\nℹ fail 0')).toBe(3)
  })

  it('reads node\'s TAP reporter format too', () => {
    expect(parseTestCount('# tests 3\n# pass 3')).toBe(3)
  })

  it('returns null, not zero, for an unrecognised format - the honest "cannot tell"', () => {
    expect(parseTestCount('all good, ship it')).toBeNull()
  })
})

describe('measureDirSize', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'size-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('sums file sizes recursively', () => {
    writeFileSync(join(dir, 'a.txt'), 'a'.repeat(10))
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'b.txt'), 'b'.repeat(5))
    expect(measureDirSize(dir)).toBe(15)
  })

  it('returns 0 for an empty directory, not an error', () => {
    expect(measureDirSize(dir)).toBe(0)
  })
})
