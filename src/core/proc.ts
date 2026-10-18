/**
 * Runs a command and records what happened, including when it goes wrong.
 *
 * The claim it makes falsifiable: "the command passed."
 *
 * A failed command is evidence. A command that timed out is evidence, recorded
 * as `exit: 124` by the usual shell convention. A command that was never run is
 * not evidence at all - which is why nothing in here quietly swallows a failure
 * or substitutes a plausible-looking result for a real one.
 *
 * Two runners, one result shape:
 *
 *   - `run` - synchronous, for short commands (git plumbing, a quick query). On
 *     timeout it signals only the direct child, which is safe for a command that
 *     starts no workers of its own and unsafe for anything that does.
 *   - `runAsync` - for the evidence steps (lint, typecheck, tests). On timeout it
 *     kills the whole process tree, and it reports within a grace period even
 *     when some process in that tree will not let go of the output.
 */
import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:os'
import type { StopReason } from './artifact'

/** CSI escape sequences - the colour and cursor codes a terminal-aware program emits. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g

const MAX_BUFFER_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 300_000
/** How long `runAsync` waits for a killed tree to release its output before reporting anyway. */
export const KILL_GRACE_MS = 10_000
const IS_WINDOWS = process.platform === 'win32'

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
  /**
   * Why the run stopped before reporting a result, when it did: our own time
   * limit, our own output cap, or a signal from outside (the OOM killer, a
   * user's `kill`). Pass it on to `formatArtifact` so the exit line carries it.
   */
  stopped?: StopReason
}

export interface AsyncRunResult extends RunResult {
  /** Wall time from spawn to settle. Not evidence - keep it out of anything hashed. */
  durationMs: number
}

/**
 * A package manager running an aliased script (`pnpm fingerprint` -> `tsx
 * scripts/fingerprint.ts`) commonly echoes the resolved command as a whole
 * line of its own, on stdout or stderr depending on version - and since the two
 * streams are captured separately with no shared timing, that line can land
 * anywhere once they are concatenated, not just at the top. It is redundant
 * with the `$ <command>` an artifact block already renders from `command`
 * itself, and left in, the two collide visually - found by generating a real
 * fixture rather than assumed, which is the whole discipline this package
 * exists to encourage. Stripped as a whole line, from each stream before
 * combining, rather than only at position zero.
 */
const stripEcho = (s: string) =>
  s
    .split('\n')
    .filter((line) => !/^\$ \S/.test(line.trim()))
    .join('\n')

/**
 * Colour is an environment setting, and captured output is evidence, so the
 * two must not touch. With `FORCE_COLOR` set - common in CI, and inherited by
 * every child - Node colours a bare `console.log(1 + 1)` and vitest colours its
 * summary line, which breaks two things at once: a reporter parser stops
 * recognising a format it reads correctly everywhere else, and, worse,
 * `artifactId` hashes this output, so the same command at the same commit
 * would address differently on a machine with colour enabled. An id that
 * depends on the terminal is not an address.
 *
 * Stripped before `stripEcho`, because an escape sequence in front of the `$`
 * would otherwise hide a package manager's echoed command line from it.
 */
const stripAnsi = (s: string) => s.replace(ANSI_RE, '')

/** How a run ended, before it is rendered into a `RunResult`. Shared by both runners. */
interface Ending {
  stdout: string
  stderr: string
  status: number | null
  signal: NodeJS.Signals | null
  /** Our own limit fired - never inferred from the signal, which an outside kill shares. */
  limit: 'timeout' | 'overflow' | null
  timeoutMs: number
  maxBufferBytes: number
  error?: Error
  /** Appended after the outcome note, e.g. that a killed tree outlived the grace period. */
  extraNote?: string
}

function toRunResult(command: string, e: Ending): RunResult {
  const raw = (stripEcho(e.stdout) + stripEcho(e.stderr)).trim()
  const normalised = stripAnsi((stripEcho(stripAnsi(e.stdout)) + stripEcho(stripAnsi(e.stderr))).trim())
  let exitCode: number
  let stopped: StopReason | undefined
  let note = ''
  if (e.limit === 'timeout') {
    exitCode = 124
    stopped = 'timeout'
    note = '[timed out after ' + e.timeoutMs + ' ms]'
  } else if (e.limit === 'overflow') {
    exitCode = 1
    stopped = 'overflow'
    note = '[output exceeded ' + e.maxBufferBytes + ' bytes - process stopped]'
  } else if (e.error) {
    exitCode = 1
    note = '[error] ' + e.error.message
  } else if (e.status === null && e.signal) {
    // Killed from outside. Not a timeout, whatever the signal: reported with
    // the shell's 128 + signal-number exit code, and the signal named.
    exitCode = 128 + (constants.signals[e.signal] ?? 0)
    stopped = 'killed ' + e.signal
    note = '[killed by ' + e.signal + ']'
  } else {
    exitCode = e.status ?? 1
  }
  const notes = [note, e.extraNote].filter(Boolean).join('\n')
  const withNotes = (s: string) => (notes ? (s + '\n' + notes).trim() : s)
  return {
    command,
    output: withNotes(normalised),
    raw: withNotes(raw),
    exitCode,
    timedOut: stopped === 'timeout',
    ...(stopped && { stopped }),
  }
}

export function run(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): RunResult {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
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
    maxBuffer: MAX_BUFFER_BYTES,
  })
  // spawnSync's timeout and maxBuffer kills share one `status: null` shape, and
  // on POSIX so does a kill from outside - only `error.code` names the cause.
  const code = (res.error as NodeJS.ErrnoException | undefined)?.code
  const limit = code === 'ETIMEDOUT' ? 'timeout' : code === 'ENOBUFS' ? 'overflow' : null
  return toRunResult(command, {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status,
    signal: res.signal,
    limit,
    timeoutMs,
    maxBufferBytes: MAX_BUFFER_BYTES,
    error: limit ? undefined : res.error,
  })
}

