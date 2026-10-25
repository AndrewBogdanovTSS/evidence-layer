/**
 * `check:claims` core - is every claim in a review backed?
 *
 * The claim it makes falsifiable: the grounding tags themselves.
 *
 * A review can label each of its claims VERIFIED, DOCUMENTED, INFERRED or
 * UNVERIFIED. That convention is worth nothing on its own, because a tag costs
 * one token to write and nothing checks it. Anything a writer can satisfy for
 * free carries no information.
 *
 * VERIFIED comes in two forms:
 *
 *   - `VERIFIED[tests-a3f91c]` - addressed. The tag names the exact artifact it
 *     rests on, and this resolves that id anywhere in the document, checks it
 *     was collected at the commit the review claims to be about, and refuses to
 *     let two unrelated claims share one artifact silently.
 *   - bare `VERIFIED` - legacy. Falls back to the original proximity check (an
 *     artifact block within 15 lines) and adds a warning recommending the
 *     addressed form. Proximity alone has a real gap: a block copied to the
 *     wrong place still passes it, because it confirms *a* block is nearby, not
 *     that it is *the* block the claim is about. See
 *     `docs/decisions/0002-evidence-layer-v2.md` for the deprecation date.
 *
 * DOCUMENTED must cite something. INFERRED must show its reasoning. Language
 * that cannot be wrong - "more robust", "behaves identically", "it works" - has
 * to be marked UNVERIFIED or backed by a stated effect.
 *
 * An honest UNVERIFIED is worth more than a decorative VERIFIED: it tells the
 * reader exactly where the review is thin.
 *
 * An addressed tag can also carry predicates - `VERIFIED[tests-a3f91c: exit=0,
 * failed=0, passed>=71]` - which say outright which numbers on the artifact the
 * claim rests on, instead of leaving them to be inferred from its wording. See
 * `predicates.ts`. A bracket that is neither a bare id nor an id with
 * predicates is an error, never a quiet fall back to bare `VERIFIED`.
 *
 * Claims come in two shapes. A `**Claim**:` block is found here, its grade on
 * the claim line or a few lines of prose below it. An inline claim - a table
 * cell, a list item, any line in a format this module does not parse - is
 * found by the caller and handed in (`LintOptions.inlineClaims`), so the
 * caller keeps its grammar and this keeps what a grade means. An inline claim
 * has no lines below it to borrow, so its citation or reasoning must be in its
 * own text.
 *
 * It does check the outcome, where the outcome is mechanical: a claim that
 * reads as success cannot rest on a run that exited non-zero, a run that was
 * stopped before it finished backs only "did not complete", and a lint or test
 * run whose work summary shows it checked nothing backs no success claim - see
 * `outcomeProblem`. Two more rules read the claim's words against the run it
 * cites, just as mechanically: a claim that names a kind of run (tests, lint,
 * typecheck, lockfile, audit) cannot cite a run of another kind, and a count
 * the sentence states about the run ("71 passing tests") must be the count
 * its work summary carries - see `kindProblem` and `countProblem`. Those
 * catch the citation a writer gets wrong most often, the wrong block, without
 * reading any output for sense.
 *
 * A failing finding carries a `fix` wherever one is mechanical: the claim the
 * cited run does back, as the skeleton would write it, or the grounding line
 * with the run's own predicates. `downgradeClaims` applies the one fix that is
 * always honest - marking a failing claim UNVERIFIED - so that the cheapest
 * way past a finding says less, never more.
 *
 * What this does not do: it does not verify that an artifact's output actually
 * supports the meaning of the claim next to it - that requires reading the
 * output for sense, which is a probabilistic judgement, and putting one inside
 * a deterministic checker reintroduces exactly the circular validation this
 * layer exists to avoid. Beyond the outcome, kind and count rules above, it
 * guarantees only that the artifact exists, was collected here, and was
 * pointed at on purpose rather than left nearby.
 */
import { ARTIFACT_ID_RE, classifyCommand, fencedLineNumbers, findArtifactBlocks, parseWorkSummary, workDone } from './artifact'
import type { ArtifactBlock, StopReason } from './artifact'
import type { CodedFinding } from './codes'
import { evaluatePredicates, parsePredicates, suggestPredicates } from './predicates'
import { suggestedClaim } from './skeleton'

/** How far below a legacy (unaddressed) VERIFIED tag its artifact block is allowed to sit. */
export const ARTIFACT_WINDOW = 15

/** A single artifact id is allowed to back this many claims before it is a warning, not a pass. */
export const SHOTGUN_THRESHOLD = 2

/** How many lines of prose below a `**Claim**:` line its grade may sit, unless `LintOptions.gradeWindow` says otherwise. */
export const GRADE_WINDOW = 2

/**
 * How many words an inline INFERRED claim must carry besides its tag. A table
 * cell has no room for a numbered chain, and a one-clause reason ("fewer
 * unique URLs -> more cache reuse") is what such a cell can honestly hold - so
 * the bar is that the tag does not stand alone, not that it argues at length.
 */
export const INLINE_REASON_WORDS = 2

export const GRADES = ['VERIFIED', 'DOCUMENTED', 'INFERRED', 'UNVERIFIED'] as const
export type Grade = (typeof GRADES)[number]

