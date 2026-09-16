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

export interface ArtifactBlock extends FencedBlock {
  command: string
  exitCode: number
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
    const body = block.body.filter((l) => l.trim() !== '')
    const first = body[0]
    const last = body[body.length - 1]
    if (!first?.startsWith('$ ')) continue
    const exit = last ? /^exit:\s*(\d+)$/.exec(last.trim()) : null
    if (!exit) continue
    found.push({
      ...block,
      command: first.slice(2).trim(),
      exitCode: Number(exit[1]),
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
  opts: { id?: string; commit?: string; maxLines?: number } = {},
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
  return [fence + info, '$ ' + command, ...body, 'exit: ' + exitCode, fence].join('\n')
}
