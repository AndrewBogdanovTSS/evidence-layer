/**
 * The runtime gate - the checks, run at the moment an agent says it is done,
 * instead of in CI after a person has already read what it wrote.
 *
 * The claim it makes falsifiable: "I am finished, and what I reported holds."
 *
 * Everything here is host-independent. A host adapter (`../hosts/`) turns a
 * host's hook input into a `GateEvent` and a `GateDecision` back into whatever
 * that host understands; this file never sees either format. Three events:
 *
 *   - **session-start** records which review files exist, and with what bytes,
 *     so that a later Stop checks only what this session wrote - a review left
 *     modified yesterday does not block today's conversation about something
 *     else. It also hands the agent the claim grammar as context - as a
 *     filled-in example, and with the claims the current run backs when
 *     there is a run for this commit.
 *   - **pre-write** refuses a file-write tool aimed at the gate's own state.
 *     An accidental-write guard, not a sandbox: a shell command can still
 *     write there, and nothing here pretends otherwise.
 *   - **stop** runs `claims`, `receipt` and - when a run is sealed - provenance
 *     and freshness over every review this session changed, and over the
 *     `**Claim**:` lines of the agent's final message. Errors block the stop,
 *     so the agent fixes its claims before anyone reads them: one numbered
 *     item per failing claim, each with the fix its finding carries, then
 *     the claims the current run does back.
 *
 * Two budgets keep a strict check from becoming a trap. A **retry episode**
 * starts at the first Stop with errors and closes at the first Stop without
 * them; inside one, the gate blocks at most `maxBlocks` times and then lets
 * the agent through with the errors attached - once: while the checked texts,
 * the sealed run and the tree stay what they were, later stops say nothing
 * and journal nothing. Editing text does not reset an episode - only a clean
 * check closes it, or a stop with nothing left to check, which is journalled
 * as closed without one. And the gate **fails open**: if it
 * cannot run, the session continues and is told why. Both have opt-outs
 * (`keepBlocking`, `failClosed`) for anyone who wants the stricter trade, and
 * neither is ever recorded as a pass. See
 * `docs/plans/runtime-gate-decisions.md` (OQ-04, OQ-05) for the policy table.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fencedLineNumbers, findArtifactBlocks } from './artifact'
import { findClaims, lintClaims } from './claims'
import { formatFix } from './cli'
import type { Finding, Level } from './cli'
import type { CodedFinding } from './codes'
import { gateFailure, journalOutcome, levelOf } from './gate-decision'
import type { GateDecision, GateEvent, GateOptions, GateOutcome } from './gate-decision'
import { cliCommandFor, gatherCommandFor } from './gather-command'
import { appendEntry } from './journal'
import { gitCapture } from './proc'
import { decidePreWrite } from './protect'
import { checkReceipt, parseReceipt } from './receipt'
import { checkFreshness, checkProvenance, freshnessMatters, readCurrentRun, repoRoot, sourceFingerprint, stateDir } from './seal'
import type { CurrentRun, FingerprintResult } from './seal'
import { suggestedClaim } from './skeleton'
import type { SuggestedClaim } from './skeleton'

export * from './gate-decision'
export { decidePreWrite, isProtected, protectedRoots } from './protect'

const DEFAULT_REVIEWS = ['review.md']
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Numbered items a reason lists. Past ten, an agent fixing them in order loses its place - the rest are counted. */
const MAX_REASON_FINDINGS = 10
const MAX_DETAIL = 300

/** Decides one event. Never throws: an internal failure becomes a decision under the failure policy. */
export function decide(event: GateEvent, opts: GateOptions = {}): GateDecision {
  try {
    if (event.kind === 'session-start') return sessionStart(event, opts)
    if (event.kind === 'pre-write') return decidePreWrite(event, opts)
    return stop(event, opts)
  } catch (error) {
    return gateFailure(event.kind, error, opts)
  }
}

// ---------------------------------------------------------------------------
// Session state

