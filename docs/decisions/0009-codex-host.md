---
id: DEC-0009
status: accepted
date: 2026-10-18
supersedes: null
invariants:
  - Every path an `apply_patch` touches - each file it adds, updates or deletes, and each one it moves a file to - is checked by the pre-write guard; enforced by `pnpm test`.
  - The command `init codex` writes runs through a POSIX login shell from any directory inside the project, the way Codex runs a hook; enforced by `pnpm test`.
  - Claude Code and Codex render through one implementation of the command-hook JSON protocol, not two; enforced by `pnpm test`.
review_by: 2027-10-18
enforce_owner: Andrii Bohdanov
---

# DEC-0009: the runtime gate in Codex

## Context

DEC-0005 deferred other hosts until "their hook protocol is documented well
enough to write fixtures against". Codex's now is: its documentation describes
SessionStart, PreToolUse and Stop, and the repository publishes JSON Schemas
generated from the Rust types that read and write them
(`codex-rs/hooks/schema/generated`). Read at openai/codex 8c07694 on
2026-10-18, they show Codex took Claude Code's shapes for these three events -
the same `hookSpecificOutput.additionalContext`, the same
`permissionDecision: "deny"`, the same `{"decision": "block", "reason"}` - and
the same `stop_hook_active` and `last_assistant_message` on Stop. The gate's
core needed nothing.

Three things differ, and each is where a copy of the Claude Code adapter would
have been wrong:

- **Edits arrive as a patch.** Codex writes files with `apply_patch`, whose
  `tool_input.command` is the patch text. There is no `file_path`; the paths
  are on the patch's `*** Add File:`, `*** Update File:`, `*** Delete File:`
  and `*** Move to:` lines.
- **No project directory.** Codex runs a hook through `$SHELL -lc` (`cmd.exe
  /C` on Windows) in the session's working directory, with no
  `$CLAUDE_PROJECT_DIR`. Its documentation finds the repository with
  `git rev-parse --show-toplevel`.
- **Trust.** Codex skips a project hook nobody has approved, and re-asks
  whenever its command changes.

## Decision

1. `src/hosts/codex.ts` reads Codex's input - the paths of an `apply_patch`
   from the patch itself, a `null` last message as none - and renders through
   the protocol both hosts share, which moved into `src/hosts/contract.ts`
   rather than being copied.
2. `evidence-layer init codex` merges the three hooks into `.codex/hooks.json`
   with the merge `init claude` uses - the files have the same shape. The
   command is `node "$(git rev-parse --show-toplevel)/node_modules/...` for a
   POSIX shell, and `commandWindows` is `npx --no-install evidence-layer ...`,
   since `cmd.exe` has no `$(...)`. It tells the user to approve the hooks in
   `/hooks`.
3. The fixtures in `test/fixtures/hosts/codex/` carry every field the
   generated schemas mark required, and no other.

## Why not

- **A plugin for Codex.** Codex plugins can bundle hooks, but a project file
  is what `init claude` writes too, and it is what a team reviews and commits.
- **`npx` on every platform.** It finds the package from any directory, at
  ~370 ms per call; the pre-write hook runs on every edit. The POSIX form is
  the one most sessions use, so it gets the fast path.
- **A live-session fixture.** Not available from where this was written. The
  fixtures prove the adapter keeps to the published schema, not that a later
  Codex release still sends it - the same limit the Claude Code fixtures have.

## Consequences

- A gate block in Codex becomes a continuation prompt: Codex continues the
  turn with the block's reason as the next instruction, which is the loop the
  gate relies on in Claude Code too.
- A shell command can still write the ledger in Codex, as in Claude Code: the
  pre-write guard is an accidental-write guard, not a sandbox.