const CLAIM_RE = /^\s*\*\*Claim\*\*:/
// Built from GRADES so the list of grades exists in exactly one place. The
// bracket is captured whole - closed or not - and parsed separately, so that a
// bracket which is not a valid address is reported as one rather than matching
// nothing and leaving the tag to read as bare VERIFIED.
const GRADE_RE = new RegExp('\\b(' + GRADES.join('|') + ')(\\[[^\\]\\n]*\\]?)?')
// `[<id>]` or `[<id>: <predicates>]`, the id in exactly the grammar artifact.ts gives it.
const ADDRESS_RE = new RegExp('^\\[(' + ARTIFACT_ID_RE.source.slice(1, -1) + ')(?:\\s*:(.*))?\\]$')
// A citation is anything a reader can go and open: a URL, a spec section, an
// issue id, or a file in this repository. The last form matters here - a project
// without an issue tracker still has documents, and refusing to accept them
// would push writers towards the vaguer tag rather than the truer one.
const CITATION_RE = /(https?:\/\/\S+|§\s*\S+|#\d+|\b[A-Z][A-Z0-9]+-\d+\b|`[\w./@-]+\.[a-z]+`)/
const NUMBERED_STEP_RE = /^\s*\d+\.\s+\S/

// Language that survives every outcome. Not banned because it is rude - banned
// because nothing could contradict it, which makes it decoration wearing the
// costume of a finding.
const VAGUE_COMPARATIVE_RE = /\bmore (?:resilient|robust|safe|explicit|performant|idiomatic)\b|\bcleaner\b/i
// Narrow on purpose. An earlier version of this matched a bare "is the same",
// which fires on ordinary English ("the same review, repaired") and teaches
// people to stop reading the output. Precision is the feature, not the polish.
const UNCHECKED_EQUIVALENCE_RE =
  /\b(?:should (?:be|compile|behave)|behaves?|compiles? to|(?:is|are) functionally) (?:equivalent|identical|the same)\b/i
const SUCCESS_WORD_RE = /\b(?:works|fixed|resolved|passes|tested|validated)\b/i
// Modals and negations turn an assertion into a question, a hypothetical, or a
// statement about what is possible. None of those is a success claim.
const HYPOTHETICAL_RE = /\b(?:might|could|would|may|can|cannot|can't|if|whether|until)\b/i
const EFFECT_RE = /\*\*Effect\*\*:/
const SYCOPHANCY_RES = [
  /you'?re (?:probably )?right/i,
  /i was overthinking/i,
  /but i could be wrong/i,
  /good catch/i,
]

// "no <failure noun>" is the success form of a failure noun ("Lint reports no
// violations"), so it is matched first - otherwise the failure noun inside it
// reads as an admission of failure. These cover the skeleton's own sentences
// plus the common rephrasings.
const NEGATED_FAILURE_RE =
  /\b(?:no|zero|0|without)\s+(?:known\s+|new\s+)?(?:failures?|failing|errors?|violations?|vulnerabilit(?:y|ies)|issues?|problems?|warnings?|regressions?)\b|\bnothing\s+(?:fails|failed|breaks|broke)\b/i
const SUCCESS_VERB_RE =
  /\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed|ing)?|successful(?:ly)?|clean(?!-)|green|works|compiles|is unchanged|exits? 0)\b/i
const NEGATION_RE = /\b(?:not|never|no longer|fails? to|cannot)\b|n't\b/i
const INCOMPLETE_RE = /\b(?:did not|didn't) (?:complete|finish)\b|\btimed out\b|\bwas (?:killed|stopped)\b|\bno result\b/i

/**
 * Whether a claim sentence asserts that something passed. Deterministic and
 * deliberately narrow: it catches the default lie - the skeleton's own success
 * sentences and the common "passes / no errors" phrasings - not a writer
 * determined to word around it. A negation before the success verb ("does not
 * pass") reads as a failure claim, which a failing artifact is exactly what
 * verifies.
 */
export function readsAsSuccess(text: string): boolean {
  if (NEGATED_FAILURE_RE.test(text)) return true
  const verb = SUCCESS_VERB_RE.exec(text)
  if (!verb) return false
  return !NEGATION_RE.test(text.slice(0, verb.index))
}

/** Whether a claim sentence says its run never finished - the only thing a stopped run can back. */
export function readsAsIncomplete(text: string): boolean {
  return INCOMPLETE_RE.test(text)
}

/** The parts of an artifact the outcome rules read. `ArtifactBlock` satisfies it. */
export interface OutcomeArtifact {
  command: string
  output: string
  exitCode: number
  stopped?: StopReason
}

export interface OutcomeOptions {
  /**
   * A success claim on a lint or test artifact must carry a work-summary line.
   * Off by default, because artifacts gathered before the summary existed have
   * none; a project whose gatherer writes summaries turns it on, after which a
   * summary-less artifact cannot back a success claim. A summary that *is*
   * present is always checked.
   */
  requireWorkSummary?: boolean
}

/**
 * Why the cited run cannot back this claim, or `null` when its outcome allows
 * it. The rules are mechanical - read off the exit line and the work summary,
 * never off the output's meaning:
 *
 *   1. A run that was stopped (`exit: 124 (timeout)`, `(overflow)`, `(killed
 *      SIGKILL)`) reported nothing, so it backs only a claim that it did not
 *      complete - not a pass, and not a failure either.
 *   2. A claim that reads as success cannot rest on a non-zero exit.
 *   3. A success claim on a lint or test run needs that run to have checked
 *      something: exit 0 is also what a linter whose every file was ignored,
 *      and a test run whose every test was skipped, report.
 */
export function outcomeProblem(artifact: OutcomeArtifact, claimText: string, opts: OutcomeOptions = {}): string | null {
  const cmd = '`' + artifact.command + '`'
  if (artifact.stopped) {
    if (readsAsIncomplete(claimText)) return null
    return (
      'cites ' + cmd + ', which was stopped before it finished (' + artifact.stopped + ') - it can back only ' +
      '"did not complete", not a pass and not a failure. Re-run it with a longer limit'
    )
  }
  if (!readsAsSuccess(claimText)) return null
  if (artifact.exitCode !== 0) {
    return (
      'asserts success, but ' + cmd + ' exited ' + artifact.exitCode + ' - a failing command cannot verify ' +
      'that something passed. State what it actually showed, or re-run it'
    )
  }
  const kind = classifyCommand(artifact.command)
  if (kind !== 'lint' && kind !== 'tests') return null
  const summary = parseWorkSummary(artifact.output)
  if (!summary) {
    return opts.requireWorkSummary
      ? 'asserts success, but ' + cmd + ' has no work summary - exit 0 alone cannot show it checked anything. Regenerate the evidence'
      : null
  }
  if (summary.kind !== kind) {
    return 'asserts success, but the work summary in ' + cmd + ' describes a ' + summary.kind + ' run, not ' + kind
  }
  const counts = Object.entries(summary.counts).map(([k, v]) => k + '=' + v).join(' ')
  if (workDone(summary) <= 0) return 'asserts success, but ' + cmd + ' checked nothing (' + counts + ')'
  // A linter exits 0 on warnings unless told otherwise, and "no violations"
  // over a run that printed some is not true either way.
  const found = kind === 'lint' ? summary.counts.errors! + summary.counts.warnings! : summary.counts.failed!
  if (found > 0) return 'asserts success, but the work summary in ' + cmd + ' reports problems (' + counts + ')'
  return null
}

// What a claim says it is about, by the words it uses for a kind of run. Each
// kind is one `classifyCommand` returns. Narrow and English, like the outcome
// rules: a word that fires on ordinary prose would fail a claim citing the
// right run. So "types" and "suite" are not here ("this type of change", "the
// lint suite"), and neither is a bare "audit" or "vulnerability" - "the XSS
// vulnerability is fixed" is a claim a test run backs.
const KIND_WORDS: readonly (readonly [kind: string, name: string, words: RegExp])[] = [
  ['tests', 'test', /\btests?\b/i],
  ['lint', 'lint', /\blint(?:s|ed|ing|er)?\b|\beslint\b|\bruff\b|\bpylint\b|\bflake8\b/i],
  ['types', 'typecheck', /\btype[- ]?check(?:s|ed|ing|er)?\b|\btype errors?\b|\btsc\b|\bmypy\b|\bpyright\b/i],
  ['lockfile', 'lockfile', /\block ?file\b/i],
  ['audit', 'audit', /\b(?:dependency|npm|pnpm|yarn|bun|pip|cargo|security) audit\b|\baudit reports?\b/i],
]

/** The kinds of run a claim sentence names, by `classifyCommand`'s names. */
export function kindsNamed(text: string): string[] {
  return KIND_WORDS.filter(([, , words]) => words.test(text)).map(([kind]) => kind)
}

const kindName = (kind: string): string => KIND_WORDS.find(([k]) => k === kind)?.[1] ?? kind

type Counts = Record<string, number>
/** How a stated number is read off a work summary - one key, or a sum of them. */
interface Reading {
  label: string
  of: (c: Counts) => number
}

const key = (k: string): Reading => ({ label: k, of: (c) => c[k]! })
const TOTAL: Reading = { label: 'passed+failed+skipped+todo', of: (c) => c.passed! + c.failed! + c.skipped! + c.todo! }
// The skeleton says "checked 7 files" for the files that were not ignored.
const CHECKED_FILES: Reading = { label: 'files-ignored', of: (c) => c.files! - c.ignored! }
const QUALIFIER_KEY: Record<string, string> = {
  passing: 'passed', passed: 'passed', pass: 'passed',
  failing: 'failed', failed: 'failed', fail: 'failed',
  skipped: 'skipped', todo: 'todo',
}
const qualified = (m: RegExpMatchArray): Reading[] => [key(QUALIFIER_KEY[m[2]!.toLowerCase()]!)]

// A count spelled out is the same count: "four passing tests" over `passed=3`
// is as wrong as "4 passing tests", and a rule that read only digits would let
// the writer pass it by choosing the spelling. Zero to twenty, the numbers
// prose spells; "twenty-one" and above are written as digits in practice, and
// "no" and "a" are not read - "no failing tests" is the outcome rules' claim,
// and "a test" counts nothing.
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
]
const N = '(\\d+|' + NUMBER_WORDS.join('|') + ')'
const countRe = (source: string): RegExp => new RegExp(source.replaceAll('<n>', N), 'gi')
const countValue = (written: string): number => {
  const word = NUMBER_WORDS.indexOf(written.toLowerCase())
  return word === -1 ? Number(written) : word
}