interface SessionState {
  schemaVersion: 1
  createdAt: string
  lastSeenAt: string
  /** sha256 of each review path at session start, or `absent`. Written once, never moved. */
  reviews: Record<string, string>
  /** The open retry episode, or `null` when the last applicable check was clean. */
  episode: { blocks: number } | null
  /**
   * What the last checked stop decided, and a hash of what it decided it on:
   * the texts checked, the sealed run, and the tree when freshness was read.
   * Lets an exhausted episode stay quiet while nothing it would say has
   * changed. Absent in a session file written before 0.10.0.
   */
  lastVerdict?: { inputs: string; outcome: GateOutcome } | null
}

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')

/** Session ids are opaque host input; a file name is derived from a hash of one, never the id itself. */
function sessionPath(state: string, sessionId: string): string {
  return join(state, 'sessions', sha256(sessionId).slice(0, 32) + '.json')
}

function readSession(path: string): SessionState | 'missing' | 'corrupt' {
  if (!existsSync(path)) return 'missing'
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionState>
    if (value.schemaVersion !== 1 || typeof value.reviews !== 'object' || value.reviews === null) return 'corrupt'
    return {
      schemaVersion: 1,
      createdAt: String(value.createdAt),
      lastSeenAt: String(value.lastSeenAt),
      reviews: value.reviews as Record<string, string>,
      episode:
        value.episode && typeof value.episode.blocks === 'number' ? { blocks: value.episode.blocks } : null,
      lastVerdict:
        value.lastVerdict && typeof value.lastVerdict.inputs === 'string' && typeof value.lastVerdict.outcome === 'string'
          ? { inputs: value.lastVerdict.inputs, outcome: value.lastVerdict.outcome }
          : null,
    }
  } catch {
    return 'corrupt'
  }
}

