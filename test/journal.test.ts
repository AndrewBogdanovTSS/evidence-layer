import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEntry, applyFlakyPolicy, classifyFailure, readJournal, summariseByCheck, tagEntry } from '../src/core/journal'

let dir: string
let journalPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'journal-'))
  journalPath = join(dir, 'journal.jsonl')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('appendEntry / readJournal', () => {
  it('starts empty when the file does not exist yet, rather than throwing', () => {
    expect(readJournal(journalPath)).toEqual([])
  })

  it('round-trips an entry, filling in id and timestamp', () => {
    const entry = appendEntry(journalPath, { check: 'check:docs', commit: 'abc', outcome: 'pass' })
    expect(entry.id).toMatch(/^[0-9a-f]{8}$/)
    expect(readJournal(journalPath)).toHaveLength(1)
  })

  it('never rewrites - two appends leave two lines', () => {
    appendEntry(journalPath, { check: 'a', commit: '1', outcome: 'pass' })
    appendEntry(journalPath, { check: 'a', commit: '2', outcome: 'pass' })
    expect(readJournal(journalPath)).toHaveLength(2)
  })

  it('skips a corrupted line instead of failing the whole read', () => {
    appendEntry(journalPath, { check: 'a', commit: '1', outcome: 'pass' })
    appendFileSync(journalPath, 'not json\n')
    appendEntry(journalPath, { check: 'a', commit: '2', outcome: 'pass' })
    expect(readJournal(journalPath)).toHaveLength(2)
  })
})

describe('tagEntry', () => {
  it('updates verified in place, and only that entry', () => {
    const a = appendEntry(journalPath, { check: 'a', commit: '1', outcome: 'error' })
    appendEntry(journalPath, { check: 'a', commit: '2', outcome: 'error' })
    expect(tagEntry(journalPath, a.id, { verified: 'real' })).toBe(true)
    const entries = readJournal(journalPath)
    expect(entries.find((e) => e.id === a.id)?.verified).toBe('real')
    expect(entries.find((e) => e.id !== a.id)?.verified).toBeUndefined()
  })

  it('returns false for an unknown id rather than silently doing nothing', () => {
    expect(tagEntry(journalPath, 'doesnotexist', { verified: 'real' })).toBe(false)
  })
})

describe('classifyFailure - the flaky/real-failure split', () => {
  it('is a real error the first time a commit fails - nothing to compare against yet', () => {
    const verdict = classifyFailure(journalPath, 'check:docs', 'commit-a')
    expect(verdict.outcome).toBe('error')
    expect(verdict.reason).toContain('no earlier green run')
  })

  it('is flaky when the same check passed at the same exact commit before', () => {
    appendEntry(journalPath, { check: 'check:docs', commit: 'commit-a', outcome: 'pass' })
    const verdict = classifyFailure(journalPath, 'check:docs', 'commit-a')
    expect(verdict.outcome).toBe('flaky')
  })

  it('is still a real error at a DIFFERENT commit, even if the check passed elsewhere before', () => {
    appendEntry(journalPath, { check: 'check:docs', commit: 'commit-a', outcome: 'pass' })
    const verdict = classifyFailure(journalPath, 'check:docs', 'commit-b')
    expect(verdict.outcome).toBe('error')
  })

  it('escalates to error once the flaky count reaches the threshold - flaky is not an unlimited escape hatch', () => {
    appendEntry(journalPath, { check: 'check:docs', commit: 'commit-a', outcome: 'pass' })
    appendEntry(journalPath, { check: 'check:docs', commit: 'commit-b', outcome: 'flaky' })
    appendEntry(journalPath, { check: 'check:docs', commit: 'commit-c', outcome: 'flaky' })
    // Third flaky flip at a passed commit should now escalate (threshold 3).
    const verdict = classifyFailure(journalPath, 'check:docs', 'commit-a', 3)
    expect(verdict.outcome).toBe('error')
    expect(verdict.reason).toContain('stopped being noise')
  })
})

describe('applyFlakyPolicy', () => {
  const okFinding = { level: 'pass' as const, claim: 'a', detail: '' }
  const errFinding = { level: 'error' as const, claim: 'a broke', detail: 'boom' }

  it('logs a clean run and leaves the findings untouched', () => {
    const out = applyFlakyPolicy(journalPath, 'check:docs', 'c1', [okFinding])
    expect(out).toEqual([okFinding])
    expect(readJournal(journalPath)[0]!.outcome).toBe('pass')
  })

  it('keeps a first-time failure as error - nothing to compare against yet', () => {
    const out = applyFlakyPolicy(journalPath, 'check:docs', 'c1', [errFinding])
    expect(out[0]!.level).toBe('error')
    expect(readJournal(journalPath)[0]!.outcome).toBe('error')
  })

  it('relabels a failure as flaky when this exact commit passed before', () => {
    applyFlakyPolicy(journalPath, 'check:docs', 'c1', [okFinding])
    const out = applyFlakyPolicy(journalPath, 'check:docs', 'c1', [errFinding])
    expect(out[0]!.level).toBe('flaky')
    expect(out[0]!.detail).toContain('boom')
    expect(readJournal(journalPath).at(-1)!.outcome).toBe('flaky')
  })

  it('escalates back to error once the flaky count reaches the threshold', () => {
    applyFlakyPolicy(journalPath, 'check:docs', 'c1', [okFinding])
    applyFlakyPolicy(journalPath, 'check:docs', 'c1', [errFinding]) // flaky #1
    applyFlakyPolicy(journalPath, 'check:docs', 'c1', [errFinding]) // flaky #2
    const out = applyFlakyPolicy(journalPath, 'check:docs', 'c1', [errFinding], 3) // should escalate
    expect(out[0]!.level).toBe('error')
  })
})

describe('summariseByCheck', () => {
  it('splits real, false and untagged findings per check, for the deferred usefulness decision', () => {
    appendEntry(journalPath, { check: 'check:docs', commit: '1', outcome: 'error', verified: 'real' })
    appendEntry(journalPath, { check: 'check:docs', commit: '2', outcome: 'error', verified: 'false' })
    appendEntry(journalPath, { check: 'check:docs', commit: '3', outcome: 'error' })
    appendEntry(journalPath, { check: 'check:docs', commit: '4', outcome: 'pass' })
    const [summary] = summariseByCheck(journalPath)
    expect(summary).toEqual({ check: 'check:docs', runs: 4, realFindings: 1, falseFindings: 1, untagged: 1, flaky: 0 })
  })

  it('excludes miss entries from the per-check rollup - they are a different question', () => {
    appendEntry(journalPath, { check: 'demo/reviews/x.md', commit: '1', outcome: 'miss' })
    expect(summariseByCheck(journalPath)).toHaveLength(0)
  })
})
