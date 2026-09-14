/**
 * `check:receipt` core - was this review written against this repo?
 *
 * The claim it makes falsifiable: **"I read the code."**
 *
 * A review states, in a fixed block at the top, where it read from: the commit,
 * the baseline it diffed against, how many files the diff touched, how many it
 * opened, and - since v2 - one verbatim quote **per file the review actually
 * cites**, not just one quote overall. A single quote proved *a* file was
 * opened; with a thirty-file diff that is the cheapest file to quote, not the
 * ones the review talks about, and the requirement was satisfied without
 * tying the proof to anything the review actually said. See
 * `demo/reviews/bad-receipt.md`, which already demonstrated the gap by
 * accident before this file existed to name it.
 *
 * The check that matters most is still the baseline. `git diff base...head` is
 * only as honest as `base`, and a local branch reference goes stale silently:
 * it still looks like a mainline, the diff still reconciles with itself, and
 * the review simply describes a much larger change than the one under review.
 * It fails in the reassuring direction, because the diff comes out *bigger*, so
 * nothing looks missing.
 *
 * So the baseline is checked by **equality** against `merge-base origin/<target>
 * <head>`, never by ancestry: a stale local tip is still an ancestor of the
 * mainline, so an ancestry check waves it straight through.
 */
import type { Finding } from './cli'
import { capture } from './proc'

export interface Sample {
  path: string
  line: string
}

export interface Receipt {
  branch?: string
  headSha?: string
  targetBranch?: string
  baseSha?: string
  filesInDiff?: number
  filesOpened?: number
  /** First sample found, kept for backward compatibility with single-quote receipts. */
  samplePath?: string
  sampleLine?: string
  /** Every `**Sample integrity**:` line in the document. */
  samples: Sample[]
}