function writeSession(path: string, session: SessionState): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp'
  writeFileSync(tmp, JSON.stringify(session, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

function hashReview(root: string, path: string): string {
  const full = join(root, path)
  return existsSync(full) ? sha256(readFileSync(full)) : 'absent'
}

/** Sessions nobody has touched in a week, except the one being handled. By last activity, not creation. */
function expireSessions(state: string, keep: string): void {
  const dir = join(state, 'sessions')
  if (!existsSync(dir)) return
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (path === keep || !name.endsWith('.json')) continue
    const session = readSession(path)
    const seen = typeof session === 'object' ? Date.parse(session.lastSeenAt) : statSync(path).mtimeMs
    if (!(seen >= cutoff)) rmSync(path, { force: true })
  }
}

// ---------------------------------------------------------------------------
// session-start

/** How the project gathers: its command, and the base the current run was gathered against when a run says. */
interface GatherHow {
  command: string | null
  base?: string
}

function gatherHow(root: string, current: CurrentRun): GatherHow {
  const seal = 'run' in current ? current.run.seal : undefined
  return {
    command: gatherCommandFor(root, seal?.gatherCommand),
    ...(typeof seal?.base === 'string' && { base: seal.base }),
  }
}

/**
 * How to gather, in a sentence's words: the command, and the base the current
 * run used - a gather script that needs `--base` fails without it, so naming
 * the command alone sends the agent into a usage error first.
 */
function gatherWith(how: GatherHow): string {
  if (!how.command) return 'the project\'s evidence script'
  return '`' + how.command + '`' + (how.base ? ' (base ' + how.base + ', as the current run was gathered)' : '')
}

/** How many ready claims a message lists. A bundle has one per kind of run, so this is a cap on a malformed one. */
const MAX_READY = 8

/**
 * The claims a sealed bundle backs, one per run, as the skeleton writes them.
 * Read off the bundle's own blocks, so each is a claim the stop check passes
 * while the code is what the run was gathered from.
 */
function readyClaims(bundle: string): SuggestedClaim[] {
  const seen = new Set<string>()
  const ready: SuggestedClaim[] = []
  for (const block of findArtifactBlocks(bundle.split(/\r?\n/))) {
    if (block.id === undefined || seen.has(block.id)) continue
    seen.add(block.id)
    const pair = suggestedClaim({ ...block, id: block.id })
    if (pair) ready.push(pair)
  }
  return ready.slice(0, MAX_READY)
}

function formatReady(ready: SuggestedClaim[], runId: string): string[] {
  return [
    'Ready claims from run ' + runId + ' - keep the ones your report needs. In your final answer, paste a pair as it is; in a review file, copy it together with its artifact block from the evidence bundle, unedited:',
    ...ready.flatMap((r) => ['', r.claim, r.grounding]),
  ]
}

/**
 * The claim grammar, shown rather than described. A grammar of placeholders -
 * `VERIFIED[<artifact id>: <predicates>]` - is copied by a smaller model as it
 * stands, placeholder and all; a filled-in pair is copied as a claim. The
 * example is a real ready claim when the current run has one, so copying it
 * is correct, and an obviously made-up one otherwise, said to be one.
 */
function grammar(gather: GatherHow, ready: SuggestedClaim[]): string[] {
  const example = ready[0] ?? {
    claim: '**Claim**: The test suite ran 71 passing tests and reports no failures.',
    grounding: '**Grounding**: VERIFIED[tests-a3f91c: exit=0, passed>=71, failed=0]',
  }
  return [
    'evidence-layer checks this session. When you report a checkable result - in a review file or in your final answer - state it as a claim: a **Claim** line, with a **Grounding** line under it. For example:',
    '',
    example.claim,
    example.grounding,
    '',
    '**Claim**: The retry path handles a dropped connection.',
    '**Grounding**: UNVERIFIED',
    '',
    'The id inside VERIFIED[...] must be one the evidence bundle lists' +
      (ready.length > 0 ? '' : ' - the one above is only an example') +
      '; never make one up. The other grades: DOCUMENTED with a citation (a URL, a § section, an issue id like #12, or a file in backticks), ' +
      'INFERRED with two or more numbered steps below it, and UNVERIFIED when nothing backs the claim - which is honest, not a failure.',
    'Gather the bundle with ' + gatherWith(gather) + ' before you report, and gather again after you change code. ' +
      'Cite artifact blocks exactly as the bundle has them. Ordinary prose is not checked; only **Claim** lines are.',
  ]
}

function sessionStart(event: Extract<GateEvent, { kind: 'session-start' }>, opts: GateOptions): GateDecision {
  const root = repoRoot(event.cwd)
  const state = root ? stateDir(root) : null
  if (!root || !state) return { action: 'allow', outcome: 'not-applicable', level: null, findings: [] }

  const reviews = opts.reviewPaths ?? DEFAULT_REVIEWS
  const path = sessionPath(state, event.sessionId)
  const now = new Date().toISOString()
  const existing = readSession(path)
  // Written once. SessionStart fires again on resume, clear and compact, and
  // moving the snapshot then would move the session's starting point to its
  // middle - a review written before a /compact would stop counting as changed.
  const session: SessionState =
    typeof existing === 'object'
      ? { ...existing, lastSeenAt: now }
      : {
          schemaVersion: 1,
          createdAt: now,
          lastSeenAt: now,
          reviews: Object.fromEntries(reviews.map((r) => [r, hashReview(root, r)])),
          episode: null,
        }
  writeSession(path, session)
  expireSessions(state, path)

  const head = gitCapture(['rev-parse', 'HEAD'], root)
  const current = readCurrentRun(root, state)
  const gather = gatherHow(root, current)
  const atHead = 'run' in current && current.run.seal.headSha === head
  // Only a run for this commit: claims from another one would be handed out
  // to be refused at the first stop.
  const ready = 'run' in current && atHead ? readyClaims(current.run.bundle) : []
  const runHint =
    'run' in current
      ? atHead
        ? 'A sealed evidence run exists for the current commit (' + current.run.seal.runId + ').'
        : 'The latest sealed evidence run is for another commit - gather again with ' + gatherWith(gather) + ' before citing it.'
      : 'No sealed evidence run exists in this checkout yet.'
  const text = [
    ...grammar(gather, ready),
    '',
    'Review files checked at stop: ' + reviews.join(', ') + '. ' + runHint,
    ...('run' in current && ready.length > 0 ? ['', ...formatReady(ready, current.run.seal.runId)] : []),
  ].join('\n')
  return { action: 'context', text, outcome: 'checked', level: null, findings: [] }
}

// ---------------------------------------------------------------------------
// stop

/**
 * What one stop resolves once and every check in it shares: where the
 * repository and its state are, the run `current.json` names, how to gather,
 * and - only if some text cites the run - one freshness check against it.
 * Before 0.10.0 each checked text fingerprinted the tree again, and each
 * journal write found the repository again: two dozen git processes for a
 * stop that checked a review and a final message.
 */
interface StopContext {
  root: string
  gather: GatherHow
  current: CurrentRun
  /** The run's freshness, computed on first use and then reused. */
  freshness: () => CodedFinding
  /** The fingerprint `freshness` took, once it has run. */
  fingerprint: () => FingerprintResult | undefined
}

function stopContext(root: string, state: string): StopContext {
  const current = readCurrentRun(root, state)
  let fingerprint: FingerprintResult | undefined
  let freshness: CodedFinding | undefined
  return {
    root,
    gather: gatherHow(root, current),
    current,
    freshness: () => {
      if (freshness) return freshness
      if (!('run' in current)) throw new Error('freshness was asked of a checkout with no sealed run')
      fingerprint = sourceFingerprint(root, current.run.seal.excluded, root)
      freshness = checkFreshness(root, current.run, fingerprint)
      return freshness
    },
    fingerprint: () => fingerprint,
  }
}

function checkReview(ctx: StopContext, path: string): CodedFinding[] {
  const markdown = readFileSync(join(ctx.root, path), 'utf8')
  const receipt = parseReceipt(markdown)
  // The sealed bundle is where a review's fixes can point: its runs are the
  // ones the review may cite, once their blocks are copied in.
  const suggestFrom = 'run' in ctx.current ? ctx.current.run.bundle : undefined
  const findings = lintClaims(markdown, path, { expectedHeadSha: receipt.headSha, suggestFrom })
  if (receipt.headSha !== undefined) findings.push(...checkReceipt(receipt, markdown, ctx.root))
  findings.push(...sealFindings(ctx, markdown, path, { fromBundle: false }))
  return findings
}

function checkMessage(ctx: StopContext, message: string): CodedFinding[] {
  const bundle = 'run' in ctx.current ? ctx.current.run.bundle : undefined
  // A chat reply carries no blocks, so an id it cites is looked up in the
  // sealed bundle - and a finding that said "this document" sent the agent
  // looking in the wrong place.
  const findings = lintClaims(message, 'final message', {
    prose: false,
    artifactSource: bundle,
    artifactSourceName: bundle !== undefined ? 'the current sealed run' : 'the final message, and no evidence run is sealed',
  })
  findings.push(...sealFindings(ctx, message, 'final message', { fromBundle: true }))
  return findings
}

/** Whether a text makes any `**Claim**:` line outside a fenced example. */
function hasClaims(text: string): boolean {
  const lines = text.split(/\r?\n/)
  return findClaims(lines, fencedLineNumbers(lines)).length > 0
}

/** The ids a text's VERIFIED claims address. */
function citedIds(text: string): string[] {
  const lines = text.split(/\r?\n/)
  return [...new Set(findClaims(lines, fencedLineNumbers(lines)).flatMap((c) => (c.gradeId ? [c.gradeId] : [])))]
}

/**
 * Provenance and freshness for one checked text. Freshness only blocks when a
 * cited artifact is a lint, typecheck or test run - those are the claims a
 * later edit makes untrue; a stale `git diff` is context, not a verdict.
 */
function sealFindings(ctx: StopContext, text: string, file: string, opts: { fromBundle: boolean }): CodedFinding[] {
  const ids = citedIds(text)
  if (ids.length === 0) return []
  const current = ctx.current
  if ('broken' in current) return [{ level: 'error', code: 'seal/broken', claim: 'the evidence ledger holds together', detail: current.broken, file }]
  if ('none' in current) {
    return [
      {
        level: 'unverifiable',
        code: 'seal/no-run',
        claim: 'the cited blocks came from the gatherer',
        detail: current.none + ' - gather evidence first, with ' + gatherWith(ctx.gather),
        file,
      },
    ]
  }
  const run = current.run
  // Blocks resolved from the bundle are sealed by construction - the bundle's
  // own hash was checked when the run was read.
  const findings = opts.fromBundle ? [] : checkProvenance(text, file, run)
  const freshness = ctx.freshness()
  const matters = ids.some((id) => {
    const sealed = run.seal.artifacts[id]
    return sealed !== undefined && freshnessMatters(sealed.command)
  })
  findings.push(freshness.level === 'error' && !matters ? { ...freshness, level: 'warning', file } : { ...freshness, file })
  return findings
}

/** Problems first, worst first; then warnings. Passes are not listed. */
const REASON_ORDER: Level[] = ['error', 'flaky', 'unverifiable', 'warning']

/** How many of the findings that do not block a reason lists - they are said, not dwelt on. */
const MAX_ASIDES = 5

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) + '...' : text)
const whereOf = (f: Finding): string => (f.file ? f.file + (f.line ? ':' + f.line : '') : '')

