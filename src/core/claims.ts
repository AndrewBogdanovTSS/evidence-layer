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
 * It does check the outcome, where the outcome is mechanical: a claim that
 * reads as success cannot rest on a run that exited non-zero, a run that was
 * stopped before it finished backs only "did not complete", and a lint or test
 * run whose work summary shows it checked nothing backs no success claim - see
 * `outcomeProblem`.
 *
 * What this does not do: it does not verify that an artifact's output actually
 * supports the meaning of the claim next to it - that requires reading the
 * output for sense, which is a probabilistic judgement, and putting one inside
 * a deterministic checker reintroduces exactly the circular validation this
 * layer exists to avoid. Beyond the outcome rules above, it guarantees only
 * that the artifact exists, was collected here, and was pointed at on purpose
 * rather than left nearby.
 */
import { ARTIFACT_ID_RE, classifyCommand, fencedLineNumbers, findArtifactBlocks, parseWorkSummary, workDone } from './artifact'
import type { ArtifactBlock, StopReason } from './artifact'
import type { Finding } from './cli'
import { evaluatePredicates, parsePredicates } from './predicates'

/** How far below a legacy (unaddressed) VERIFIED tag its artifact block is allowed to sit. */
export const ARTIFACT_WINDOW = 15

/** A single artifact id is allowed to back this many claims before it is a warning, not a pass. */
export const SHOTGUN_THRESHOLD = 2

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
}

export function findClaims(lines: string[], fenced: Set<number>): Claim[] {
  const claims: Claim[] = []
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i) || !CLAIM_RE.test(lines[i]!)) continue
    const claim: Claim = { line: i, text: lines[i]!.replace(CLAIM_RE, '').trim() }
    // The grade lives on the claim line or within the next two lines - close
    // enough that a reader always sees them together.
    for (let j = i; j <= Math.min(i + 2, lines.length - 1); j++) {
      const found = GRADE_RE.exec(lines[j]!)
      if (found) {
        claim.grade = found[1] as Grade
        claim.gradeLine = j
        const bracket = found[2]
        // Only VERIFIED is addressed; a bracket after any other grade is prose.
        if (bracket !== undefined && claim.grade === 'VERIFIED') {
          claim.gradeBracket = bracket
          const address = ADDRESS_RE.exec(bracket)
          if (address) {
            claim.gradeId = address[1]
            if (address[2] !== undefined) claim.gradePredicates = address[2]
          } else {
            claim.gradeMalformed = bracket
          }
        }
        break
      }
    }
    claims.push(claim)
  }
  return claims
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
   * Apply the prose rules (vague comparatives, success words with no stated
   * effect). Default `true`. Off for a conversational reply, where ordinary
   * prose is not graded and only `**Claim**:` lines are.
   */
  prose?: boolean
}