const SAMPLE_RE = /^\s*\*\*Sample integrity\*\*:\s*`([^`]+)`\s*->\s*`(.*)`\s*$/gim

/** Reads `**Field**: value` pairs out of the receipt block. */
export function parseReceipt(markdown: string): Receipt {
  const field = (name: string): string | undefined => {
    const re = new RegExp('^\\s*\\*\\*' + name + '\\*\\*:\\s*(.+)$', 'im')
    return re.exec(markdown)?.[1]?.trim().replace(/^`|`$/g, '')
  }
  const num = (name: string): number | undefined => {
    const raw = field(name)
    return raw === undefined ? undefined : Number(raw.replace(/[^\d]/g, ''))
  }

  const samples: Sample[] = []
  let m: RegExpExecArray | null
  SAMPLE_RE.lastIndex = 0
  while ((m = SAMPLE_RE.exec(markdown)) !== null) samples.push({ path: m[1]!, line: m[2]! })

  return {
    branch: field('Branch'),
    headSha: field('HEAD SHA'),
    targetBranch: field('Target branch'),
    baseSha: field('Base SHA'),
    filesInDiff: num('Files in diff'),
    filesOpened: num('Files opened during review'),
    samplePath: samples[0]?.path,
    sampleLine: samples[0]?.line,
    samples,
  }
}

const SHA_RE = /^[0-9a-f]{40}$/

/** Every `path:line` citation in the document, deduplicated, in first-seen order. */
export function citedPaths(markdown: string): string[] {
  const seen: string[] = []
  const re = /`([\w./@-]+\.[a-z]+):(\d+)`/g
  let match: RegExpExecArray | null
  while ((match = re.exec(markdown)) !== null) {
    if (!seen.includes(match[1]!)) seen.push(match[1]!)
  }
  return seen
}

export function checkReceipt(
  receipt: Receipt,
  markdown: string,
  repo: string,
  expectedSha?: string,
): Finding[] {
  const findings: Finding[] = []

  // 1. Completeness. A missing field is not a small problem: the whole point of
  //    the receipt is that a reader can re-derive every value.
  const required: [keyof Receipt, string][] = [
    ['branch', 'Branch'],
    ['headSha', 'HEAD SHA'],
    ['targetBranch', 'Target branch'],
    ['baseSha', 'Base SHA'],
    ['filesInDiff', 'Files in diff'],
    ['filesOpened', 'Files opened during review'],
  ]
  for (const [key, label] of required) {
    if (receipt[key] === undefined || receipt[key] === '') {
      findings.push({ level: 'error', claim: 'receipt records ' + label, detail: 'field missing or unparseable' })
    }
  }
  if (receipt.samples.length === 0) {
    findings.push({ level: 'error', claim: 'receipt records Sample integrity', detail: 'no Sample integrity line found' })
  }
  if (!receipt.headSha || !SHA_RE.test(receipt.headSha)) {
    findings.push({ level: 'error', claim: 'HEAD SHA is a full 40-character commit id', detail: String(receipt.headSha) })
    return findings
  }

  // 2. The commit exists here. Cheap proof the reviewer had a real clone.
  //    `git cat-file -t` rather than the more idiomatic `<sha>^{commit}`: on
  //    Windows the shell eats the caret, and the check then fails for everyone
  //    on that platform for a reason that has nothing to do with the review.
  const headExists = capture('git cat-file -t ' + receipt.headSha, repo) === 'commit'
  findings.push({
    level: headExists ? 'pass' : 'error',
    claim: 'HEAD SHA ' + receipt.headSha.slice(0, 10) + ' exists in this repository',
    detail: headExists ? 'found' : 'unknown commit - the review was not written against this repo',
  })

  // 3. It is the commit somebody else expected, when somebody else knows.
  if (expectedSha) {
    findings.push({
      level: receipt.headSha === expectedSha ? 'pass' : 'error',
      claim: 'the review is about the expected commit',
      detail: receipt.headSha === expectedSha ? 'matches --sha' : 'receipt says ' + receipt.headSha + ', expected ' + expectedSha,
    })
  }

  findings.push(...checkBase(receipt, repo))
  findings.push(...checkSamples(receipt, markdown, repo))
  findings.push(...checkCitations(markdown, receipt.headSha, repo))

  // 6. Coverage. Not an error - a reviewer may legitimately skip generated
  //    files - but an unexplained gap is worth saying out loud.
  if (receipt.filesInDiff !== undefined && receipt.filesOpened !== undefined) {
    const ok = receipt.filesOpened >= receipt.filesInDiff
    findings.push({
      level: ok ? 'pass' : 'warning',
      claim: 'every file in the diff was opened',
      detail: receipt.filesOpened + ' opened of ' + receipt.filesInDiff + ' in the diff',
    })
  }

  return findings
}

/** The baseline check. Equality, not ancestry - see the file header. */
export function checkBase(receipt: Receipt, repo: string): Finding[] {
  const claim = 'Base SHA is the merge-base with origin/' + (receipt.targetBranch ?? '?')
  if (!receipt.baseSha || !SHA_RE.test(receipt.baseSha) || !receipt.targetBranch) {
    return [{ level: 'error', claim, detail: 'base SHA or target branch missing' }]
  }

  const remoteRef = 'refs/remotes/origin/' + receipt.targetBranch
  if (!capture('git rev-parse --verify --quiet ' + remoteRef, repo)) {
    return [
      {
        level: 'unverifiable',
        claim,
        detail: 'no ' + remoteRef + ' in this clone - fetch it, or accept that this cannot be checked here',
      },
    ]
  }

  const mergeBase = capture('git merge-base origin/' + receipt.targetBranch + ' ' + receipt.headSha, repo)
  if (!mergeBase) {
    return [{ level: 'unverifiable', claim, detail: 'no merge-base found (shallow clone, or unrelated histories)' }]
  }
  if (mergeBase === receipt.baseSha) {
    return [{ level: 'pass', claim, detail: mergeBase.slice(0, 10) }]
  }

  // The interesting failure: the recorded base is the tip of a *local* branch of
  // the same name that has fallen behind. This is the 20x case - and an ancestry
  // check would have passed it, because a stale tip is still an ancestor.
  const localTip = capture('git rev-parse --verify --quiet refs/heads/' + receipt.targetBranch, repo)
  let detail = 'receipt says ' + receipt.baseSha.slice(0, 10) + ', merge-base is ' + mergeBase.slice(0, 10)
  if (localTip === receipt.baseSha) {
    const behind = capture(
      'git rev-list --count ' + receipt.baseSha + '..origin/' + receipt.targetBranch,
      repo,
    )
    detail =
      'the base is the tip of the LOCAL branch ' +
      receipt.targetBranch +
      ', which is ' +
      (behind ?? '?') +
      (behind === '1' ? ' commit behind origin/' : ' commits behind origin/') +
      receipt.targetBranch +
      '. Every one of those commits is being attributed to the branch under review.'
  }
  return [{ level: 'error', claim, detail }]
}

/**
 * v2: one verbatim quote per file the review actually cites, not one quote
 * overall. When the review cites no `path:line` at all, the pre-v2 rule still
 * applies - at least one sample, so a prose-only review is not exempted
 * entirely.
 */
export function checkSamples(receipt: Receipt, markdown: string, repo: string): Finding[] {
  const referenced = citedPaths(markdown)
  const targets = referenced.length > 0 ? referenced : receipt.samples.slice(0, 1).map((s) => s.path)
  if (targets.length === 0) {
    return [{ level: 'error', claim: 'at least one file was quoted verbatim', detail: 'no citations and no Sample integrity line' }]
  }

  return targets.map((path): Finding => {
    const claim = 'the cited file `' + path + '` was really read'
    const sample = receipt.samples.find((s) => s.path === path)
    if (!sample) {
      return { level: 'error', claim, detail: 'this review cites it, but no Sample integrity line quotes it', file: path }
    }
    const content = capture('git show ' + receipt.headSha + ':' + path, repo)
    if (content === null) {
      return { level: 'error', claim, detail: path + ' does not exist at that commit', file: path }
    }
    const firstLine = content.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
    const quoted = sample.line.trim()
    return {
      level: firstLine === quoted ? 'pass' : 'error',
      claim,
      detail:
        firstLine === quoted
          ? path + ' line 1 matches verbatim'
          : 'quoted "' + quoted + '"\n        actual "' + firstLine + '"',
      file: path,
    }
  })
}

/**
 * Every `path:line` citation in the review resolves at the reviewed commit.
 *
 * Citations are written in backticks so this can find them without guessing at
 * prose. A citation that does not resolve is the signature of a review that was
 * assembled rather than read.
 */
export function checkCitations(markdown: string, headSha: string, repo: string): Finding[] {
  const findings: Finding[] = []
  const re = /`([\w./@-]+\.[a-z]+):(\d+)`/g
  const seen = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = re.exec(markdown)) !== null) {
    const [, path, lineNo] = match
    const key = path + ':' + lineNo
    if (seen.has(key)) continue
    seen.add(key)

    const content = capture('git show ' + headSha + ':' + path, repo)
    if (content === null) {
      findings.push({ level: 'error', claim: 'citation ' + key, detail: 'no such file at the reviewed commit' })
      continue
    }
    const total = content.split('\n').length
    const line = Number(lineNo)
    findings.push({
      level: line >= 1 && line <= total ? 'pass' : 'error',
      claim: 'citation ' + key,
      detail: line <= total ? 'resolves (' + total + ' lines)' : 'file has only ' + total + ' lines',
    })
  }
  if (findings.length === 0) {
    findings.push({
      level: 'warning',
      claim: 'the review cites specific lines',
      detail: 'no `path:line` citations found - findings without locations cannot be checked',
    })
  }
  return findings
}
