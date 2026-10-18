/**
 * Codex's hook protocol, and nothing else.
 *
 * Checked against developers.openai.com/codex/hooks and the schemas Codex
 * generates from its own types (`codex-rs/hooks/schema/generated` in
 * openai/codex at 8c07694), both read on 2026-10-18, and pinned by the fixtures
 * in `test/fixtures/hosts/codex/`, which are written from those schemas rather
 * than recorded from a live session - so they prove this adapter keeps to the
 * protocol as published, not that a later Codex release still speaks it.
 *
 * Input (JSON on stdin) - the fields read here:
 *
 *   - every event: `session_id`, `cwd` - the session's working directory,
 *     which is also where the hook command runs
 *   - SessionStart: `source` (`startup`, `resume`, `clear`, `compact`, `fork`)
 *   - PreToolUse: `tool_name` and `tool_input`. Codex edits files with
 *     `apply_patch`, whose `tool_input.command` is the patch itself: the paths
 *     are read off its `*** Add File:`, `*** Update File:`, `*** Delete File:`
 *     and `*** Move to:` lines, relative to `cwd`. A shell command can write a
 *     file too; it is not one of these, as with Claude Code.
 *   - Stop: `stop_hook_active`, `last_assistant_message` - which Codex sends as
 *     `null` when the turn ended without one
 *
 * Output: the command-hook protocol in `./contract`. Codex took Claude Code's
 * shapes for these three events; its own additions (`updatedInput`, `ask`)
 * are not used. Plain stdout is not valid for Stop, so an allow prints nothing.
 */
import { COMMAND_HOOK_EVENTS, commandHookKind, hookInput, isRecord, renderCommandHook, requiredText } from './contract'
import type { HostAdapter } from './contract'

/** The tool names Codex sends for a file edit - `apply_patch`, and the two it also matches it as. */
export const CODEX_FILE_WRITE_TOOLS = ['apply_patch', 'Edit', 'Write'] as const

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/

/**
 * Every path an `apply_patch` patch touches - each file it adds, updates or
 * deletes, and each one it moves a file to. A moved file's new name is a
 * write as much as its old one, so both are guarded.
 */
export function patchPaths(patch: string): string[] {
  const paths = patch
    .split(/\r?\n/)
    .map((line) => PATCH_PATH.exec(line)?.[1]?.trim())
    .filter((p): p is string => p !== undefined && p !== '')
  return [...new Set(paths)]
}

export const codex: HostAdapter = {
  events: Object.keys(COMMAND_HOOK_EVENTS),
  kindOf: commandHookKind,

  parse(event, stdin) {
    const kind = this.kindOf(event)
    if (!kind) throw new Error('unknown Codex event: ' + event)
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
      if (typeof tool !== 'string' || !(CODEX_FILE_WRITE_TOOLS as readonly string[]).includes(tool)) return null
      const toolInput = isRecord(data.tool_input) ? data.tool_input : {}
      const paths = [
        ...(typeof toolInput.command === 'string' ? patchPaths(toolInput.command) : []),
        ...[toolInput.file_path, toolInput.path].filter((p): p is string => typeof p === 'string' && p !== ''),
      ]
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
