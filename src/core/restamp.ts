/**
 * `restamp` - move a review onto the current run, in one step.
 *
 * The claim it makes falsifiable: none of its own. It is the cost-reducing
 * half of freshness, as the skeleton is of addressing (DEC-0010, C4). Gather
 * after a code change and every id is new; before this, the honest fix was to
 * copy every block out of the new bundle again and retype every id beside it
 * - and the convenient one was to restate the result in prose, or drop the
 * claim. A check whose honest answer costs that much is a check people route
 * around.
 *
 * For each block a review carries that the current run did not produce, it
 * finds the run that did, and that run's step; takes the current run's
 * artifact for the same step - the same command, where no step was recorded
 * - replaces the block with the current bundle's, byte for byte; and rewrites
 * the id in the grade tags that cite it.
 *
 * What it deliberately does not do:
 *   - write evidence. Every block it puts in a review is copied from a sealed
 *     run's bundle; nothing is composed here.
 *   - touch a sentence or a predicate. `VERIFIED[tests-a3f91c: passed>=71]`
 *     becomes `VERIFIED[tests-b7c2d0: passed>=71]`, and if the new run passed
 *     70 the claim fails, as it should: the caller checks the result with
 *     `claims --seal`, and a predicate the new run does not meet stays an
 *     error. A claim made to pass by rewriting what it says would be the one
 *     thing worse than a stale one.
 *   - rewrite an id anywhere but a grade tag - not in prose, not in a fence.
 *   - move the receipt. A review restamped onto a run gathered at a later
 *     commit still names the earlier one in its Access Receipt, and
 *     `claims/wrong-commit` says so: which commit a review is about is the
 *     writer's statement, not a block to be swapped.
 */
import { fencedLineNumbers, findArtifactBlocks } from './artifact'
import { findClaims } from './claims'
import type { Run } from './seal'

/** One block moved: the id it had, the id it has, and where. */
export interface Restamped {
  from: string
  to: string
  command: string
  /** 1-based line of the block's opening fence, in the review as it was. */
  line: number
}

/** One block left alone, and why - the current run has nothing to put in its place. */
export interface Unmoved {
  id: string
  line: number
  why: string
}

export interface RestampResult {
  markdown: string
  moved: Restamped[]
  left: Unmoved[]
}

/** The current run's artifact that takes the place of an earlier one: by step when the earlier run recorded it, by command otherwise. */
function successor(current: Run, earlier: { step?: string; command: string }): string | { none: string } {
  const entries = Object.entries(current.seal.artifacts)
  if (earlier.step !== undefined) {
    const byStep = entries.filter(([, a]) => a.step === earlier.step)
    if (byStep.length === 1) return byStep[0]![0]
  }
  const byCommand = entries.find(([, a]) => a.command === earlier.command)
  if (byCommand) return byCommand[0]
  return {
    none:
      'the current run has no artifact for ' + (earlier.step !== undefined ? 'the `' + earlier.step + '` step or ' : '') +
      '`' + earlier.command + '` - gather it, or mark the claims citing this block UNVERIFIED',
  }
}

/**
 * The review with every block from an earlier run replaced by the current
 * run's for the same step, and the ids in its grade tags rewritten to match.
 * `earlier` is the kept runs other than `current`, newest first. A block the
 * current run already produced is left as it is - including one that was
 * edited, which is `seal/edited`'s to report, not this function's to repair.
 */
export function restampReview(markdown: string, current: Run, earlier: Run[]): RestampResult {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n'
  const lines = markdown.split(/\r?\n/)
  const bundleLines = current.bundle.split(/\r?\n/)
  const bundleBlocks = new Map(findArtifactBlocks(bundleLines).flatMap((b) => (b.id ? [[b.id, b] as const] : [])))

  const moved: Restamped[] = []
  const left: Unmoved[] = []
  const target = new Map<string, string>()
  const blocks = findArtifactBlocks(lines).filter((b) => b.id !== undefined && current.seal.artifacts[b.id] === undefined)
  for (const block of blocks) {
    const id = block.id!
    if (!target.has(id)) {
      const origin = earlier.find((r) => r.seal.artifacts[id] !== undefined)?.seal.artifacts[id]
      // A block no kept run produced - written by hand, or from a run long
      // gone - can still be replaced by a real one for the command it names.
      const next = successor(current, origin ?? { command: block.command })
      if (typeof next !== 'string' || !bundleBlocks.has(next)) {
        left.push({ id, line: block.start + 1, why: typeof next === 'string' ? 'the current bundle shows no block for ' + next : next.none })
        continue
      }
      target.set(id, next)
    }
    moved.push({ from: id, to: target.get(id)!, command: block.command, line: block.start + 1 })
  }

  // Tags first - the line count does not move - then blocks, bottom up, so a
  // replacement of another length shifts none of the blocks still to come.
  for (const claim of findClaims(lines, fencedLineNumbers(lines))) {
    const to = claim.gradeId !== undefined ? target.get(claim.gradeId) : undefined
    if (to === undefined) continue
    lines[claim.gradeLine!] = lines[claim.gradeLine!]!.replace('VERIFIED[' + claim.gradeId, 'VERIFIED[' + to)
  }
  for (const block of [...blocks].reverse()) {
    const to = target.get(block.id!)
    if (to === undefined) continue
    const replacement = bundleBlocks.get(to)!
    lines.splice(block.start, block.end - block.start + 1, ...bundleLines.slice(replacement.start, replacement.end + 1))
  }
  return { markdown: lines.join(eol), moved, left }
}