/**
 * The shapes of a count this reads, each anchored to a word that says the
 * number is about the run - a qualifier ("71 passing tests"), a verb ("ran
 * 71 tests", "7 files were linted") or a summary key ("3 skipped"). A bare
 * number and noun is not one: "adds 3 tests" and "touches 12 files" are
 * about the change, not the run, and a rule that failed them would teach
 * writers to stop reading its output. `<n>` in each pattern is a number, in
 * digits or spelled out.
 */
const COUNT_RULES: readonly { re: RegExp; kind: 'tests' | 'lint'; readings: (m: RegExpMatchArray) => Reading[] }[] = [
  { re: countRe(String.raw`\b<n>\s+(passing|passed|failing|failed|skipped)\s+tests?\b`), kind: 'tests', readings: qualified },
  { re: countRe(String.raw`\b<n>\s+tests?\s+(?:were\s+|have\s+)?(passed|pass|failed|fail|skipped)\b`), kind: 'tests', readings: qualified },
  // "Ran 71 tests" is how many passed or how many there were - both are honest readings.
  { re: countRe(String.raw`\b(?:ran|runs|run|executed|executes)\s+<n>\s+tests?\b`), kind: 'tests', readings: () => [key('passed'), TOTAL] },
  { re: countRe(String.raw`\b<n>\s+tests?\s+(?:ran|run)\b`), kind: 'tests', readings: () => [key('passed'), TOTAL] },
  { re: countRe(String.raw`\b<n>\s+(passed|failed|skipped|todo)\b(?!\s+tests?\b)`), kind: 'tests', readings: qualified },
  { re: countRe(String.raw`\b<n>\s+failures?\b`), kind: 'tests', readings: () => [key('failed')] },
  { re: countRe(String.raw`\b(?:checked|linted|scanned)\s+<n>\s+files?\b`), kind: 'lint', readings: () => [CHECKED_FILES, key('files')] },
  { re: countRe(String.raw`\b<n>\s+files?\s+(?:were\s+)?(?:checked|linted|scanned)\b`), kind: 'lint', readings: () => [CHECKED_FILES, key('files')] },
  { re: countRe(String.raw`\b<n>\s+(?:files?\s+(?:were\s+)?ignored|ignored\s+files?)\b`), kind: 'lint', readings: () => [key('ignored')] },
  { re: countRe(String.raw`\b<n>\s+(?:lint\s+)?(errors?|warnings?)\b`), kind: 'lint', readings: (m) => [key(/^e/i.test(m[2]!) ? 'errors' : 'warnings')] },
]

// A sentence about what used to be true - "fixes the 2 failing tests" - states
// counts the run never saw. Its counts are not read at all: a missed check is
// a smaller cost than an error over an honest sentence.
const HISTORY_RE = /\b(?:fix(?:es|ed|ing)?|previously|before|used to|no longer|earlier)\b/i

/** One count a sentence states: the words, the number, the run kind it counts, and the readings it may equal. */
interface StatedCount {
  text: string
  value: number
  kind: 'tests' | 'lint'
  readings: Reading[]
}

function statedCounts(text: string): StatedCount[] {
  if (HISTORY_RE.test(text)) return []
  return COUNT_RULES.flatMap((rule) =>
    [...text.matchAll(rule.re)].map((m) => ({ text: m[0], value: countValue(m[1]!), kind: rule.kind, readings: rule.readings(m) })),
  )
}

/**
 * Why the claim cites a run of a kind its own words do not name, or `null`.
 * "Lint reports no violations" over a typecheck block is the wrong block, and
 * the outcome rules would otherwise grade it as the typecheck it is. Checked
 * before the outcome, because a verdict on the wrong run says nothing about
 * the claim. A claim that names several kinds passes if one is the run's; a
 * claim that names none, or a run whose kind no word names (a diff, a
 * fingerprint, a project's own command), is held to nothing - there is
 * nothing in the sentence to compare.
 */