export function lintClaims(markdown: string, file: string, opts: LintOptions = {}): Finding[] {
  const lines = markdown.split(/\r?\n/)
  const fenced = fencedLineNumbers(lines)
  const claims = findClaims(lines, fenced)
  const artifacts = [
    ...findArtifactBlocks(lines),
    ...(opts.artifactSource !== undefined ? findArtifactBlocks(opts.artifactSource.split(/\r?\n/)) : []),
  ]
  const findings: Finding[] = []

  if (claims.length === 0 && opts.prose !== false) {
    findings.push({
      level: 'warning',
      claim: 'the review states claims',
      detail: 'no `**Claim**:` lines found - nothing here can be checked',
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
        claim: 'artifact ' + id + ' is one artifact',
        detail:
          id + ' labels ' + bodies.size + ' different blocks (lines ' + blocks.map((b) => b.start + 1).join(', ') +
          ') - an id is an address, and an address names one thing. Regenerate the evidence rather than editing a block',
        file,
        line: blocks[1]!.start + 1,
      })
    }
  }

  // Legacy proximity mode may still consume an artifact positionally, so two
  // unaddressed VERIFIED tags cannot silently share one block either.
  const consumedByPosition = new Set<number>()
  // Addressed mode: how many claims point at each id, for the shotgun check.
  const idUsage = new Map<string, { count: number; lastLine: number }>()

  claims.forEach((claim, index) => {
    const where = { file, line: claim.line + 1 }
    const nextClaimLine = claims[index + 1]?.line ?? lines.length

    if (!claim.grade) {
      findings.push({
        level: 'error',
        claim: claim.text,
        detail: 'carries no grounding tag (VERIFIED / DOCUMENTED / INFERRED / UNVERIFIED)',
        ...where,
      })
      return
    }

    const gradeLine = claim.gradeLine!
    // The grounding line can carry part of the sentence ("VERIFIED[id] - typecheck passes").
    // The bracket itself is not part of it: `passed>=71` inside a tag is a
    // predicate, not the word "passed", and must not make a failure claim read
    // as a success claim.
    const sentence = gradeLine === claim.line ? claim.text : claim.text + ' ' + lines[gradeLine]
    const claimText = claim.gradeBracket ? sentence.replace(claim.gradeBracket, '') : sentence

    if (claim.grade === 'VERIFIED' && claim.gradeMalformed !== undefined) {
      findings.push({
        level: 'error',
        claim: claim.text,
        detail:
          'VERIFIED' + claim.gradeMalformed + ' is not an address - write VERIFIED[<kind>-<6 hex>] or ' +
          'VERIFIED[<kind>-<6 hex>: <key><op><value>, ...]',
        ...where,
      })
      return
    }

    if (claim.grade === 'VERIFIED' && claim.gradeId) {
      const artifact = artifacts.find((a) => a.id === claim.gradeId)
      if (!artifact) {
        findings.push({
          level: 'error',
          claim: claim.text,
          detail: 'VERIFIED[' + claim.gradeId + '] references an artifact that does not exist in this document',
          ...where,
        })
        return
      }
      if (opts.expectedHeadSha && artifact.commit && !opts.expectedHeadSha.startsWith(artifact.commit)) {
        findings.push({
          level: 'error',
          claim: claim.text,
          detail:
            'VERIFIED[' +
            claim.gradeId +
            '] was collected at ' +
            artifact.commit +
            ', but this review is about ' +
            opts.expectedHeadSha.slice(0, 7),
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
          claim: claim.text,
          detail: 'VERIFIED[' + claim.gradeId + '] has predicates that cannot be checked: ' + parsed.problems.join('; '),
          ...where,
        })
        return
      }
      const problem = outcomeProblem(artifact, claimText, opts)
      if (problem) {
        findings.push({ level: 'error', claim: claim.text, detail: 'VERIFIED[' + claim.gradeId + '] ' + problem, ...where })
        return
      }
      // In addition to the outcome rules, never instead of them: a weak
      // predicate (`exit=0` over a run that checked nothing) does not get a
      // claim past a rule it would otherwise fail.
      const unmet = parsed ? evaluatePredicates(parsed.predicates, artifact) : []
      if (unmet.length > 0) {
        findings.push({ level: 'error', claim: claim.text, detail: 'VERIFIED[' + claim.gradeId + '] ' + unmet.join('; '), ...where })
        return
      }
      findings.push({
        level: 'pass',
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
          claim: claim.text,
          detail: 'VERIFIED, but no valid artifact block within ' + ARTIFACT_WINDOW + ' lines',
          ...where,
        })
        return
      }
      consumedByPosition.add(idx)
      const problem = outcomeProblem(artifacts[idx]!, claimText, opts)
      if (problem) {
        findings.push({ level: 'error', claim: claim.text, detail: 'VERIFIED ' + problem, ...where })
        return
      }
      findings.push({
        level: 'pass',
        claim: claim.text,
        detail: 'VERIFIED by `' + artifacts[idx]!.command + '` (exit ' + artifacts[idx]!.exitCode + ')',
        ...where,
      })
      findings.push({
        level: 'warning',
        claim: claim.text,
        detail:
          'bare VERIFIED only confirms a block is nearby, not that it is the block this claim is about - ' +
          'use VERIFIED[id] instead (see docs/decisions/0002-evidence-layer-v2.md for the cutover date)',
        ...where,
      })
      return
    }

    if (claim.grade === 'DOCUMENTED') {
      const window = lines.slice(gradeLine, Math.min(gradeLine + 2, lines.length)).join(' ')
      const ok = CITATION_RE.test(window)
      findings.push({
        level: ok ? 'pass' : 'error',
        claim: claim.text,
        detail: ok ? 'DOCUMENTED with a citation' : 'DOCUMENTED, but cites nothing (URL, § section, or issue id)',
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
        claim: claim.text,
        detail:
          steps >= 2
            ? 'INFERRED with a ' + steps + '-step chain'
            : 'INFERRED, but shows ' + steps + ' numbered step(s) - two or more are required',
        ...where,
      })
      return
    }

    findings.push({
      level: 'pass',
      claim: claim.text,
      detail: 'UNVERIFIED, and says so - which is the honest outcome, not a failure',
      ...where,
    })
  })

  // Shotgun: one artifact backing suspiciously many claims is the addressed
  // form's equivalent of the wrong-block-copied-in problem - a warning by
  // default, since a small handful of closely related claims sharing one
  // artifact is sometimes legitimate.
  for (const [id, usage] of idUsage) {
    if (usage.count > SHOTGUN_THRESHOLD) {
      findings.push({
        level: 'warning',
        claim: 'artifact ' + id + ' backs ' + usage.count + ' claims',
        detail: 'each artifact should back at most ' + SHOTGUN_THRESHOLD + ' - consider gathering separate evidence',
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
export function lintProse(lines: string[], fenced: Set<number>, file: string): Finding[] {
  const findings: Finding[] = []
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
        claim: '"' + vague[0].trim() + '"',
        detail: 'compared to what, measured how? Back it or tag the line UNVERIFIED',
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
        claim: '"' + success[0] + '"',
        detail: 'a success claim with no stated effect - add `**Effect**:` saying what changed and how you know',
        ...where,
      })
    }

    if (SYCOPHANCY_RES.some((re) => re.test(line))) {
      findings.push({
        level: 'warning',
        claim: line.trim().slice(0, 60),
        detail: 'agreement is not evidence - revise on evidence, not on pressure',
        ...where,
      })
    }
  }
  return findings
}
