import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { missEntryId, parseMissesFromLog, recordNewMisses } from '../src/core/misses'
import { appendEntry, readJournal } from '../src/core/journal'
import { sh, tempRepo } from './helpers/git'

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

describe('recordNewMisses - the same history writes the same journal', () => {
  /** A repository whose history holds two fixes with Missed-By trailers and one plain commit. */
  function historyWithMisses(): string {
    const repo = tempRepo('misses-history-', { 'a.txt': '1' })
    const commit = (message: string): void => {
      sh(repo, 'commit', '-q', '--allow-empty', '-m', message)
    }
    commit('fix: first bug\n\nMissed-By: pr-10')
    commit('chore: unrelated')
    commit('fix: second bug\n\nMissed-By: pr-20')
    return repo
  }

  it('keys each miss by its commit and dates it by the commit, oldest first', () => {
    const repo = historyWithMisses()
    try {
      const journalPath = join(dir, 'journal.jsonl')
      const added = recordNewMisses(repo, journalPath)
      const shas = sh(repo, 'log', '--format=%H', '--grep=Missed-By').split('\n').reverse()
      expect(added.map((e) => e.check)).toEqual(['pr-10', 'pr-20'])
      expect(added.map((e) => e.id)).toEqual(shas.map(missEntryId))
      expect(added[0]!.ts).toBe(sh(repo, 'log', '-1', '--format=%cI', shas[0]!))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('writes byte-identical journals from two separate recordings, so branches that both record merge cleanly', () => {
    const repo = historyWithMisses()
    try {
      const first = join(dir, 'first.jsonl')
      const second = join(dir, 'second.jsonl')
      recordNewMisses(repo, first)
      recordNewMisses(repo, second)
      expect(readFileSync(first, 'utf8')).toBe(readFileSync(second, 'utf8'))
      expect(recordNewMisses(repo, first)).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('appendEntry', () => {
  it('keeps a caller-supplied id and ts, and generates both otherwise', () => {
    const journalPath = join(dir, 'journal.jsonl')
    const kept = appendEntry(journalPath, { id: 'abcd1234', ts: '2026-01-01T00:00:00Z', check: 'c', commit: 'x', outcome: 'miss' })
    const generated = appendEntry(journalPath, { check: 'c', commit: 'y', outcome: 'pass' })
    expect(kept).toMatchObject({ id: 'abcd1234', ts: '2026-01-01T00:00:00Z' })
    expect(generated.id).toMatch(/^[0-9a-f]{8}$/)
    expect(readJournal(journalPath).map((e) => e.id)).toEqual(['abcd1234', generated.id])
  })
})

describe('recordNewMisses with a ref', () => {
  it('records only the misses on the given ref, not those on the checked-out branch', () => {
    const repo = tempRepo('misses-ref-', { 'a.txt': '1' })
    try {
      const main = sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
      sh(repo, 'commit', '-q', '--allow-empty', '-m', 'fix: landed\n\nMissed-By: pr-1')
      sh(repo, 'switch', '-q', '-c', 'feature')
      sh(repo, 'commit', '-q', '--allow-empty', '-m', 'fix: still on a branch\n\nMissed-By: pr-2')
      const journalPath = join(dir, 'journal.jsonl')
      expect(recordNewMisses(repo, journalPath, { ref: main }).map((e) => e.check)).toEqual(['pr-1'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('throws for a ref git cannot resolve, and never reads a ref as a flag', () => {
    const repo = tempRepo('misses-badref-', { 'a.txt': '1' })
    try {
      const journalPath = join(dir, 'journal.jsonl')
      expect(() => recordNewMisses(repo, journalPath, { ref: 'no-such-branch' })).toThrow(/could not read the history of no-such-branch/)
      expect(() => recordNewMisses(repo, journalPath, { ref: '--all' })).toThrow(/could not read the history of --all/)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