export function kindProblem(artifact: OutcomeArtifact, claimText: string): { detail: string; named: string[] } | null {
  const kind = classifyCommand(artifact.command)
  const named = kindsNamed(claimText)
  if (!KIND_WORDS.some(([k]) => k === kind) || named.length === 0 || named.includes(kind)) return null
  return {
    named,
    detail: 'is about ' + named.map(kindName).join(' and ') + ', but cites `' + artifact.command + '`, a ' + kindName(kind) + ' run',
  }
}

/**
 * Why a count the claim states is not the count its run's work summary
 * carries, or `null`. "72 passing tests" over `passed=71` is not a rounding of
 * the truth, and a predicate would have caught it only had the writer written
 * one. A count of the kind the run does not summarise is left alone -
 * `kindProblem` is the rule that speaks to the wrong kind - and so is every
 * count on a run with no summary: there is nothing to hold it to.
 */
export function countProblem(artifact: OutcomeArtifact, claimText: string): { detail: string; expected: number; observed: number } | null {
  const summary = parseWorkSummary(artifact.output)
  if (!summary) return null
  for (const stated of statedCounts(claimText)) {
    if (stated.kind !== summary.kind) continue
    const actual = stated.readings.map((r) => ({ label: r.label, value: r.of(summary.counts) }))
    if (actual.some((a) => a.value === stated.value)) continue
    return {
      detail:
        'says "' + stated.text + '", but the work summary in `' + artifact.command + '` says ' +
        actual.map((a) => a.label + '=' + a.value).join(' and '),
      expected: stated.value,
      observed: actual[0]!.value,
    }
  }
  return null
}

interface Claim {
  /** 0-based line of the `**Claim**:` line. */
  line: number
  text: string
  grade?: Grade
  /** Present only for the addressed `VERIFIED[id]` form. */
  gradeId?: string
  /** The text after the colon in `VERIFIED[id: ...]`, when there is one. */
  gradePredicates?: string
  /** The bracket after VERIFIED, as written, when it is not a valid address. */
  gradeMalformed?: string
  /** The bracket after VERIFIED, as written - stripped before the claim's wording is read. */
  gradeBracket?: string
  /** 0-based line the grade was found on. */
  gradeLine?: number
  /** Found by the caller rather than here (`LintOptions.inlineClaims`): its citation and reasoning must be in `text`. */
  inline?: boolean
}

type GradeFields = Pick<Claim, 'grade' | 'gradeId' | 'gradePredicates' | 'gradeMalformed' | 'gradeBracket'>

/** The first grade a piece of text carries, with a VERIFIED address parsed - `undefined` when it carries none. */
function readGrade(text: string): GradeFields | undefined {
  const found = GRADE_RE.exec(text)
  if (!found) return undefined
  const grade = found[1] as Grade
  const bracket = found[2]
  // Only VERIFIED is addressed; a bracket after any other grade is prose.
  if (bracket === undefined || grade !== 'VERIFIED') return { grade }
  const address = ADDRESS_RE.exec(bracket)
  if (!address) return { grade, gradeBracket: bracket, gradeMalformed: bracket }
  return {
    grade,
    gradeBracket: bracket,
    gradeId: address[1],
    ...(address[2] !== undefined && { gradePredicates: address[2] }),
  }
}

export function findClaims(lines: string[], fenced: Set<number>, gradeWindow = GRADE_WINDOW): Claim[] {
  const claims: Claim[] = []
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i) || !CLAIM_RE.test(lines[i]!)) continue
    const claim: Claim = { line: i, text: lines[i]!.replace(CLAIM_RE, '').trim() }
    // The grade lives on the claim line or within `gradeWindow` lines of prose
    // below it - close enough that a reader sees them together. A fenced block
    // between the two is an example the claim is about, not distance, so its
    // lines neither count against the window nor can carry the grade; the next
    // claim ends the search, so a claim never borrows the grade below it.
    let below = 0
    for (let j = i; j < lines.length; j++) {
      if (j > i) {
        if (fenced.has(j)) continue
        if (CLAIM_RE.test(lines[j]!)) break
        if (++below > gradeWindow) break
      }
      const grade = readGrade(lines[j]!)
      if (grade) {
        Object.assign(claim, grade, { gradeLine: j })
        break
      }
    }
    claims.push(claim)
  }
  return claims
}

/**
 * A claim the caller found itself - a table cell, a list item, a line in a
 * format this module does not parse - to be graded by the same rules as a
 * `**Claim**:` block.
 */
export interface InlineClaim {
  /** 1-based line in the checked document: where findings point, and where a bare VERIFIED looks below for its block. */
  line: number
  /** The claim's whole text, grade tag included. A DOCUMENTED citation or an INFERRED reason must be in it. */
  text: string
}

export interface LintOptions extends OutcomeOptions {
  /** The commit the review claims to be about, when known - enables the id/commit mismatch check. */
  expectedHeadSha?: string
  /**
   * A second document whose artifact blocks a VERIFIED id may resolve to, as
   * well as the checked text's own - a sealed bundle, when the claims are in a
   * chat message that carries no blocks of its own. Only where ids are looked
   * up changes; the claims are still read from the checked text alone.
   */
  artifactSource?: string
  /**
   * What `artifactSource` is, in the words a finding uses - `the current sealed
   * run` for the gate's final-message check. Without one, an unknown id is
   * reported as missing from "this document", which for a chat reply that
   * carries no blocks names the wrong place to look.
   */
  artifactSourceName?: string
  /**
   * A document whose artifact blocks a finding's `fix` may suggest, though
   * none of them resolves a claim - the sealed bundle, for a review file that
   * has to carry its own blocks. A fix naming a block from here, rather than
   * from the checked text, says to copy the block in.
   */
  suggestFrom?: string
  /**
   * Apply the prose rules (vague comparatives, success words with no stated
   * effect). Default `true`. Off for a conversational reply, where ordinary
   * prose is not graded and only `**Claim**:` lines are.
   */
  prose?: boolean
  /**
   * How many lines of prose below a `**Claim**:` line its grade may sit.
   * Default `GRADE_WINDOW`. Lines inside a fenced block do not count.
   */
  gradeWindow?: number
  /**
   * Claims the caller found in a shape this module does not parse, graded
   * alongside the `**Claim**:` blocks: the same address, commit, predicate and
   * outcome rules, and the same shotgun count. See `InlineClaim`.
   */
  inlineClaims?: InlineClaim[]
}

