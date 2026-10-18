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
 */
import type { GateDecision, GateEvent } from '../core/gate-decision'

export interface HostAdapter {
  /** The event names this adapter accepts on the command line. */
  readonly events: readonly string[]
  /** Which gate event an event name becomes - needed to render a failure when parsing itself failed. */
  kindOf(event: string): GateEvent['kind'] | null
  parse(event: string, stdin: string): GateEvent | null
  /** The hook's stdout. Empty means "no decision": the host carries on as it would have. */
  render(decision: GateDecision, kind: GateEvent['kind']): string
}
