/**
 * The findings-and-misses journal - the one structure the rest of the layer
 * was missing.
 *
 * The claim it makes falsifiable: "this layer is useful." Every check here
 * verifies the moment a review is written. None of them remembered what they
 * found, and none of them looked at what happened after. That makes the whole
 * layer a claim about its own usefulness with no clock on it - the same shape
 * as the test counter in a README before something started checking it.
 *
 * Findings and misses are two ends of one structure, so they share one file
 * and one schema rather than becoming two formats nobody reads together.
 *
 *   - A **finding** is written by a checker, at the moment it runs, for free.
 *   - A **miss** is written once, when a bug that slipped through gets fixed -
 *     extracted from a commit trailer (see `misses.ts`) and appended here in
 *     the same shape, so one reader answers both questions.
 *
 * Recording starts the day this file exists, because none of it can be
 * reconstructed after the fact. The journal is deliberately a plain committed
 * file, not a service: no new dependency, and the history git already keeps
 * for every other file in this repository is exactly the audit trail a journal
 * needs.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { Finding } from './cli'

export type Outcome = 'pass' | 'error' | 'flaky' | 'unverifiable' | 'warning' | 'miss'

export interface JournalEntry {
  /** Short random id, so a human can tag this exact entry later without ambiguity. */
  id: string
  ts: string
  /** Which check produced this, or - for a miss - which review/PR failed to catch the bug. */
  check: string
  /** The commit the outcome is about. */
  commit: string
  outcome: Outcome
  /** Short human-readable summaries, when the outcome is not a plain pass. */
  findings?: string[]
  /**
   * Filled in later, by whoever fixed the thing, at the moment they fixed it -
   * not as a separate ritual. Reconstructing this retroactively is expensive
   * enough that nobody will do it, which is why the field exists at all: the
   * cost of tagging honestly has to be paid while the context is still free.
   */
  verified?: 'real' | 'false' | null
  /** For a miss only: could an existing check plausibly have caught it? Filled in by review, not guessed. */
  couldHaveCaught?: 'yes' | 'no' | null
}

function newId(): string {
  return randomBytes(4).toString('hex')
}

/** Appends one entry. Never rewrites the file - a journal you can edit in place is a journal that gets edited. */
export function appendEntry(journalPath: string, entry: Omit<JournalEntry, 'id' | 'ts'> & { ts?: string }): JournalEntry {
  const full: JournalEntry = { id: newId(), ts: entry.ts ?? new Date().toISOString(), ...entry }
  appendFileSync(journalPath, JSON.stringify(full) + '\n', 'utf8')
  return full
}

/**
 * Reads every entry. A malformed line is skipped, not fatal - one corrupted
 * line must not make months of accumulated data unreadable.
 */
export function readJournal(journalPath: string): JournalEntry[] {
  if (!existsSync(journalPath)) return []
  const entries: JournalEntry[] = []
  for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as JournalEntry)
    } catch {
      // Skipped, not thrown. See the file header: one bad line is not fatal.
    }
  }
  return entries
}

/**
 * Updates one entry's `verified` or `couldHaveCaught` field, in place, by id.
 * The only mutation the journal ever allows.
 */
export function tagEntry(
  journalPath: string,
  id: string,
  patch: Pick<JournalEntry, 'verified' | 'couldHaveCaught'>,
): boolean {
  const entries = readJournal(journalPath)
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) return false
  entries[idx] = { ...entries[idx]!, ...patch }
  writeFileSync(journalPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  return true
}

export interface FlakyVerdict {
  outcome: 'error' | 'flaky'
  reason: string
}

/**
 * The flaky/real-failure split.
 *
 * Signal: the same check failed at the same commit where it has previously
 * recorded a pass. Nothing about the commit changed between the two runs, so
 * the flip is not evidence of a regression - it is evidence of instability.
 *
 * A check failing at a commit it has never passed at is an ordinary failure:
 * first sight of a broken commit, not a flake.
 *
 * `flaky` is not an escape hatch. If the same check has already been called
 * flaky `threshold` times or more within the journal, this stops granting the
 * lenient outcome: "instability stopped being noise" and it converts to a real
 * error. The threshold is enforced here, not left optional, because a
 * leniency with no counter is a leniency that gets used forever.
 */
