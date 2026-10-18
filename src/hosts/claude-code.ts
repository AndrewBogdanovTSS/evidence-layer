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
 * Output: the command-hook protocol in `./contract`, which this host defined.
 */
import { COMMAND_HOOK_EVENTS, commandHookKind, hookInput, isRecord, renderCommandHook, requiredText } from './contract'
import type { HostAdapter } from './contract'

/** The tools that write a file at a path the hook can see. Bash can write too; it is not one of these. */
export const FILE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

export const claudeCode: HostAdapter = {
  events: Object.keys(COMMAND_HOOK_EVENTS),
  kindOf: commandHookKind,

  parse(event, stdin) {
    const kind = this.kindOf(event)
    if (!kind) throw new Error('unknown Claude Code event: ' + event)
    const data = hookInput(stdin)
    const cwd = typeof data.cwd === 'string' && data.cwd !== '' ? data.cwd : process.cwd()

    if (kind === 'session-start') {
      return {
        kind,
        cwd,
        sessionId: requiredText(data.session_id, 'session_id'),
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
      sessionId: requiredText(data.session_id, 'session_id'),
      reentry: data.stop_hook_active === true,
      ...(typeof data.last_assistant_message === 'string' && { message: data.last_assistant_message }),
    }
  },

  render: renderCommandHook,
}
