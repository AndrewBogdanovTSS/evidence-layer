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
 * What this does not do: it does not verify that an artifact's output actually
 * supports the meaning of the claim next to it - that requires reading the
 * output for sense, which is a probabilistic judgement, and putting one inside
 * a deterministic checker reintroduces exactly the circular validation this
 * layer exists to avoid. It guarantees only that the artifact exists, was
 * collected here, and was pointed at on purpose rather than left nearby.
 */
import { fencedLineNumbers, findArtifactBlocks } from './artifact'
import type { Finding } from './cli'

/** How far below a legacy (unaddressed) VERIFIED tag its artifact block is allowed to sit. */
export const ARTIFACT_WINDOW = 15

/** A single artifact id is allowed to back this many claims before it is a warning, not a pass. */
export const SHOTGUN_THRESHOLD = 2

export const GRADES = ['VERIFIED', 'DOCUMENTED', 'INFERRED', 'UNVERIFIED'] as const
export type Grade = (typeof GRADES)[number]

const CLAIM_RE = /^\s*\*\*Claim\*\*:/
// Built from GRADES so the list of grades exists in exactly one place, with an
// optional `[id]` suffix for the addressed VERIFIED form.
const GRADE_RE = new RegExp('\\b(' + GRADES.join('|') + ')(?:\\[([a-z]+-[0-9a-f]{6})\\])?')
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

interface Claim {
  /** 0-based line of the `**Claim**:` line. */
  line: number
  text: string
  grade?: Grade
  /** Present only for the addressed `VERIFIED[id]` form. */
  gradeId?: string
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
        claim.gradeId = found[2]
        claim.gradeLine = j
        break
      }
    }
    claims.push(claim)
  }
  return claims
}

export interface LintOptions {
  /** The commit the review claims to be about, when known - enables the id/commit mismatch check. */
  expectedHeadSha?: string
}

export function lintClaims(markdown: string, file: string, opts: LintOptions = {}): Finding[] {
  const lines = markdown.split(/\r?\n/)
  const fenced = fencedLineNumbers(lines)
  const claims = findClaims(lines, fenced)
  const artifacts = findArtifactBlocks(lines)
  const findings: Finding[] = []

  if (claims.length === 0) {
    findings.push({
      level: 'warning',
      claim: 'the review states claims',
      detail: 'no `**Claim**:` lines found - nothing here can be checked',
      file,
    })
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
      findings.push({
        level: 'pass',
        claim: claim.text,
        detail: 'VERIFIED by `' + artifact.command + '` (exit ' + artifact.exitCode + '), addressed as ' + claim.gradeId,
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

  findings.push(...lintProse(lines, fenced, file))
  return findings
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
