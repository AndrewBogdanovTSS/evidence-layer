/**
 * The notes a GitHub Release shows: a relative link from
 * `docs/releases/<tag>.md` becomes the file at that tag, so it leads somewhere
 * from the Release page, and nothing else in the notes changes.
 */
import { describe, expect, it } from 'vitest'
import { absoluteReleaseLinks } from '../scripts/release-notes'

const REPO = 'Owner/evidence-layer'

describe('absoluteReleaseLinks', () => {
  it('points a relative link at the file as it was at the tag', () => {
    expect(absoluteReleaseLinks('Phase 1 of [the roadmap](../plans/roadmap.md).', REPO, 'v0.20.0')).toBe(
      'Phase 1 of [the roadmap](https://github.com/Owner/evidence-layer/blob/v0.20.0/docs/plans/roadmap.md).',
    )
  })

  it('keeps the anchor, and resolves a link to a sibling note', () => {
    expect(absoluteReleaseLinks('[DEC](../decisions/0010-x.md#why) and [then](v0.19.0.md)', REPO, 'v0.20.0')).toBe(
      '[DEC](https://github.com/Owner/evidence-layer/blob/v0.20.0/docs/decisions/0010-x.md#why)' +
        ' and [then](https://github.com/Owner/evidence-layer/blob/v0.20.0/docs/releases/v0.19.0.md)',
    )
  })

  it('leaves absolute links, anchors and fenced examples as written', () => {
    const text = ['[npm](https://www.npmjs.com/package/x) [up](#what-you-may-have-to-do)', '```md', '[x](../plans/y.md)', '```'].join('\n')
    expect(absoluteReleaseLinks(text, REPO, 'v1.0.0')).toBe(text)
  })

  it('leaves a link that climbs out of the repository alone', () => {
    expect(absoluteReleaseLinks('[x](../../../outside.md)', REPO, 'v1.0.0')).toBe('[x](../../../outside.md)')
  })
})
