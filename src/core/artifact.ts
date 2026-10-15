/**
 * The unit of evidence, and the module both the gatherer and the claim linter
 * import.
 *
 * The claim it makes falsifiable: "I ran something, and I am pointing at the
 * specific thing I ran." An artifact block names the exact command, quotes its
 * output verbatim, records the exit code, and - since v2 - carries a stable id
 * so a claim can address it rather than merely sit near it.
 *
 * The grammar, in full:
 *
 *     (fence)artifact:tests-a3f91c@f8ae76a
 *     $ pnpm test
 *     Tests  71 passed (71)
 *     exit: 0
 *     (fence)
 *
 * A run that never reported a result says why on its exit line, so the reason
 * travels with the code instead of being guessed from it - `124` is only a
 * convention, and a real tool may exit 124 on its own:
 *
 *     exit: 124 (timeout)
 *     exit: 137 (killed SIGKILL)
 *     exit: 1 (overflow)
 *
 * A lint or test run may end its output with one work-summary line, the counts
 * that say whether it checked anything at all - exit 0 alone does not, because
 * a linter whose every file was ignored and a test run whose every test was
 * skipped both exit 0:
 *
 *     [SUMMARY lint: files=7 ignored=0 errors=0 warnings=0]
 *     [SUMMARY tests: passed=71 failed=0 skipped=0 todo=0]
 *
 * `artifact` alone (no id) is still valid - it is the pre-addressing grammar,
 * kept for one release as a warning-only path rather than a break. See
 * `claims.ts` for how a claim references an id, and why proximity alone used
 * to be the only check: a copied-in-the-wrong-place block passed it, because
 * proximity confirms a block exists nearby, not that it is the block the claim
 * is actually about.
 *
 * Rigid on purpose. Rigid is what makes it checkable by a script and re-runnable
 * by a human; a flexible grammar is a grammar nothing can check.
 */
import { createHash } from 'node:crypto'

export interface FencedBlock {
  /** The info string after the opening backticks, e.g. `artifact` or `ts`. */
  info: string
  /** 0-based line index of the opening fence. */
  start: number
  /** 0-based line index of the closing fence, or of the last line if unclosed. */
  end: number
  closed: boolean
  body: string[]
}

