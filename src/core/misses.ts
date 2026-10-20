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
  /** The fixing commit's committer date (`%cI`), when the log carried it. */
  date?: string
}

/**
 * Parses the raw `git log --pretty=format:%H<FS>%cI<FS>%B<RS>` output into
 * misses. The older two-field form, `%H<FS>%B<RS>`, still parses, without a
 * date. Separated from `findMisses` so the parsing rule is testable without a
 * real git history.
 */
export function parseMissesFromLog(rawLog: string): ExtractedMiss[] {
  const misses: ExtractedMiss[] = []
  for (const record of rawLog.split(RECORD_SEP)) {
    if (record.trim() === '') continue
    const fields = record.split(FIELD_SEP)
    const [sha, date, body] = fields.length >= 3 ? fields : [fields[0], undefined, fields[1]]
    if (!sha || !body) continue
    const match = MISSED_BY_RE.exec(body)
    if (!match) continue
    misses.push({
      commit: sha.trim(),
      reviewRef: match[1]!.trim(),
      subject: body.split('\n')[0]!.trim(),
      ...(date?.trim() ? { date: date.trim() } : {}),
    })
  }
  return misses
}

/** Reads every `Missed-By:` trailer out of the repository's history. Read-only. */
export function findMisses(repo: string): ExtractedMiss[] {
  const res = run(
    'git log --pretty=format:%H' + FIELD_SEP + '%cI' + FIELD_SEP + '%B' + RECORD_SEP,
    { cwd: repo, timeoutMs: 60_000 },
  )
  if (res.exitCode !== 0) return []
  return parseMissesFromLog(res.output)
}

/**
 * A miss's journal id: the fixing commit's first eight hex digits. Random ids
 * made the same miss a different line on every machine that recorded it, so
 * two branches recording it both merged in and it counted twice. Derived from
 * the commit, the line is byte-identical wherever it is written, and git
 * merges two identical additions as one.
 */
export function missEntryId(commit: string): string {
  return commit.slice(0, 8)
}

/**
 * Appends any miss not already recorded, and returns just the new ones,
 * oldest first. Idempotent by design: this is meant to run on every
 * `check:all` invocation, and re-running it must never duplicate an entry.
 *
 * Every field of a recorded miss comes from the commit - id from its SHA, `ts`
 * from its committer date - so recording is deterministic: any checkout of the
 * same history writes the same lines in the same order, and a project can
 * record from every pull request instead of from one machine.
 */
export function recordNewMisses(repo: string, journalPath: string): JournalEntry[] {
  const known = new Set(
    readJournal(journalPath)
      .filter((e) => e.outcome === 'miss')
      .map((e) => e.commit),
  )
  const added: JournalEntry[] = []
  // git log is newest first; the journal reads in time order.
  for (const miss of findMisses(repo).reverse()) {
    if (known.has(miss.commit)) continue
    known.add(miss.commit)
    added.push(
      appendEntry(journalPath, {
        id: missEntryId(miss.commit),
        ...(miss.date ? { ts: miss.date } : {}),
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
