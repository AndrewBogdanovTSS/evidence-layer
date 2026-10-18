/**
 * Claude Code's hook protocol, and nothing else.
 *
 * Checked against code.claude.com/docs/en/hooks on 2026-10-17 and pinned by
 * the fixtures in `test/fixtures/hosts/claude-code/`, which are written from
 * that documentation's schema rather than recorded from a live session - so
 * they prove this adapter keeps to the documented protocol, not that a future
 * Claude Code release still speaks it.
 *
 * Input (JSON on stdin) - the fields read here:
 *
 *   - every event: `session_id`, `cwd` (wherever the agent last `cd`-ed)
 *   - SessionStart: `source` (`startup`, `resume`, `clear`, `compact`, `fork`)
 *   - PreToolUse: `tool_name`, `tool_input.file_path` / `tool_input.notebook_path`
 *   - Stop: `stop_hook_active`, `last_assistant_message` - the final reply
 *     itself; the transcript file is not read, because the documentation says
 *     it may not contain that reply yet when Stop fires
 *
 * Output:
 *
 *   - SessionStart: `hookSpecificOutput.additionalContext`
 *   - PreToolUse: `hookSpecificOutput.permissionDecision: "deny"` with a
 *     reason; nothing at all to leave the normal permission flow alone
 *   - Stop: `{"decision": "block", "reason": ...}`; nothing to let it stop
 *   - a `systemMessage` wherever the gate let something through with a caveat
 */
import type { GateDecision, GateEvent } from '../core/gate-decision'
import type { HostAdapter } from './contract'

const EVENTS = { 'session-start': 'session-start', 'pre-tool-use': 'pre-write', stop: 'stop' } as const

/** The tools that write a file at a path the hook can see. Bash can write too; it is not one of these. */
export const FILE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function input(stdin: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(stdin)
  } catch {
    throw new Error('the hook input is not JSON')
  }
  if (!isRecord(value)) throw new Error('the hook input is not a JSON object')
  return value
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error('the hook input has no ' + field)
  return value
}

export const claudeCode: HostAdapter = {
  events: Object.keys(EVENTS),

  kindOf(event) {
    return EVENTS[event as keyof typeof EVENTS] ?? null
  },

  parse(event, stdin) {
    const kind = this.kindOf(event)
    if (!kind) throw new Error('unknown Claude Code event: ' + event)
    const data = input(stdin)
    const cwd = typeof data.cwd === 'string' && data.cwd !== '' ? data.cwd : process.cwd()

    if (kind === 'session-start') {
      return {
        kind,
        cwd,
        sessionId: text(data.session_id, 'session_id'),
        ...(typeof data.source === 'string' && { source: data.source }),
      }
    }

    if (kind === 'pre-write') {
      const tool = data.tool_name
      if (typeof tool !== 'string' || !(FILE_WRITE_TOOLS as readonly string[]).includes(tool)) return null
      const toolInput = isRecord(data.tool_input) ? data.tool_input : {}
      const paths = [toolInput.file_path, toolInput.notebook_path].filter(
        (p): p is string => typeof p === 'string' && p !== '',
      )
      if (paths.length === 0) return null
      return {
        kind,
        cwd,
        paths,
        ...(typeof data.session_id === 'string' && { sessionId: data.session_id }),
      }
    }

    return {
      kind,
      cwd,
      sessionId: text(data.session_id, 'session_id'),
      reentry: data.stop_hook_active === true,
      ...(typeof data.last_assistant_message === 'string' && { message: data.last_assistant_message }),
    }
  },

  render(decision: GateDecision, kind: GateEvent['kind']) {
    if (decision.action === 'context') {
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: decision.text },
      })
    }
    if (decision.action === 'deny') {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: decision.reason,
        },
      })
    }
    if (decision.action === 'block') {
      // A blocked PreToolUse is a deny; anything else that blocks is a Stop.
      if (kind === 'pre-write') {
        return JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: decision.reason,
          },
        })
      }
      return JSON.stringify({ decision: 'block', reason: decision.reason })
    }
    return decision.message ? JSON.stringify({ systemMessage: decision.message }) : ''
  },
}
