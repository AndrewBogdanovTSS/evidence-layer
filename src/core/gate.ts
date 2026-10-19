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
 *     else. It also hands the agent the claim grammar as context.
 *   - **pre-write** refuses a file-write tool aimed at the gate's own state.
 *     An accidental-write guard, not a sandbox: a shell command can still
 *     write there, and nothing here pretends otherwise.
 *   - **stop** runs `claims`, `receipt` and - when a run is sealed - provenance
 *     and freshness over every review this session changed, and over the
 *     `**Claim**:` lines of the agent's final message. Errors block the stop,
 *     so the agent fixes its claims before anyone reads them.
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
import { fencedLineNumbers } from './artifact'
import { findClaims, lintClaims } from './claims'
import type { Finding, Level } from './cli'
import type { CodedFinding } from './codes'
import { gateFailure, journalOutcome, levelOf } from './gate-decision'
import type { GateDecision, GateEvent, GateOptions, GateOutcome } from './gate-decision'
import { gatherCommandFor } from './gather-command'
import { appendEntry, newEntryId } from './journal'
import { gitCapture } from './proc'
import { decidePreWrite } from './protect'
import { checkReceipt, parseReceipt } from './receipt'
import { checkFreshness, checkProvenance, freshnessMatters, readCurrentRun, repoRoot, sourceFingerprint, stateDir } from './seal'
import type { CurrentRun, FingerprintResult } from './seal'

export * from './gate-decision'
export { decidePreWrite, isProtected, protectedRoots } from './protect'

const DEFAULT_REVIEWS = ['review.md']
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_REASON_FINDINGS = 20
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

/** How to gather, in a sentence's words: the project's command when it has one, a description when not. */
function gatherWith(command: string | null): string {
  return command ? '`' + command + '`' : 'the project\'s evidence script'
}

function grammar(gather: string | null): string[] {
  return [
    'evidence-layer checks this session. When you report a checkable result - in a review file or in your final answer - state it as a claim, one per line pair:',
    '',
    '**Claim**: <what is true>',
    '**Grounding**: VERIFIED[<artifact id>: <predicates>]   (or DOCUMENTED + a citation, INFERRED + numbered steps, UNVERIFIED)',
    '',
    'VERIFIED ids come from the evidence bundle, which lists ready-made claims - gather it with ' + gatherWith(gather) +
      ' before you report, and gather again after you change code. Cite artifact blocks exactly as the bundle has them. Ordinary prose is not checked; only **Claim** lines are.',
  ]
}

function sessionStart(event: Extract<GateEvent, { kind: 'session-start' }>, opts: GateOptions): GateDecision {
  const root = repoRoot(event.cwd)
  const state = root ? stateDir(root) : null
  if (!root || !state) return { action: 'allow', outcome: 'not-applicable', level: null, findings: [] }
  const gather = gatherCommandFor(root)

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
  const runHint =
    'run' in current
      ? current.run.seal.headSha === head
        ? 'A sealed evidence run exists for the current commit (' + current.run.seal.runId + ').'
        : 'The latest sealed evidence run is for another commit - gather again with ' + gatherWith(gather) + ' before citing it.'
      : 'No sealed evidence run exists in this checkout yet.'
  const text = [...grammar(gather), '', 'Review files checked at stop: ' + reviews.join(', ') + '. ' + runHint].join('\n')
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
  gather: string | null
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
    gather: gatherCommandFor(root),
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
  const findings = lintClaims(markdown, path, { expectedHeadSha: receipt.headSha })
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

/** Problems first, worst first; then warnings, each on a line of its own. Passes are not listed. */
const REASON_ORDER: Level[] = ['error', 'flaky', 'unverifiable', 'warning']

function formatReason(findings: Finding[], intro: string, footer: string[] = []): string {
  const listed = REASON_ORDER.flatMap((level) => findings.filter((f) => f.level === level))
  const lines = listed.slice(0, MAX_REASON_FINDINGS).map((f) => {
    const where = f.file ? ' (' + f.file + (f.line ? ':' + f.line : '') + ')' : ''
    const detail = f.detail.length > MAX_DETAIL ? f.detail.slice(0, MAX_DETAIL) + '...' : f.detail
    return '- [' + f.level + '] ' + f.claim + where + ': ' + detail
  })
  if (listed.length > MAX_REASON_FINDINGS) lines.push('- ... and ' + (listed.length - MAX_REASON_FINDINGS) + ' more')
  return [intro, ...lines, ...footer].join('\n')
}

/** The lines that let a person tag a block without reading the journal: its entry id, in the command that takes it. */
function tagLines(entryId: string | null): string[] {
  if (!entryId) return []
  return [
    '',
    'Journal entry ' + entryId + ' - whoever settles it can record whether this block was right: `evidence-layer journal tag ' +
      entryId + ' real|false --gate`.',
  ]
}

/**
 * A hash of everything a stop's verdict rests on: each changed review's bytes,
 * the final message, which run is current, and - when freshness was read - the
 * tree it was read against. Equal inputs give an equal verdict, which is what
 * lets an exhausted episode stop repeating itself. When no text cites a run,
 * the tree is left out on purpose: nothing checked then depends on it.
 */
function verdictInputs(ctx: StopContext, changed: string[], message: string | undefined): string {
  const current = ctx.current
  const fingerprint = ctx.fingerprint()
  return sha256(
    JSON.stringify({
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
  const findings = [...changed.flatMap((r) => checkReview(ctx, r)), ...(message !== undefined ? checkMessage(ctx, message) : [])]
  const level = levelOf(findings)
  const failing = level === 'error' || (opts.strict === true && (level === 'unverifiable' || level === 'flaky'))
  const scope = [...changed, ...(message !== undefined ? ['final message'] : [])]
  const runId = 'run' in ctx.current ? ctx.current.run.seal.runId : undefined
  const inputs = verdictInputs(ctx, changed, message)

  // Drawn before the reason is written, so the reason can name the entry the
  // journal is about to hold. `null` when nothing will be journalled.
  const entryId = opts.journal === false ? null : newEntryId()
  const decided = (decision: GateDecision): GateDecision => {
    journal(where, 'gate:stop', decision.outcome, decision.action, decision.level, findings, scope, runId, entryId ?? undefined)
    return decision
  }
  const remember = (outcome: GateOutcome, episode: SessionState['episode']): void => {
    if (typeof session === 'object') writeSession(path, { ...session, lastSeenAt: now(), episode, lastVerdict: { inputs, outcome } })
  }

  if (!failing) {
    remember('checked', null)
    const intro =
      level === 'warning'
        ? 'evidence-layer: no errors, but there are warnings:'
        : 'evidence-layer: no errors, but not everything could be checked:'
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
      '). Fix the claims - back them with the cited artifact, gather again with ' + gatherWith(ctx.gather) +
      ', or mark them UNVERIFIED - then finish:',
    tagLines(entryId),
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
      message: formatReason(findings, 'evidence-layer could not keep a retry count, so it let this stop through with errors:'),
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
    message: formatReason(findings, 'evidence-layer blocked ' + blocks + ' times and is letting this stop through. These problems remain:'),
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
  id?: string,
): void {
  if (where.opts.journal === false) return
  const entryOutcome = journalOutcome(outcome, level)
  if (!entryOutcome) return
  try {
    mkdirSync(where.state, { recursive: true })
    appendEntry(join(where.state, 'journal.jsonl'), {
      ...(id !== undefined && { id }),
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