export function lintClaims(markdown: string, file: string, opts: LintOptions = {}): CodedFinding[] {
  const lines = markdown.split(/\r?\n/)
  const fenced = fencedLineNumbers(lines)
  const gradeWindow = opts.gradeWindow ?? GRADE_WINDOW
  if (!Number.isSafeInteger(gradeWindow) || gradeWindow < 0) {
    throw new RangeError('gradeWindow must be a whole number of lines, 0 or more - got ' + gradeWindow)
  }
  const claims = findClaims(lines, fenced, gradeWindow)
  const inlineClaims = (opts.inlineClaims ?? []).map((c): Claim => {
    if (!Number.isSafeInteger(c.line) || c.line < 1 || c.line > lines.length) {
      throw new RangeError('inline claim line ' + c.line + ' is not a line of ' + file + ' (1 to ' + lines.length + ')')
    }
    const text = c.text.trim()
    const grade = readGrade(text)
    return { line: c.line - 1, text, inline: true, ...(grade && { ...grade, gradeLine: c.line - 1 }) }
  })
  const artifacts = [
    ...findArtifactBlocks(lines),
    ...(opts.artifactSource !== undefined ? findArtifactBlocks(opts.artifactSource.split(/\r?\n/)) : []),
  ]
  const fixes = fixer(artifacts, opts.suggestFrom !== undefined ? findArtifactBlocks(opts.suggestFrom.split(/\r?\n/)) : [])
  const findings: CodedFinding[] = []

  if (claims.length + inlineClaims.length === 0 && opts.prose !== false) {
    findings.push({
      level: 'warning',
      code: 'claims/none',
      claim: 'the review states claims',
      detail: 'no `**Claim**:` lines found - nothing here can be checked',
      fix: 'state each checkable result as a `**Claim**:` line, with a `**Grounding**:` line below it',
      file,
    })
  }

  // One id, two different blocks: at most one of them is what the id names, and
  // a claim resolving the id would be checked against whichever came first.
  // Identical copies are fine - the same block pasted twice is still that block.
  for (const [id, blocks] of groupById(artifacts)) {
    // Compared line by line, trimmed - the same canonical form the seal hashes -
    // so trailing spaces an editor added do not make one block two.
    const bodies = new Set(blocks.map((b) => [b.info, ...b.body].map((l) => l.trim()).join('\n')))
    if (bodies.size > 1) {
      findings.push({
        level: 'error',
        code: 'claims/id-conflict',
        claim: 'artifact ' + id + ' is one artifact',
        detail:
          id + ' labels ' + bodies.size + ' different blocks (lines ' + blocks.map((b) => b.start + 1).join(', ') +
          ') - an id is an address, and an address names one thing. Regenerate the evidence rather than editing a block',
        fix: 'keep one block for ' + id + ', copied from the evidence bundle unedited, and delete the others',
        file,
        line: blocks[1]!.start + 1,
      })
    }
  }

  // The rules that read a claim's words against the run it cites, in the
  // order a writer should hear them: the wrong kind of run first, since a
  // verdict on the wrong run says nothing about the claim; then the outcome;
  // then the counts the sentence states.
  const citedProblem = (
    artifact: ArtifactBlock,
    claimText: string,
    inline: boolean | undefined,
    commit: string | undefined,
  ): Omit<CodedFinding, 'claim'> | null => {
    const ownFix = fixes.ready(artifact, inline) ?? 'mark the claim UNVERIFIED'
    const kind = kindProblem(artifact, claimText)
    if (kind) {
      const others = fixes.ofKind(kind.named, commit)
      return {
        level: 'error',
        code: 'claims/kind-mismatch',
        detail: kind.detail,
        fix:
          (others.length === 1 ? fixes.ready(others[0]!, inline) : undefined) ??
          (others.length === 0
            ? 'no ' + kind.named.map(kindName).join(' or ') + ' run was gathered - gather one and cite it, or mark the claim UNVERIFIED'
            : fixes.orCite(others)),
      }
    }
    const outcome = outcomeProblem(artifact, claimText, opts)
    if (outcome) return { level: 'error', code: 'claims/outcome-mismatch', detail: outcome, fix: ownFix }
    const count = countProblem(artifact, claimText)
    if (count) return { level: 'error', code: 'claims/count-mismatch', detail: count.detail, expected: count.expected, observed: count.observed, fix: ownFix }
    return null
  }

  // Legacy proximity mode may still consume an artifact positionally, so two
  // unaddressed VERIFIED tags cannot silently share one block either.
  const consumedByPosition = new Set<number>()
  // Addressed mode: how many claims point at each id, for the shotgun check.
  const idUsage = new Map<string, { count: number; lastLine: number }>()

  // `nextClaimLine` bounds where an INFERRED block looks for its numbered
  // chain; an inline claim carries its reasoning in its own text instead.
  const grade = (claim: Claim, nextClaimLine: number): void => {
    const where = { file, line: claim.line + 1 }

    if (!claim.grade) {
      findings.push({
        level: 'error',
        code: 'claims/untagged',
        claim: claim.text,
        detail: 'carries no grounding tag (VERIFIED / DOCUMENTED / INFERRED / UNVERIFIED)',
        fix: claim.inline
          ? 'add a grade to the claim: UNVERIFIED, or a VERIFIED[...] tag from the evidence bundle'
          : 'add the line below under it - or a VERIFIED[<id>] grounding citing a run from the evidence bundle:\n**Grounding**: UNVERIFIED',
        ...where,
      })
      return
    }

    const gradeLine = claim.gradeLine!
    // The grounding line can carry part of the sentence ("VERIFIED[id] - typecheck passes").
    // The bracket itself is not part of it: `passed>=71` inside a tag is a
    // predicate, not the word "passed", and must not make a failure claim read
    // as a success claim.
    const sentence = claim.inline || gradeLine === claim.line ? claim.text : claim.text + ' ' + lines[gradeLine]
    const claimText = claim.gradeBracket ? sentence.replace(claim.gradeBracket, '') : sentence

    if (claim.grade === 'VERIFIED' && claim.gradeMalformed !== undefined) {
      findings.push({
        level: 'error',
        code: 'claims/malformed-address',
        claim: claim.text,
        detail:
          'VERIFIED' + claim.gradeMalformed + ' is not an address - write VERIFIED[<kind>-<6 hex>] or ' +
          'VERIFIED[<kind>-<6 hex>: <key><op><value>, ...]',
        // The id the writer meant is usually inside the bracket - a missing
        // colon, a placeholder left beside it - and its run says the rest.
        fix: fixes.grounding(fixes.byId(MENTIONED_ID_RE.exec(claim.gradeMalformed)?.[0]), claim.inline) ?? fixes.orCite(),
        ...where,
      })
      return
    }

    if (claim.grade === 'VERIFIED' && claim.gradeId) {
      const artifact = artifacts.find((a) => a.id === claim.gradeId)
      // A run of the kind the id names, at the commit under review, is what
      // the writer was most likely reaching for - offered only when there is
      // exactly one, since choosing between two is the judgement a fix must
      // not make for anyone.
      const sameKind = fixes.ofKind([claim.gradeId.split('-')[0]!], opts.expectedHeadSha)
      const instead = sameKind.length === 1 ? fixes.ready(sameKind[0]!, claim.inline) : undefined
      if (!artifact) {
        findings.push({
          level: 'error',
          code: 'claims/unknown-artifact',
          claim: claim.text,
          detail:
            'VERIFIED[' + claim.gradeId + '] references an artifact that does not exist in ' +
            (opts.artifactSourceName ?? 'this document'),
          fix: instead ?? fixes.orCite(),
          ...where,
        })
        return
      }
      if (opts.expectedHeadSha && artifact.commit && !opts.expectedHeadSha.startsWith(artifact.commit)) {
        findings.push({
          level: 'error',
          code: 'claims/wrong-commit',
          claim: claim.text,
          detail:
            'VERIFIED[' +
            claim.gradeId +
            '] was collected at ' +
            artifact.commit +
            ', but this review is about ' +
            opts.expectedHeadSha.slice(0, 7),
          fix: instead ?? 'gather the evidence again at ' + opts.expectedHeadSha.slice(0, 7) + ' and cite the new run - or mark the claim UNVERIFIED',
          ...where,
        })
        return
      }
      const usage = idUsage.get(claim.gradeId) ?? { count: 0, lastLine: claim.line }
      usage.count += 1
      usage.lastLine = claim.line
      idUsage.set(claim.gradeId, usage)
      const parsed = claim.gradePredicates !== undefined ? parsePredicates(claim.gradePredicates) : undefined
      if (parsed && parsed.problems.length > 0) {
        findings.push({
          level: 'error',
          code: 'claims/bad-predicate',
          claim: claim.text,
          detail: 'VERIFIED[' + claim.gradeId + '] has predicates that cannot be checked: ' + parsed.problems.join('; '),
          fix: fixes.grounding(artifact, claim.inline) ?? 'mark the claim UNVERIFIED',
          ...where,
        })
        return
      }
      const mismatch = citedProblem(artifact, claimText, claim.inline, opts.expectedHeadSha)
      if (mismatch) {
        findings.push({ ...mismatch, detail: 'VERIFIED[' + claim.gradeId + '] ' + mismatch.detail, claim: claim.text, ...where })
        return
      }
      // In addition to the outcome rules, never instead of them: a weak
      // predicate (`exit=0` over a run that checked nothing) does not get a
      // claim past a rule it would otherwise fail.
      const unmet = parsed ? evaluatePredicates(parsed.predicates, artifact) : []
      if (unmet.length > 0) {
        findings.push({
          level: 'error',
          code: 'claims/predicate-unmet',
          claim: claim.text,
          detail: 'VERIFIED[' + claim.gradeId + '] ' + unmet.join('; '),
          fix: fixes.ready(artifact, claim.inline) ?? 'mark the claim UNVERIFIED',
          ...where,
        })
        return
      }
      findings.push({
        level: 'pass',
        code: 'claims/verified',
        claim: claim.text,
        detail:
          'VERIFIED by `' + artifact.command + '` (exit ' + artifact.exitCode + '), addressed as ' + claim.gradeId +
          (parsed ? ', and ' + parsed.predicates.map((p) => p.text).join(', ') + ' hold' : ''),
        ...where,
      })
      return
    }

    if (claim.grade === 'VERIFIED') {
      const idx = artifacts.findIndex(
        (a, i) => !consumedByPosition.has(i) && a.start > gradeLine && a.start - gradeLine <= ARTIFACT_WINDOW,
      )
      if (idx === -1) {
        findings.push({
          level: 'error',
          code: 'claims/no-nearby-artifact',
          claim: claim.text,
          detail: 'VERIFIED, but no valid artifact block within ' + ARTIFACT_WINDOW + ' lines',
          fix: fixes.orCite(),
          ...where,
        })
        return
      }
      consumedByPosition.add(idx)
      const mismatch = citedProblem(artifacts[idx]!, claimText, claim.inline, opts.expectedHeadSha)
      if (mismatch) {
        findings.push({ ...mismatch, detail: 'VERIFIED ' + mismatch.detail, claim: claim.text, ...where })
        return
      }
      findings.push({
        level: 'pass',
        code: 'claims/verified-nearby',
        claim: claim.text,
        detail: 'VERIFIED by `' + artifacts[idx]!.command + '` (exit ' + artifacts[idx]!.exitCode + ')',
        ...where,
      })
      findings.push({
        level: 'warning',
        code: 'claims/bare-verified',
        claim: claim.text,
        detail:
          'bare VERIFIED only confirms a block is nearby, not that it is the block this claim is about - ' +
          'use VERIFIED[id] instead (see docs/decisions/0002-evidence-layer-v2.md for the cutover date)',
        ...(artifacts[idx]!.id !== undefined && { fix: fixes.grounding(artifacts[idx], claim.inline) }),
        ...where,
      })
      return
    }

    if (claim.grade === 'DOCUMENTED') {
      const window = claim.inline ? claim.text : lines.slice(gradeLine, Math.min(gradeLine + 2, lines.length)).join(' ')
      const ok = CITATION_RE.test(window)
      findings.push({
        level: ok ? 'pass' : 'error',
        code: ok ? 'claims/documented' : 'claims/uncited',
        claim: claim.text,
        detail: ok ? 'DOCUMENTED with a citation' : 'DOCUMENTED, but cites nothing (URL, § section, or issue id)',
        ...(!ok && {
          fix:
            'add a citation beside the tag - a URL, a § section, an issue id like #12, or a file in backticks like ' +
            '`docs/notes.md` - or mark the claim UNVERIFIED',
        }),
        ...where,
      })
      return
    }

    if (claim.grade === 'INFERRED' && claim.inline) {
      const words = (claimText.replace(/\bINFERRED\b/, '').match(/[\p{L}\p{N}]+/gu) ?? []).length
      const ok = words >= INLINE_REASON_WORDS
      findings.push({
        level: ok ? 'pass' : 'error',
        code: ok ? 'claims/reasoned' : 'claims/no-reason',
        claim: claim.text,
        detail: ok
          ? 'INFERRED inline, with its reason beside the tag'
          : 'INFERRED inline, but nothing beside the tag says why - a bare tag is not a reason (' +
            INLINE_REASON_WORDS + ' or more words are required)',
        ...(!ok && { fix: 'write the reason beside the tag, in ' + INLINE_REASON_WORDS + ' or more words - or mark the claim UNVERIFIED' }),
        ...where,
      })
      return
    }

    if (claim.grade === 'INFERRED') {
      const steps = lines
        .slice(gradeLine + 1, nextClaimLine)
        .filter((l, i) => !fenced.has(gradeLine + 1 + i) && NUMBERED_STEP_RE.test(l)).length
      findings.push({
        level: steps >= 2 ? 'pass' : 'error',
        code: steps >= 2 ? 'claims/inferred' : 'claims/short-chain',
        claim: claim.text,
        detail:
          steps >= 2
            ? 'INFERRED with a ' + steps + '-step chain'
            : 'INFERRED, but shows ' + steps + ' numbered step(s) - two or more are required',
        ...(steps < 2 && {
          fix: 'add two or more numbered steps below the grounding line, one per line (`1. ...`, `2. ...`) - or mark the claim UNVERIFIED',
        }),
        ...where,
      })
      return
    }

    findings.push({
      level: 'pass',
      code: 'claims/unverified',
      claim: claim.text,
      detail: 'UNVERIFIED, and says so - which is the honest outcome, not a failure',
      ...where,
    })
  }

  claims.forEach((claim, index) => grade(claim, claims[index + 1]?.line ?? lines.length))
  // After the blocks, so a bare VERIFIED block keeps first call on the artifact
  // below it, as it had before inline claims existed.
  for (const claim of inlineClaims) grade(claim, claim.line + 1)

  // Shotgun: one artifact backing suspiciously many claims is the addressed
  // form's equivalent of the wrong-block-copied-in problem - a warning by
  // default, since a small handful of closely related claims sharing one
  // artifact is sometimes legitimate.
  for (const [id, usage] of idUsage) {
    if (usage.count > SHOTGUN_THRESHOLD) {
      findings.push({
        level: 'warning',
        code: 'claims/shotgun',
        claim: 'artifact ' + id + ' backs ' + usage.count + ' claims',
        detail: 'each artifact should back at most ' + SHOTGUN_THRESHOLD + ' - consider gathering separate evidence',
        fix: 'keep the claims ' + id + ' actually shows, and mark the others UNVERIFIED',
        file,
        line: usage.lastLine + 1,
      })
    }
  }

  if (opts.prose !== false) findings.push(...lintProse(lines, fenced, file))
  return findings
}