/**
 * What an agent reads when the gate speaks. The findings that block are
 * numbered, one item per claim - a claim that fails two rules is one thing to
 * fix, not two - each with its problem and its fix on lines of their own, so a
 * model working down the list has one edit per number and the text to make it
 * with. Everything else that is not a pass follows as one line each, after
 * them, so a warning never sits between an agent and the error it has to fix.
 */
function formatReason(findings: Finding[], intro: string, opts: { blocking?: Level[]; footer?: string[] } = {}): string {
  const blocking = opts.blocking ?? []
  const listed = REASON_ORDER.flatMap((level) => findings.filter((f) => f.level === level))
  const items = new Map<string, Finding[]>()
  listed
    .filter((f) => blocking.includes(f.level))
    .forEach((f, i) => {
      const key = f.line !== undefined ? whereOf(f) : '#' + i
      items.set(key, [...(items.get(key) ?? []), f])
    })
  const lines: string[] = []
  ;[...items.values()].slice(0, MAX_REASON_FINDINGS).forEach((group, i) => {
    const where = whereOf(group[0]!)
    lines.push('', i + 1 + '. ' + (where ? where + ' - ' : '') + clip(group[0]!.claim, 120))
    for (const f of group) {
      lines.push('   problem' + (blocking.length > 1 ? ' (' + f.level + ')' : '') + ': ' + clip(f.detail, MAX_DETAIL))
      if (f.fix) lines.push(formatFix(f.fix, '   '))
    }
  })
  if (items.size > MAX_REASON_FINDINGS) lines.push('', '... and ' + (items.size - MAX_REASON_FINDINGS) + ' more')
  const asides = listed.filter((f) => !blocking.includes(f.level))
  if (asides.length > 0) {
    if (blocking.length > 0) lines.push('', 'Not blocking:')
    for (const f of asides.slice(0, MAX_ASIDES)) {
      const where = whereOf(f)
      lines.push('- [' + f.level + '] ' + f.claim + (where ? ' (' + where + ')' : '') + ': ' + clip(f.detail, MAX_DETAIL))
      if (f.fix) lines.push(formatFix(f.fix, '  '))
    }
    if (asides.length > MAX_ASIDES) lines.push('- ... and ' + (asides.length - MAX_ASIDES) + ' more')
  }
  return [intro, ...lines, ...(opts.footer ?? [])].join('\n')
}

