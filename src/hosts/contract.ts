/**
 * What a host adapter is: the only code that knows one agent host's hook
 * protocol.
 *
 * `../core/gate.ts` decides; it never sees a host's JSON. An adapter turns a
 * host's hook input into a `GateEvent` and a `GateDecision` back into that
 * host's output. Two rules every adapter keeps, because the hook command
 * relies on them:
 *
 *   - `parse` returns `null` for an event the gate has nothing to say about
 *     (a tool that writes no file), and throws on input it cannot read - the
 *     hook command turns that throw into a decision under the failure policy.
 *   - `render` says everything through the protocol's output. The hook
 *     command always exits 0, so no exit code of this package - `2` is bad
 *     usage here and "block" to Claude Code - can be read as a decision.
 *
 * Below the interface: the command-hook JSON protocol Claude Code defined and
 * Codex adopted - the same `hookSpecificOutput` for SessionStart and
 * PreToolUse, the same `{"decision": "block", "reason"}` for Stop. Shared here
 * rather than copied into each adapter, because two copies of one protocol
 * drift, and the ladder's clone check would say so. What differs between the
 * hosts - which tools write files, where a path is - stays in the adapter.
 */
import type { GateDecision, GateEvent } from '../core/gate-decision'
import { isRecord } from '../core/json'

export { isRecord }

export interface HostAdapter {
  /** The event names this adapter accepts on the command line. */
  readonly events: readonly string[]
  /** Which gate event an event name becomes - needed to render a failure when parsing itself failed. */
  kindOf(event: string): GateEvent['kind'] | null
  parse(event: string, stdin: string): GateEvent | null
  /** The hook's stdout. Empty means "no decision": the host carries on as it would have. */
  render(decision: GateDecision, kind: GateEvent['kind']): string
}

/** The event names both command-hook hosts use on this package's command line, and the gate event each becomes. */
export const COMMAND_HOOK_EVENTS = { 'session-start': 'session-start', 'pre-tool-use': 'pre-write', stop: 'stop' } as const

export function commandHookKind(event: string): GateEvent['kind'] | null {
  return COMMAND_HOOK_EVENTS[event as keyof typeof COMMAND_HOOK_EVENTS] ?? null
}

/** The hook's stdin as a JSON object. Throws on anything else, which the hook command turns into a failure decision. */
export function hookInput(stdin: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(stdin)
  } catch {
    throw new Error('the hook input is not JSON')
  }
  if (!isRecord(value)) throw new Error('the hook input is not a JSON object')
  return value
}

/** A field the protocol says is always there, and the gate cannot work without. */
export function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error('the hook input has no ' + field)
  return value
}

/**
 * A decision in the command-hook protocol:
 *
 *   - SessionStart: `hookSpecificOutput.additionalContext`
 *   - PreToolUse: `hookSpecificOutput.permissionDecision: "deny"` with a
 *     reason; nothing at all to leave the normal permission flow alone
 *   - Stop: `{"decision": "block", "reason": ...}`; nothing to let it stop
 *   - a `systemMessage` wherever the gate let something through with a caveat
 */
export function renderCommandHook(decision: GateDecision, kind: GateEvent['kind']): string {
  const deny = (reason: string) =>
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
  if (decision.action === 'context') {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: decision.text } })
  }
  if (decision.action === 'deny') return deny(decision.reason)
  if (decision.action === 'block') {
    // A blocked PreToolUse is a deny; anything else that blocks is a Stop.
    return kind === 'pre-write' ? deny(decision.reason) : JSON.stringify({ decision: 'block', reason: decision.reason })
  }
  return decision.message ? JSON.stringify({ systemMessage: decision.message }) : ''
}