export function classifyFailure(journalPath: string, check: string, commit: string, threshold = 3): FlakyVerdict {
  const entries = readJournal(journalPath)
  const priorPassHere = entries.some((e) => e.check === check && e.commit === commit && e.outcome === 'pass')
  if (!priorPassHere) {
    return { outcome: 'error', reason: 'no earlier green run recorded for ' + check + ' at this commit' }
  }
  const priorFlaky = entries.filter((e) => e.check === check && e.outcome === 'flaky').length
  if (priorFlaky + 1 >= threshold) {
    return {
      outcome: 'error',
      reason: check + ' has been flagged flaky ' + (priorFlaky + 1) + ' times - instability stopped being noise',
    }
  }
  return {
    outcome: 'flaky',
    reason: check + ' passed at this exact commit before; nothing here changed, only the result did',
  }
}

/**
 * The wiring point: runs a check's own findings through the flaky policy and
 * logs the outcome, in one call. Not every check should use this - see
 * `fingerprint.ts`'s explicit refusal: an engine-determinism mismatch is
 * always a real, more serious finding, never noise, because determinism is a
 * property this project declares about itself rather than an assumption about
 * a flaky test harness.
 *
 * When the raw result is an error, this consults the journal and may relabel
 * every error-level finding as `flaky` instead - never silently, and never
 * without logging which one it was.
 */
export function applyFlakyPolicy(
  journalPath: string,
  check: string,
  commit: string,
  findings: Finding[],
  threshold = 3,
): Finding[] {
  const hasError = findings.some((f) => f.level === 'error')
  if (!hasError) {
    const outcome = findings.some((f) => f.level === 'warning')
      ? 'warning'
      : findings.some((f) => f.level === 'unverifiable')
        ? 'unverifiable'
        : 'pass'
    appendEntry(journalPath, { check, commit, outcome, findings: outcome === 'pass' ? undefined : ['non-error outcome'] })
    return findings
  }

  const verdict = classifyFailure(journalPath, check, commit, threshold)
  appendEntry(journalPath, {
    check,
    commit,
    outcome: verdict.outcome,
    findings: findings.filter((f) => f.level === 'error').map((f) => f.claim),
  })
  if (verdict.outcome === 'error') return findings
  // Downgrade: the underlying findings stay visible, but relabelled so the
  // caller's exit code and report both reflect "unstable," not "broken."
  return findings.map((f) =>
    f.level === 'error' ? { ...f, level: 'flaky' as const, detail: f.detail + ' (' + verdict.reason + ')' } : f,
  )
}

export interface JournalSummary {
  check: string
  runs: number
  realFindings: number
  falseFindings: number
  untagged: number
  flaky: number
}

/**
 * Per-check rollup, for the deferred usefulness decision (see
 * `docs/decisions/0002-evidence-layer-v2.md`). Not a verdict - the decision
 * needs a human looking at the untagged and real/false counts once there is
 * enough data, which this only makes possible to compute.
 */
export function summariseByCheck(journalPath: string): JournalSummary[] {
  const entries = readJournal(journalPath).filter((e) => e.outcome !== 'miss')
  const byCheck = new Map<string, JournalEntry[]>()
  for (const e of entries) {
    const list = byCheck.get(e.check) ?? []
    list.push(e)
    byCheck.set(e.check, list)
  }
  return [...byCheck.entries()].map(([check, list]) => ({
    check,
    runs: list.length,
    realFindings: list.filter((e) => e.outcome === 'error' && e.verified === 'real').length,
    falseFindings: list.filter((e) => e.outcome === 'error' && e.verified === 'false').length,
    untagged: list.filter((e) => e.outcome === 'error' && (e.verified === undefined || e.verified === null)).length,
    flaky: list.filter((e) => e.outcome === 'flaky').length,
  }))
}
