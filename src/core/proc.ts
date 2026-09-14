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

export interface RunResult {
  command: string
  output: string
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
  const raw = (stripEcho(res.stdout ?? '') + stripEcho(res.stderr ?? '')).trim()
  return {
    command,
    output: timedOut ? (raw + '\n[timed out after ' + timeoutMs + ' ms]').trim() : raw,
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
