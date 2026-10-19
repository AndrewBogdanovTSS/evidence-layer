/**
 * What the runtime gate decides, as data - shared by `gate.ts` and the
 * lighter `protect.ts`, so the hook that fires before every file write can
 * load the decision types and the failure policy without the whole gate.
 */
import type { Finding, Level } from './cli'
import type { Outcome } from './journal'

export type GateEvent =
  | { kind: 'session-start'; cwd: string; sessionId: string; source?: string }
  | { kind: 'pre-write'; cwd: string; sessionId?: string; paths: string[] }
  | { kind: 'stop'; cwd: string; sessionId: string; reentry: boolean; message?: string }

/** Why the gate decided what it did - so an allow that checked nothing never reads as a pass. */
export type GateOutcome =
  | 'checked'
  | 'retry-exhausted'
  | 'fail-open-error'
  | 'fail-closed-error'
  | 'no-snapshot'
  /** A stop with nothing to check closed an open retry episode - an end to it, not a clean check. */
  | 'closed-unchecked'
  | 'not-applicable'

export interface GateAssessment {
  outcome: GateOutcome
  /** The assessment's level - not a synonym for the action. `null` when nothing was assessed. */
  level: Level | null
  findings: Finding[]
}

export type GateDecision = GateAssessment &
  (
    | { action: 'allow'; message?: string }
    | { action: 'deny'; reason: string }
    | { action: 'block'; reason: string }
    | { action: 'context'; text: string }
  )

export interface GateOptions {
  /** Review files the gate checks, relative to the repository's top level. Default `['review.md']`. */
  reviewPaths?: string[]
  /** An internal failure blocks (or denies) instead of allowing. */
  failClosed?: boolean
  /** Never let an episode run out of blocks: keep blocking until the check is clean. */
  keepBlocking?: boolean
  /** Also block on `unverifiable` - a check that could not be completed is not a clean one. */
  strict?: boolean
  /** Blocks per retry episode before the gate lets the agent through. Default 2. */
  maxBlocks?: number
  /** Record each decision in the checkout's gate journal. Default `true`. */
  journal?: boolean
}

const PRECEDENCE: Level[] = ['error', 'flaky', 'unverifiable', 'warning', 'pass']

/** The assessment's level: the worst one present, in the order error > flaky > unverifiable > warning > pass. */
export function levelOf(findings: Finding[]): Level | null {
  for (const level of PRECEDENCE) if (findings.some((f) => f.level === level)) return level
  return null
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What the gate does when it cannot run at all. Never a pass. */
export function gateFailure(kind: GateEvent['kind'], error: unknown, opts: GateOptions = {}): GateDecision {
  const detail = messageOf(error)
  const findings: Finding[] = [{ level: 'unverifiable', claim: 'evidence-layer could check this', detail }]
  if (opts.failClosed && kind === 'stop') {
    return {
      action: 'block',
      reason: 'evidence-layer could not check this stop, and it is set to fail closed: ' + detail,
      outcome: 'fail-closed-error',
      level: 'unverifiable',
      findings,
    }
  }
  if (opts.failClosed && kind === 'pre-write') {
    return {
      action: 'deny',
      reason: 'evidence-layer could not check this write, and it is set to fail closed: ' + detail,
      outcome: 'fail-closed-error',
      level: 'unverifiable',
      findings,
    }
  }
  return {
    action: 'allow',
    message: 'evidence-layer could not run, so nothing was checked: ' + detail,
    outcome: 'fail-open-error',
    level: 'unverifiable',
    findings,
  }
}

/**
 * The journal's level for a gate decision: the assessment's own level when the
 * checks ran (an allow with errors is still an error), `unverifiable` when they
 * could not - never `pass` for an allow that checked nothing.
 */
export function journalOutcome(outcome: GateOutcome, level: Level | null): Outcome | null {
  if (outcome === 'not-applicable') return null
  if (outcome === 'retry-exhausted') return 'error'
  if (outcome === 'checked') return level ?? 'pass'
  return level === 'error' ? 'error' : 'unverifiable'
}