/**
 * Says how to gather on the findings whose fix is to gather again. The core
 * checks cannot know the project's command; the gate can, and "gather again"
 * without one sends an agent off to find out how - the expensive path.
 */
function withGatherFix(findings: CodedFinding[], gather: GatherHow): CodedFinding[] {
  const fix = 'gather again with ' + gatherWith(gather) + ', then cite the runs the new bundle lists - or mark the claims UNVERIFIED'
  return findings.map((f) =>
    f.level !== 'pass' && GATHER_CODES.has(f.code) && (f.fix === undefined || f.fix.startsWith('gather')) ? { ...f, fix } : f,
  )
}

const GATHER_CODES = new Set<string>(['seal/stale', 'seal/no-run', 'claims/wrong-commit'])

/**
 * What a block reason ends with: the one command that marks a review's
 * failing claims UNVERIFIED, and the claims the current run does back. The
 * second is what makes the honest fix the cheap one for an agent that cannot
 * work out the right sentence - it is handed the sentences. Not listed when
 * the code changed since the run, since every one of them would then be
 * refused as stale; the stale finding says to gather instead.
 */
function blockFooter(ctx: StopContext, findings: Finding[], blocking: Level[], changed: string[]): string[] {
  const footer: string[] = []
  const failing = changed.filter((r) => findings.some((f) => f.file === r && blocking.includes(f.level)))
  if (failing.length > 0) {
    footer.push(
      '',
      'To mark every failing claim in a review file UNVERIFIED in one step, run ' +
        failing.map((r) => '`' + cliCommandFor(ctx.root) + ' claims ' + r + ' --fix`').join(' or ') + '.',
    )
  }
  if (!('run' in ctx.current)) return footer
  const stale = ctx.fingerprint() !== undefined && ctx.freshness().level === 'error'
  const claimsFail = findings.some((f) => blocking.includes(f.level) && f.code !== undefined && /^(claims|seal)\//.test(f.code))
  const ready = !stale && claimsFail ? readyClaims(ctx.current.run.bundle) : []
  if (ready.length > 0) footer.push('', ...formatReady(ready, ctx.current.run.seal.runId))
  return footer
}

/**
 * A hash of what a stop's verdict rests on and of the verdict itself: each
 * changed review's bytes, the final message, which run is current, the tree
 * when freshness was read - and the findings, since some checks read git state
 * none of those covers (a receipt's base check reads a remote-tracking ref, so
 * a fetch can change a verdict on unchanged text). Equal hashes are what let
 * an exhausted episode stop repeating itself.
 */
function verdictInputs(ctx: StopContext, changed: string[], message: string | undefined, findings: Finding[]): string {
  const current = ctx.current
  const fingerprint = ctx.fingerprint()
  return sha256(
    JSON.stringify({
      findings: findings
        .filter((f) => f.level !== 'pass')
        .map((f) => [f.level, 'code' in f ? f.code : null, f.file ?? null, f.line ?? null, f.detail])
        .map((f) => JSON.stringify(f))
        .sort(),
      reviews: changed.map((r) => [r, hashReview(ctx.root, r)]),
      message: message ?? null,
      run: 'run' in current ? current.run.seal.runId : 'broken' in current ? 'broken: ' + current.broken : null,
      tree:
        fingerprint === undefined
          ? null
          : 'fingerprint' in fingerprint
            ? [fingerprint.fingerprint.treeId, fingerprint.fingerprint.largeUntracked]
            : fingerprint.unverifiable,
    }),
  )
}

function stop(event: Extract<GateEvent, { kind: 'stop' }>, opts: GateOptions): GateDecision {
  const started = Date.now()
  const root = repoRoot(event.cwd)
  const state = root ? stateDir(root) : null
  if (!root || !state) return { action: 'allow', outcome: 'not-applicable', level: null, findings: [] }

  const reviews = opts.reviewPaths ?? DEFAULT_REVIEWS
  const path = sessionPath(state, event.sessionId)
  const session = readSession(path)
  const where: JournalWhere = { root, state, opts, started }
  const now = () => new Date().toISOString()

  // What this session wrote: review files whose bytes moved since it started,
  // and the Claim lines of its final message. Neither needs the other.
  const changed =
    typeof session === 'object'
      ? reviews.filter((r) => existsSync(join(root, r)) && hashReview(root, r) !== (session.reviews[r] ?? 'absent'))
      : []
  const message = event.message !== undefined && hasClaims(event.message) ? event.message : undefined
  const noSnapshot = typeof session !== 'object'

  if (changed.length === 0 && message === undefined) {
    if (noSnapshot && reviews.some((r) => existsSync(join(root, r)))) {
      const finding: Finding = {
        level: 'unverifiable',
        claim: 'this session\'s review files were checked',
        detail:
          session === 'corrupt'
            ? 'the session snapshot is unreadable, so which reviews this session changed is unknown'
            : 'no snapshot from the start of this session (the gate was set up mid-session?), so which reviews it changed is unknown',
      }
      journal(where, 'gate:stop', 'no-snapshot', 'allow', 'unverifiable', [finding], [])
      return {
        action: 'allow',
        message: 'evidence-layer did not check the review files: ' + finding.detail + '.',
        outcome: 'no-snapshot',
        level: 'unverifiable',
        findings: [finding],
      }
    }
    if (typeof session === 'object' && session.episode !== null) {
      // The claims that opened the episode are gone - the review is back to
      // what it was, or the final message makes none - so there is nothing
      // left to retry. Closed, so it cannot hold its spent blocks over a later,
      // unrelated failure; journalled, so the close never reads as a clean check.
      const finding: Finding = {
        level: 'unverifiable',
        claim: 'the open retry episode ended on a clean check',
        detail: 'this stop had nothing to check - no changed review and no claims in the final message - so the episode closed without one',
      }
      writeSession(path, { ...session, lastSeenAt: now(), episode: null, lastVerdict: null })
      journal(where, 'gate:stop', 'closed-unchecked', 'allow', 'unverifiable', [finding], [])
      return { action: 'allow', outcome: 'closed-unchecked', level: 'unverifiable', findings: [finding] }
    }
    return { action: 'allow', outcome: 'not-applicable', level: null, findings: [] }
  }

  const ctx = stopContext(root, state)
  const findings = withGatherFix(
    [...changed.flatMap((r) => checkReview(ctx, r)), ...(message !== undefined ? checkMessage(ctx, message) : [])],
    ctx.gather,
  )
  const level = levelOf(findings)
  const blocking: Level[] = opts.strict === true ? ['error', 'flaky', 'unverifiable'] : ['error']
  const failing = level === 'error' || (opts.strict === true && (level === 'unverifiable' || level === 'flaky'))
  const scope = [...changed, ...(message !== undefined ? ['final message'] : [])]
  const runId = 'run' in ctx.current ? ctx.current.run.seal.runId : undefined
  const inputs = verdictInputs(ctx, changed, message, findings)

  // The journal entry's id stays out of every reason: the agent reads the
  // reason, and an agent handed `journal tag <id> false` can grade the block
  // that stopped it. Tagging is the person's, from `journal report`.
  const decided = (decision: GateDecision): GateDecision => {
    journal(where, 'gate:stop', decision.outcome, decision.action, decision.level, findings, scope, runId)
    return decision
  }
  const remember = (outcome: GateOutcome, episode: SessionState['episode']): void => {
    if (typeof session === 'object') writeSession(path, { ...session, lastSeenAt: now(), episode, lastVerdict: { inputs, outcome } })
  }

  if (!failing) {
    remember('checked', null)
    const intro =
      level === 'unverifiable'
        ? 'evidence-layer: no errors, but not everything could be checked:'
        : 'evidence-layer: no errors, but these need a look:'
    const notClean = level === 'unverifiable' || level === 'warning' || level === 'flaky'
    return decided({
      action: 'allow',
      ...(notClean && { message: formatReason(findings, intro) }),
      outcome: 'checked',
      level,
      findings,
    })
  }

  const blockReason = formatReason(
    findings,
    'evidence-layer found problems in what you reported (' + scope.join(', ') +
      '). Fix each numbered item, then finish. Each fix is written to be applied as it stands; marking a claim UNVERIFIED instead ' +
      'is always allowed. After a code change, gather again with ' + gatherWith(ctx.gather) + '.',
    { blocking, footer: blockFooter(ctx, findings, blocking, changed) },
  )

  if (typeof session !== 'object') {
    // Nowhere to count blocks. The host's reentry flag stands in for a counter
    // of one - only in fail-open mode, and only because there is no better
    // record; with a usable session file it is never consulted.
    if (opts.failClosed || opts.keepBlocking || !event.reentry) {
      return decided({ action: 'block', reason: blockReason, outcome: 'checked', level, findings })
    }
    return decided({
      action: 'allow',
      message: formatReason(findings, 'evidence-layer could not keep a retry count, so it let this stop through with errors:', { blocking }),
      outcome: 'fail-open-error',
      level,
      findings,
    })
  }

  const blocks = session.episode?.blocks ?? 0
  const limit = opts.maxBlocks ?? 2
  if (opts.keepBlocking || blocks < limit) {
    remember('checked', { blocks: blocks + 1 })
    return decided({ action: 'block', reason: blockReason, outcome: 'checked', level, findings })
  }
  // The episode stays open - only a clean check, or a stop with nothing left
  // to check, closes it - so a later stop with the same errors is let through
  // too, rather than handed fresh blocks.
  remember('retry-exhausted', session.episode)
  if (session.lastVerdict?.outcome === 'retry-exhausted' && session.lastVerdict.inputs === inputs) {
    // Already said, about exactly these inputs. Repeating it at every stop
    // teaches the reader to skip it, and journalling it again would count one
    // unfixed review as many degraded allows.
    return { action: 'allow', outcome: 'retry-exhausted', level, findings }
  }
  return decided({
    action: 'allow',
    message: formatReason(findings, 'evidence-layer blocked ' + blocks + ' times and is letting this stop through. These problems remain:', {
      blocking,
    }),
    outcome: 'retry-exhausted',
    level,
    findings,
  })
}

// ---------------------------------------------------------------------------
// Journal

/** Where a stop journals, resolved once by the stop itself. */
interface JournalWhere {
  root: string
  state: string
  opts: GateOptions
  started: number
}

function journal(
  where: JournalWhere,
  check: string,
  outcome: GateOutcome,
  action: string,
  level: Level | null,
  findings: Finding[],
  reviews: string[],
  runId?: string,
): void {
  if (where.opts.journal === false) return
  const entryOutcome = journalOutcome(outcome, level)
  if (!entryOutcome) return
  try {
    mkdirSync(where.state, { recursive: true })
    appendEntry(join(where.state, 'journal.jsonl'), {
      check,
      commit: gitCapture(['rev-parse', 'HEAD'], where.root) ?? 'unborn',
      outcome: entryOutcome,
      findings: findings.filter((f) => f.level !== 'pass').map((f) => f.claim + ': ' + f.detail.slice(0, MAX_DETAIL)),
      gate: {
        event: check.slice('gate:'.length),
        outcome,
        action,
        reviews,
        ...(runId && { runId }),
        elapsedMs: Date.now() - where.started,
      },
    })
  } catch {
    // A journal that cannot be written must not turn a decision into a
    // failure, and must not try to journal its own failure.
  }
}
