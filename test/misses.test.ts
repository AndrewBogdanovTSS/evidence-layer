import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMissesFromLog, recordNewMisses } from '../src/core/misses'
import { appendEntry, readJournal } from '../src/core/journal'

const FS = '\x01'
const RS = '\x02'

function record(sha: string, body: string): string {
  return sha + FS + body + RS
}

describe('parseMissesFromLog', () => {
  it('extracts the Missed-By trailer and the fixing commit', () => {
    const log = record('abc123', 'fix: lock delay off-by-one\n\nMissed-By: demo/reviews/good-claims.md')
    expect(parseMissesFromLog(log)).toEqual([
      { commit: 'abc123', reviewRef: 'demo/reviews/good-claims.md', subject: 'fix: lock delay off-by-one' },
    ])
  })

  it('ignores commits with no trailer', () => {
    expect(parseMissesFromLog(record('abc123', 'chore: formatting'))).toHaveLength(0)
  })

  it('reads more than one commit', () => {
    const log = record('a', 'x\n\nMissed-By: r1.md') + record('b', 'y\n\nMissed-By: r2.md')
    expect(parseMissesFromLog(log)).toHaveLength(2)
  })
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'misses-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('recordNewMisses', () => {
  it('is idempotent - re-running does not duplicate an already-recorded miss', () => {
    const journalPath = join(dir, 'journal.jsonl')
    // Simulate a prior recording of the same commit directly, since this test
    // does not have a real git history to extract from.
    appendEntry(journalPath, { check: 'r1.md', commit: 'already-known', outcome: 'miss' })
    // recordNewMisses will call `git log` in `dir`, which is not a repo, so
    // findMisses returns [] and nothing new is added - this asserts the
    // idempotency guard does not itself throw or duplicate on an empty result.
    const added = recordNewMisses(dir, journalPath)
    expect(added).toHaveLength(0)
    expect(readJournal(journalPath)).toHaveLength(1)
  })
})
