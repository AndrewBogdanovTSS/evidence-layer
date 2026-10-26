/**
 * `claims --bundle` - is every cited block one this bundle carries, unedited?
 *
 * The claim it makes falsifiable: "these blocks are the ones the gatherer
 * wrote", anywhere the bundle file can be carried - not only in the checkout
 * that gathered it.
 *
 * The seal answers the same question, but only where the gather ran: it lives
 * in `.git/`. A review is often written somewhere else - by a model in a later
 * CI job, by a person reading the bundle CI uploaded - and there `claims` alone
 * proves only that a tag names a block in the same document. It cannot
 * recompute the id, because the id hashes the full output and the block shows
 * a trimmed one, so a block typed by hand under an invented id passes it. With
 * the bundle, every cited block must be, canonically (`canonicalBlock`), the
 * block that bundle carries under that id.
 *
 * What it deliberately does not do:
 *   - attest to the bundle. It is as trustworthy as where it came from: the
 *     artifact a gather job uploaded in the same workflow run is CI's own; a
 *     bundle committed beside the review is the author's, and checks nothing
 *     the author could not have written.
 *   - check freshness. A bundle carries no fingerprint of the source, only the
 *     commit it was gathered at - which every block's `@commit` repeats, and
 *     `lintClaims` already holds to `--sha`. Give `--sha` the commit CI is
 *     checking and a bundle from another commit fails there.
 *
 * Carrying the seal between jobs instead was rejected: its fingerprint and
 * exclusions describe one checkout, and it sits in a hidden directory that
 * `actions/upload-artifact` leaves out unless told otherwise - a seal that
 * silently did not arrive reads as `seal/no-run`, which is only unverifiable.
 * A missing bundle file is bad usage instead, so the step cannot pass.
 */
import { readFileSync } from 'node:fs'
import type { CodedFinding } from './codes'
import { compareCited, hashBlocks } from './seal'

export interface Bundle {
  path: string
  text: string
  /** The commit the bundle says it was gathered at, from its `- Head:` line. */
  headSha?: string
  blocks: Record<string, { blockSha256: string; command: string }>
}

/** The `- Head:` line `gatherEvidence` writes at the top of every bundle. */
const HEAD_RE = /^- Head: `([0-9a-f]{40})`$/m

/** A bundle file, read and hashed - or why it is not one. Throws only where `readFileSync` does. */
export function readBundle(path: string): { bundle: Bundle } | { broken: string } {
  const text = readFileSync(path, 'utf8')
  let hashed: ReturnType<typeof hashBlocks>
  try {
    hashed = hashBlocks(text)
  } catch (err) {
    return { broken: (err as Error).message }
  }
  if (hashed.size === 0) return { broken: path + ' has no addressed artifact blocks - it is not an evidence bundle' }
  const blocks: Bundle['blocks'] = {}
  for (const [id, { block, blockSha256 }] of hashed) blocks[id] = { blockSha256, command: block.command }
  const head = HEAD_RE.exec(text)?.[1]
  return { bundle: { path, text, ...(head && { headSha: head }), blocks } }
}

/** Every addressed VERIFIED claim's blocks, held to the bundle: present in it, and identical. */
export function checkBundle(markdown: string, file: string, bundle: Bundle): CodedFinding[] {
  return compareCited(markdown, file, bundle.blocks).map(({ id, command, where, missing, edited }): CodedFinding => {
    const claim = 'artifact ' + id + ' is the one in ' + bundle.path
    if (missing) {
      const same = Object.entries(bundle.blocks).find(([, b]) => b.command === command)?.[0]
      return {
        level: 'error',
        code: 'bundle/not-gathered',
        claim,
        detail:
          bundle.path + ' has no artifact ' + id + ' - the block was written by hand, or copied from another gather' +
          (same ? '. Its `' + command + '` block is ' + same : ''),
        fix: (same ? 'cite ' + same + ' instead, with its block' : 'cite a block') + ' copied from ' + bundle.path + ' unedited - or mark the claim UNVERIFIED',
        ...where,
      }
    }
    if (edited) {
      return {
        level: 'error',
        code: 'bundle/edited',
        claim,
        detail: 'the block at line ' + (edited.start + 1) + ' differs from the one in ' + bundle.path + ' - it was edited after it was gathered',
        fix: 'copy the ' + id + ' block from ' + bundle.path + ' again, unedited - or mark the claims citing it UNVERIFIED',
        ...where,
      }
    }
    return { level: 'pass', code: 'bundle/provenance', claim, detail: 'identical to the block in ' + bundle.path, ...where }
  })
}
