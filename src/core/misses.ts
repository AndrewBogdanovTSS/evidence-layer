/**
 * The other end of the journal: bugs that got past a clean review.
 *
 * The claim it makes falsifiable: "the checks that ran were sufficient." A
 * review can pass every check in this layer and still miss a defect - access,
 * gathered evidence and grounded claims are necessary, not sufficient, and
 * nothing so far recorded when that happened.
 *
 * The convention: a commit that fixes a bug adds one line to its own message,
 * naming the review or PR that missed it -
 *
 *     Missed-By: demo/reviews/good-claims.md
 *
 * - and this file extracts that line straight from git history into the same
 * journal `findings` use, so one reader and one format serve both questions.
 * The reference goes in a commit-message template, not left as a discipline
 * someone has to remember under pressure - see `docs/evidence-layer.md`.
 *
 * What this does not do: it does not measure completeness. A miss nobody ever
 * traced back to its review stays invisible, so the count is a floor, not a
 * rate, and must never be read as "this fraction of defects are caught."
 */
import { appendEntry, readJournal } from './journal'
import type { JournalEntry } from './journal'
import { run } from './proc'

const RECORD_SEP = '\x02'
const FIELD_SEP = '\x01'
const MISSED_BY_RE = /^Missed-By:\s*(.+)$/m

export interface ExtractedMiss {
  commit: string
  reviewRef: string
  subject: string
}

/**
 * Parses the raw `git log --pretty=format:%H<FS>%B<RS>` output into misses.
 * Separated from `findMisses` so the parsing rule is testable without a real
 * git history.
 */
export function parseMissesFromLog(rawLog: string): ExtractedMiss[] {
  const misses: ExtractedMiss[] = []
  for (const record of rawLog.split(RECORD_SEP)) {
    if (record.trim() === '') continue
    const [sha, body] = record.split(FIELD_SEP)
    if (!sha || !body) continue
    const match = MISSED_BY_RE.exec(body)
    if (!match) continue
    misses.push({ commit: sha.trim(), reviewRef: match[1]!.trim(), subject: body.split('\n')[0]!.trim() })
  }
  return misses
}

/** Reads every `Missed-By:` trailer out of the repository's history. Read-only. */
export function findMisses(repo: string): ExtractedMiss[] {
  const res = run(
    'git log --pretty=format:%H' + FIELD_SEP + '%B' + RECORD_SEP,
    { cwd: repo, timeoutMs: 60_000 },
  )
  if (res.exitCode !== 0) return []
  return parseMissesFromLog(res.output)
}

/**
 * Appends any miss not already recorded, and returns just the new ones.
 * Idempotent by design: this is meant to run on every `check:all` invocation,
 * and re-running it must never duplicate an entry.
 */
export function recordNewMisses(repo: string, journalPath: string): JournalEntry[] {
  const known = new Set(
    readJournal(journalPath)
      .filter((e) => e.outcome === 'miss')
      .map((e) => e.commit),
  )
  const added: JournalEntry[] = []
  for (const miss of findMisses(repo)) {
    if (known.has(miss.commit)) continue
    added.push(
      appendEntry(journalPath, {
        check: miss.reviewRef,
        commit: miss.commit,
        outcome: 'miss',
        findings: [miss.subject],
        couldHaveCaught: null,
      }),
    )
  }
  return added
}