function groupById(artifacts: ArtifactBlock[]): Map<string, ArtifactBlock[]> {
  const groups = new Map<string, ArtifactBlock[]>()
  for (const a of artifacts) {
    if (!a.id) continue
    groups.set(a.id, [...(groups.get(a.id) ?? []), a])
  }
  return groups
}

// An artifact id anywhere in a malformed bracket - the one the writer meant.
const MENTIONED_ID_RE = new RegExp(ARTIFACT_ID_RE.source.slice(1, -1))

/** What a finding's fix may offer, over the runs a claim could cite. */
interface Fixes {
  byId(id: string | undefined): ArtifactBlock | undefined
  /** Runs of one of these kinds, collected at this commit when one is given, that back a claim. */
  ofKind(kinds: string[], commit: string | undefined): ArtifactBlock[]
  /** The claim and grounding the run backs, as replacement lines - `undefined` for a run that backs none. */
  ready(block: ArtifactBlock, inline: boolean | undefined): string | undefined
  /** The grounding line citing the run with its own predicates - `undefined` for a block with no id. */
  grounding(block: ArtifactBlock | undefined, inline: boolean | undefined): string | undefined
  /** The fix when no one run fits: say less, or cite one of these runs (default: every run that backs a claim). */
  orCite(blocks?: ArtifactBlock[]): string
}