/** Every fenced code block in a markdown document, in order. */
export function findFencedBlocks(lines: string[]): FencedBlock[] {
  const blocks: FencedBlock[] = []
  let open: FencedBlock | null = null
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*```(.*)$/.exec(lines[i]!)
    if (!fence) {
      if (open) open.body.push(lines[i]!)
      continue
    }
    if (!open) {
      open = { info: fence[1]!.trim(), start: i, end: i, closed: false, body: [] }
      continue
    }
    open.end = i
    open.closed = true
    blocks.push(open)
    open = null
  }
  if (open) blocks.push(open)
  return blocks
}

/**
 * Line indexes that sit inside a fenced block.
 *
 * Prose rules must skip these. A review that quotes a bad example, or pastes a
 * diff containing the word "works", is not making that claim itself - and a
 * checker that cannot tell the difference gets switched off within a week.
 */
export function fencedLineNumbers(lines: string[]): Set<number> {
  const inside = new Set<number>()
  for (const block of findFencedBlocks(lines)) {
    for (let i = block.start; i <= block.end; i++) inside.add(i)
  }
  return inside
}

/** `<kind>-<6 hex chars>`, e.g. `tests-a3f91c`. Kind is cosmetic; the hash is the address. */
export const ARTIFACT_ID_RE = /^[a-z]+-[0-9a-f]{6}$/

/**
 * Why a run stopped before it reported a result: its own time limit, its own
 * output cap, or a signal from outside (the OOM killer, a user's `kill`).
 */
export type StopReason = 'timeout' | 'overflow' | `killed ${string}`

const STOP_REASON_RE = /^(?:timeout|overflow|killed [A-Z0-9]+)$/

/** The last line of an artifact block: `exit: 124 (timeout)`, or plain `exit: 0`. */
export function formatExitLine(exitCode: number, stopped?: StopReason): string {
  return 'exit: ' + exitCode + (stopped ? ' (' + stopped + ')' : '')
}

export interface ArtifactBlock extends FencedBlock {
  command: string
  exitCode: number
  /** The quoted output: every line between the `$ ` line and the exit line. */
  output: string
  /** Present when the exit line says the run was stopped before it finished. */
  stopped?: StopReason
  /** Present once the block has been addressed. Absent on the legacy `artifact` grammar. */
  id?: string
  /** Short commit prefix the id was computed against, when the block carries one. */
  commit?: string
}

const INFO_RE = /^artifact(?::([a-z]+-[0-9a-f]{6})(?:@([0-9a-f]{4,40}))?)?$/

/** Valid artifact blocks only: info string `artifact[:<id>[@<commit>]]`, `$ ` first, `exit: N` last. */
export function findArtifactBlocks(lines: string[]): ArtifactBlock[] {
  const found: ArtifactBlock[] = []
  for (const block of findFencedBlocks(lines)) {
    const info = INFO_RE.exec(block.info)
    if (!info || !block.closed) continue
    const firstIdx = block.body.findIndex((l) => l.trim() !== '')
    let lastIdx = block.body.length - 1
    while (lastIdx > firstIdx && block.body[lastIdx]!.trim() === '') lastIdx--
    const first = block.body[firstIdx]
    const last = firstIdx < lastIdx ? block.body[lastIdx] : undefined
    if (!first?.startsWith('$ ')) continue
    const exit = last ? /^exit:\s*(\d+)(?:\s+\(([^)]+)\))?$/.exec(last.trim()) : null
    if (!exit) continue
    // An unknown reason is not guessed at: the block does not parse, the same as
    // any other malformed exit line.
    if (exit[2] !== undefined && !STOP_REASON_RE.test(exit[2])) continue
    found.push({
      ...block,
      command: first.slice(2).trim(),
      output: block.body.slice(firstIdx + 1, lastIdx).join('\n'),
      exitCode: Number(exit[1]),
      ...(exit[2] !== undefined && { stopped: exit[2] as StopReason }),
      id: info[1],
      commit: info[2],
    })
  }
  return found
}

/**
 * Classifies a command into the `<kind>` half of an artifact id. Cosmetic - it
 * exists so `tests-a3f91c` reads better than `cmd-a3f91c` - and falls back
 * honestly to `cmd` rather than guessing.
 */
export function classifyCommand(command: string): string {
  if (/\btsc\b|typecheck/i.test(command)) return 'types'
  if (/eslint|\blint\b/i.test(command)) return 'lint'
  if (/git diff/i.test(command)) return 'diff'
  if (/git status/i.test(command)) return 'tree'
  if (/frozen-lockfile/i.test(command)) return 'lockfile'
  if (/\baudit\b/i.test(command)) return 'audit'
  if (/fingerprint/i.test(command)) return 'engine'
  if (/\btest\b|vitest|jest|mocha/i.test(command)) return 'tests'
  return 'cmd'
}

export type WorkKind = 'lint' | 'tests'

/** The counts a lint or test run reports about itself. Keys depend on the kind. */
export interface WorkSummary {
  kind: WorkKind
  counts: Record<string, number>
}

/** Which keys each kind's summary must carry, in the order they are written. */
export const WORK_SUMMARY_KEYS: Record<WorkKind, readonly string[]> = {
  lint: ['files', 'ignored', 'errors', 'warnings'],
  tests: ['passed', 'failed', 'skipped', 'todo'],
}

const WORK_SUMMARY_RE = /^\[SUMMARY (lint|tests): ([^\]]*)\]$/

/** One work-summary line, e.g. `[SUMMARY lint: files=7 ignored=0 errors=0 warnings=0]`. */
export function formatWorkSummary(kind: WorkKind, counts: Record<string, number>): string {
  return '[SUMMARY ' + kind + ': ' + WORK_SUMMARY_KEYS[kind].map((k) => k + '=' + (counts[k] ?? 0)).join(' ') + ']'
}

/**
 * The work summary in a run's output, or `null` when there is none or it is
 * malformed. Only the last non-blank line counts: the producer appends it after
 * the tool has finished, so a summary-shaped line the tool itself printed
 * earlier (a test that echoes one) cannot stand in for the run's own.
 */
export function parseWorkSummary(output: string): WorkSummary | null {
  const line = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
  const match = line ? WORK_SUMMARY_RE.exec(line) : null
  if (!match) return null
  const [, kind, body] = match
  const counts: Record<string, number> = {}
  for (const [, key, value] of body!.matchAll(/(\w+)=(\d+)/g)) counts[key!] = Number(value)
  if (!WORK_SUMMARY_KEYS[kind as WorkKind].every((k) => k in counts)) return null
  return { kind: kind as WorkKind, counts }
}

/**
 * How much a lint or test run actually checked, from its summary: files that
 * were linted rather than ignored, or tests that ran and passed.
 */
export function workDone(summary: WorkSummary): number {
  const c = summary.counts
  return summary.kind === 'lint' ? c.files! - c.ignored! : c.passed!
}

/**
 * The address. Deterministic: the same command, at the same commit, with the
 * same output, always yields the same id - which is what makes id equality a
 * real check rather than a random label.
 *
 * The full commit and the full output go into the hash so the id is globally
 * unambiguous; only a short, readable prefix of each is displayed or stored
 * next to it in the fence, because that is the part a human verifies by eye.
 */
export function artifactId(command: string, commit: string, output: string): string {
  const hash = createHash('sha256').update(command + '\0' + commit + '\0' + output).digest('hex')
  return classifyCommand(command) + '-' + hash.slice(0, 6)
}

/**
 * Renders one artifact block.
 *
 * Long output is truncated from the middle rather than the end: the last lines
 * of a test run are the ones that say whether it passed. The id, when given, is
 * computed from the *untruncated* output, so trimming the display never changes
 * the address a claim points at.
 */
export function formatArtifact(
  command: string,
  output: string,
  exitCode: number,
  opts: { id?: string; commit?: string; maxLines?: number; stopped?: StopReason } = {},
): string {
  const fence = '`'.repeat(3)
  const maxLines = opts.maxLines ?? 40
  const lines = output.replace(/\r\n/g, '\n').split('\n')
  const body =
    lines.length <= maxLines
      ? lines
      : [
          ...lines.slice(0, Math.ceil(maxLines / 2)),
          '[... ' + (lines.length - maxLines) + ' lines omitted ...]',
          ...lines.slice(-Math.floor(maxLines / 2)),
        ]
  const info = opts.id ? 'artifact:' + opts.id + (opts.commit ? '@' + opts.commit.slice(0, 7) : '') : 'artifact'
  return [fence + info, '$ ' + command, ...body, formatExitLine(exitCode, opts.stopped), fence].join('\n')
}
