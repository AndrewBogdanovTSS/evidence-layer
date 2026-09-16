/**
 * Runs a command and records what happened, including when it goes wrong.
 *
 * The claim it makes falsifiable: "the command passed."
 *
 * A failed command is evidence. A command that timed out is evidence, recorded
 * as `exit: 124` by the usual shell convention. A command that was never run is
 * not evidence at all - which is why nothing in here quietly swallows a failure
 * or substitutes a plausible-looking result for a real one.
 */
import { spawnSync } from 'node:child_process'

/** CSI escape sequences - the colour and cursor codes a terminal-aware program emits. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-?]*[ -/]*[@-~]/g

export interface RunResult {
  command: string
  /**
   * What the command said, normalised: terminal escape sequences removed and a
   * package manager's echoed command line dropped. This is the evidence field -
   * what gets hashed into an artifact id, parsed by a reporter adapter, and
   * embedded in a review.
   */
  output: string
  /**
   * The same text with nothing taken out, for callers that re-print it to a
   * person. `governance` runs each check as a captured subprocess and prints
   * what it captured; stripping colour there would make a passing check and a
   * failing one look identical in the one place someone is actually reading.
   *
   * Two fields rather than one flag, because the choice is not global: a single
   * run is usually both displayed and cited, and those two uses want different
   * text.
   */
  raw: string
  exitCode: number
  timedOut: boolean
}

export function run(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): RunResult {
  const timeoutMs = opts.timeoutMs ?? 300_000
  // `shell: true` so `pnpm` resolves to `pnpm.cmd` on Windows without every
  // caller having to know that. The commands run here are literals written in
  // the consuming project, never user input, so the usual injection objection to
  // `shell: true` does not apply - but do not copy this line into a tool that
  // accepts commands from somewhere else.
  const res = spawnSync(command, {
    cwd: opts.cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  const timedOut = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  // A package manager running an aliased script (`pnpm fingerprint` -> `tsx
  // scripts/fingerprint.ts`) commonly echoes the resolved command as a whole
  // line of its own, on stdout or stderr depending on version - and since
  // `spawnSync` returns the two streams separately with no shared timing, that
  // line can land anywhere once they are concatenated, not just at the top.
  // It is redundant with the `$ <command>` an artifact block already renders
  // from `command` itself, and left in, the two collide visually - found by
  // generating a real fixture rather than assumed, which is the whole
  // discipline this package exists to encourage. Stripped as a whole line,
  // from each stream before combining, rather than only at position zero.
  const stripEcho = (s: string) =>
    s
      .split('\n')
      .filter((line) => !/^\$ \S/.test(line.trim()))
      .join('\n')
  // Colour is an environment setting, and captured output is evidence, so the
  // two must not touch. With `FORCE_COLOR` set - common in CI, and inherited by
  // every child - Node colours a bare `console.log(1 + 1)` and vitest colours
  // its summary line, which breaks two things at once: a reporter parser stops
  // recognising a format it reads correctly everywhere else, and, worse,
  // `artifactId` hashes this output, so the same command at the same commit
  // would address differently on a machine with colour enabled. An id that
  // depends on the terminal is not an address.
  //
  // Stripped before `stripEcho`, because an escape sequence in front of the
  // `$` would otherwise hide a package manager's echoed command line from it.
  const stripAnsi = (s: string) => s.replace(ANSI_RE, '')
  const raw = (stripEcho(res.stdout ?? '') + stripEcho(res.stderr ?? '')).trim()
  const normalised = stripAnsi(
    (stripEcho(stripAnsi(res.stdout ?? '')) + stripEcho(stripAnsi(res.stderr ?? ''))).trim(),
  )
  const note = '\n[timed out after ' + timeoutMs + ' ms]'
  return {
    command,
    output: timedOut ? (normalised + note).trim() : normalised,
    raw: timedOut ? (raw + note).trim() : raw,
    exitCode: timedOut ? 124 : (res.status ?? 1),
    timedOut,
  }
}

/**
 * Trimmed stdout of a command, or `null` when it failed.
 *
 * For cheap git queries where "it did not work" is a legitimate answer that the
 * caller has to handle - not swallow.
 */
export function capture(command: string, cwd?: string): string | null {
  const res = run(command, { cwd, timeoutMs: 30_000 })
  return res.exitCode === 0 ? res.output.trim() : null
}