/**
 * The fixes a finding can offer. Every replacement is read off a run - the
 * skeleton's sentence, the run's own predicates - never off the claim being
 * fixed, so applying one cannot carry the original mistake forward. The lines
 * to paste always come last, after a colon, so the instruction and the text
 * cannot be mistaken for each other; the alternative of marking the claim
 * UNVERIFIED is on the instruction line, because it is always there.
 */
function fixer(resolvable: ArtifactBlock[], suggestable: ArtifactBlock[]): Fixes {
  const runs = new Map<string, { block: ArtifactBlock; copy: boolean }>()
  for (const block of resolvable) if (block.id && !runs.has(block.id)) runs.set(block.id, { block, copy: false })
  for (const block of suggestable) if (block.id && !runs.has(block.id)) runs.set(block.id, { block, copy: true })
  const backsAClaim = (block: ArtifactBlock): boolean => block.id !== undefined && suggestedClaim({ ...block, id: block.id }) !== null
  // A run from `suggestFrom` is not in the checked text, so citing it there
  // means copying its block in as well.
  const copy = (block: ArtifactBlock): string =>
    runs.get(block.id!)?.copy ? ', and copy the ' + block.id + ' block from the evidence bundle into the review unedited' : ''
  const replace = (what: string, block: ArtifactBlock, lines: string[]): string =>
    'replace ' + what + ' with the line' + (lines.length > 1 ? 's' : '') + ' below' + copy(block) + ' - or mark the claim UNVERIFIED:\n' + lines.join('\n')
  const tag = (block: ArtifactBlock): string => 'VERIFIED[' + block.id + ': ' + suggestPredicates(block) + ']'

  return {
    byId: (id) => (id === undefined ? undefined : runs.get(id)?.block),
    ofKind: (kinds, commit) =>
      [...runs.values()]
        .map((r) => r.block)
        .filter((b) => backsAClaim(b) && kinds.includes(classifyCommand(b.command)) && (!commit || !b.commit || commit.startsWith(b.commit))),
    ready: (block, inline) => {
      if (block.id === undefined) return undefined
      const pair = suggestedClaim({ ...block, id: block.id })
      if (!pair) return undefined
      // A claim found inline has no Grounding line of its own: its sentence and tag are one cell.
      return inline
        ? replace('the claim', block, [pair.claim.replace('**Claim**: ', '') + ' ' + tag(block)])
        : replace('the claim and its grounding', block, [pair.claim, pair.grounding])
    },
    grounding: (block, inline) => {
      if (block?.id === undefined) return undefined
      return inline ? replace('the tag', block, [tag(block)]) : replace('the grounding', block, ['**Grounding**: ' + tag(block)])
    },
    orCite: (blocks) => {
      const ids = (blocks ?? [...runs.values()].map((r) => r.block)).filter(backsAClaim).map((b) => b.id!)
      return ids.length > 0
        ? 'mark the claim UNVERIFIED, or cite one of these runs as VERIFIED[<id>]: ' + ids.join(', ')
        : 'mark the claim UNVERIFIED, or gather evidence and cite a run from it'
    },
  }
}