/**
 * Kills a process and everything below it. On POSIX the root leads its own
 * process group (`runAsync` spawns it detached), so one signal to the group
 * reaches every descendant - including one re-parented away from the tree,
 * which a walk of parent pids would miss. On Windows `taskkill /T` walks the
 * tree. Either way, falls back to the direct child when that fails.
 */
function killTree(pid: number, direct: () => void): void {
  if (IS_WINDOWS) {
    const res = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    if (res.status !== 0) direct()
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    direct()
  }
}

export interface RunAsyncOptions {
  cwd?: string
  /** The child's environment. Defaults to this process's. */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxBufferBytes?: number
  /** How long to wait for a killed tree to close its output. Defaults to `KILL_GRACE_MS`. */
  killGraceMs?: number
}

/**
 * The runner for evidence steps. Same contract and result as `run`, plus
 * `durationMs`, with two differences that matter for any command that starts
 * workers (`pnpm typecheck` -> `nuxi` -> `vue-tsc`):
 *
 *   - A timeout or output overflow kills the whole process tree, not just the
 *     direct child. `spawnSync`'s timeout signals only the child - on Windows
 *     the `pnpm` shim - so the real work kept running orphaned, still holding
 *     the caller's output handle.
 *   - It settles when the output closes, which waits for every process holding
 *     it. If the tree has not let go `killGraceMs` after the kill, it reports
 *     anyway, with a note saying so, instead of waiting forever.
 *
 * On POSIX the tree runs in its own process group, which no longer receives the
 * terminal's Ctrl+C, so an interrupt is forwarded to it and then re-raised here.
 */
export function runAsync(command: string, opts: RunAsyncOptions = {}): Promise<AsyncRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBufferBytes = opts.maxBufferBytes ?? MAX_BUFFER_BYTES
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS
  const started = performance.now()

  return new Promise((resolve) => {
    // `shell: true` for the same reason, and with the same caveat, as `run`.
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: true,
      windowsHide: true,
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let limit: 'timeout' | 'overflow' | null = null
    let settled = false
    let grace: NodeJS.Timeout | undefined

    const kill = (): void => {
      if (child.pid !== undefined) killTree(child.pid, () => child.kill('SIGKILL'))
    }
    const onInterrupt = (): void => {
      kill()
      process.off('SIGINT', onInterrupt)
      process.kill(process.pid, 'SIGINT')
    }
    if (!IS_WINDOWS) process.on('SIGINT', onInterrupt)

    const settle = (status: number | null, signal: NodeJS.Signals | null, error?: Error, extraNote?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      process.off('SIGINT', onInterrupt)
      const result = toRunResult(command, {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        status,
        signal,
        limit,
        timeoutMs,
        maxBufferBytes,
        error,
        extraNote,
      })
      resolve({ ...result, durationMs: Math.round(performance.now() - started) })
    }

    const stop = (reason: 'timeout' | 'overflow'): void => {
      if (limit || settled) return
      limit = reason
      kill()
      grace = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        settle(
          null,
          'SIGKILL',
          undefined,
          '[the process tree still held its output ' + killGraceMs + ' ms after the kill - some processes may still be running]',
        )
      }, killGraceMs)
      grace.unref()
    }

    const timer = setTimeout(stop, timeoutMs, 'timeout')
    const collect =
      (chunks: Buffer[]) =>
      (chunk: Buffer): void => {
        if (limit === 'overflow') return
        bytes += chunk.length
        if (bytes > maxBufferBytes) stop('overflow')
        else chunks.push(chunk)
      }
    child.stdout?.on('data', collect(stdout))
    child.stderr?.on('data', collect(stderr))
    // A command that cannot start has no tree and may never emit `close`.
    child.on('error', (err) => settle(null, null, err))
    child.on('close', (code, signal) => settle(code, signal))
  })
}

/**
 * Trimmed stdout of a command, or `null` when it failed.
 *
 * For a fixed command written in this package or the consuming project. It goes
 * through a shell, so nothing read out of a review, a receipt or a host's input
 * may be concatenated into it - use `gitCapture` for those.
 */
export function capture(command: string, cwd?: string): string | null {
  const res = run(command, { cwd, timeoutMs: 30_000 })
  return res.exitCode === 0 ? res.output.trim() : null
}

/** What one git invocation returned: its exit code and both streams, kept apart. */
export interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Runs git with an argument array and no shell.
 *
 * The values these checks hand to git - a receipt's target branch, a path out
 * of a Sample integrity table, a commit a caller passed in - are written by
 * whoever wrote the review, which is exactly the party this package does not
 * take on trust. Before 0.5.0 they were concatenated into a shell string, so a
 * review could carry `$(...)` and `receipt` would run it. An argument array
 * gives the shell nothing to interpret; what is left - an argument git itself
 * reads as an option - is the caller's to rule out, with `--end-of-options`
 * or a fixed prefix in front of the value.
 *
 * stdout is returned as git wrote it: none of `run`'s echo stripping, which
 * would eat the first line of any file that starts with `> `, and stderr kept
 * out of it, so a warning never reads as file content.
 */
export function git(args: string[], cwd?: string, timeoutMs = 30_000): GitResult {
  const res = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
  })
  // A git that could not start, timed out or overflowed has no answer to give.
  const exitCode = res.error || res.status === null ? 1 : res.status
  return { exitCode, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Trimmed stdout of a git invocation, or `null` when it failed. */
export function gitCapture(args: string[], cwd?: string): string | null {
  const res = git(args, cwd)
  return res.exitCode === 0 ? res.stdout.trim() : null
}