/**
 * The codes `downgradeClaims` settles. Each says a claim's grade is not backed
 * - the wrong run, the wrong number, a citation that does not resolve - so
 * marking the claim UNVERIFIED states exactly what is true about it. The
 * prose rules are not here: they are about a line, not a claim's grade.
 */
const DOWNGRADED = new Set<string>([
  'claims/untagged',
  'claims/malformed-address',
  'claims/unknown-artifact',
  'claims/wrong-commit',
  'claims/bad-predicate',
  'claims/kind-mismatch',
  'claims/outcome-mismatch',
  'claims/count-mismatch',
  'claims/predicate-unmet',
  'claims/no-nearby-artifact',
  'claims/uncited',
  'claims/short-chain',
  'seal/not-gathered',
  'seal/edited',
])

/** One claim `downgradeClaims` marked UNVERIFIED: its 1-based line, the grade it had, and the finding that failed it. */
export interface Downgrade {
  line: number
  from: string
  code: string
}

/**
 * Marks every claim an error finding failed UNVERIFIED, and returns the text
 * with what changed. The one fix that needs no judgement: the claim stays,
 * worded as written, and its grade says what is true - nothing backs it.
 * Never the other way: nothing here edits a sentence or a predicate to fit
 * its run, which would make a claim pass by changing what it says.
 *
 * A `seal/` finding names its id once, at the first claim citing it, so every
 * claim citing that id is downgraded with it. A claim with no grade gets a
 * `**Grounding**: UNVERIFIED` line below it. Line endings are kept as found.
 */
export function downgradeClaims(markdown: string, findings: CodedFinding[], gradeWindow = GRADE_WINDOW): { markdown: string; downgraded: Downgrade[] } {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  const claims = findClaims(lines, fencedLineNumbers(lines), gradeWindow)
  const failing = new Map<number, string>()
  const failedIds = new Map<string, string>()
  for (const f of findings) {
    if (f.level !== 'error' || !DOWNGRADED.has(f.code) || f.line === undefined) continue
    const claim = claims.find((c) => c.line === f.line! - 1)
    if (!claim) continue
    if (f.code.startsWith('seal/') && claim.gradeId) failedIds.set(claim.gradeId, f.code)
    else if (!failing.has(claim.line)) failing.set(claim.line, f.code)
  }
  for (const claim of claims) {
    const code = claim.gradeId !== undefined ? failedIds.get(claim.gradeId) : undefined
    if (code && !failing.has(claim.line)) failing.set(claim.line, code)
  }

  const downgraded: Downgrade[] = []
  // Bottom up, so a line inserted below one claim moves none of the claims still to come.
  for (const claim of [...claims].reverse()) {
    const code = failing.get(claim.line)
    if (!code) continue
    if (!claim.grade) {
      lines.splice(claim.line + 1, 0, '**Grounding**: UNVERIFIED')
      downgraded.push({ line: claim.line + 1, from: '(no grade)', code })
      continue
    }
    const line = lines[claim.gradeLine!]!
    const found = GRADE_RE.exec(line)!
    lines[claim.gradeLine!] = line.slice(0, found.index) + 'UNVERIFIED' + line.slice(found.index + found[0].length)
    downgraded.push({ line: claim.line + 1, from: found[0], code })
  }
  return { markdown: lines.join(eol), downgraded: downgraded.reverse() }
}

/**
 * Rules that apply to the prose rather than to a tagged claim.
 *
 * Everything inside a fenced block is skipped. A review that quotes a bad
 * example, or pastes a diff containing the word "works", is not asserting it -
 * and a checker that cries wolf gets switched off, after which you have nothing.
 *
 * Deliberately does not flag untagged, ordinary taste ("this will be hard to
 * maintain") - see `docs/evidence-layer.md` § What this does not do. The banned
 * patterns below are banned because nothing could contradict them, not because
 * an opinion was expressed; see `demo/reviews/boundary-limits.md` for both
 * halves of that boundary, executable rather than left as a paragraph of prose.
 */
export function lintProse(lines: string[], fenced: Set<number>, file: string): CodedFinding[] {
  const findings: CodedFinding[] = []
  const nearby = (i: number, re: RegExp, radius = 3): boolean =>
    lines
      .slice(Math.max(0, i - radius), Math.min(lines.length, i + radius + 1))
      .some((l) => re.test(l))

  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue
    const line = lines[i]!
    const where = { file, line: i + 1 }

    const vague = VAGUE_COMPARATIVE_RE.exec(line) ?? UNCHECKED_EQUIVALENCE_RE.exec(line)
    if (vague && !nearby(i, /\bUNVERIFIED\b/, 1)) {
      findings.push({
        level: 'error',
        code: 'claims/vague-comparison',
        claim: '"' + vague[0].trim() + '"',
        detail: 'compared to what, measured how? Back it or tag the line UNVERIFIED',
        fix: 'say what was measured against what, or add UNVERIFIED to this line',
        ...where,
      })
    }

    const success = SUCCESS_WORD_RE.exec(line)
    if (
      success &&
      !CLAIM_RE.test(line) &&
      !/\*\*Grounding\*\*/.test(line) &&
      !HYPOTHETICAL_RE.test(line) &&
      !nearby(i, EFFECT_RE)
    ) {
      findings.push({
        level: 'error',
        code: 'claims/success-without-effect',
        claim: '"' + success[0] + '"',
        detail: 'a success claim with no stated effect - add `**Effect**:` saying what changed and how you know',
        fix: 'add an `**Effect**:` line within three lines of this one, saying what changed and how you know - or drop the word',
        ...where,
      })
    }

    if (SYCOPHANCY_RES.some((re) => re.test(line))) {
      findings.push({
        level: 'warning',
        code: 'claims/sycophancy',
        claim: line.trim().slice(0, 60),
        detail: 'agreement is not evidence - revise on evidence, not on pressure',
        ...where,
      })
    }
  }
  return findings
}
