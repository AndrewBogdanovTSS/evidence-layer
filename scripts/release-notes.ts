/**
 * `tsx scripts/release-notes.ts <tag> [file]` - the notes a GitHub Release
 * shows, with every link that works in the repository working there too.
 *
 * `docs/releases/<tag>.md` links to the roadmap and the decision records the
 * way any page here does, relative to itself (`../plans/...`), and
 * `check:docs` holds those links to files that exist. A Release page is not a
 * file in the repository, so GitHub resolves the same links against the
 * Release's own URL and every one of them leads nowhere. This rewrites each
 * relative link to the file at the tag - `blob/<tag>/docs/plans/...` - so the
 * page says what the notes said when they were released, not what the file
 * says on master later.
 *
 * Deliberately not done: rewriting the file in the repository. There the
 * relative link is the right one - it follows the checkout, works offline and
 * in a fork, and is what `check:docs` checks - so only the copy handed to the
 * Release is rewritten. A link inside a fenced block is an example, not a
 * link, and is left as written, as `check:docs` leaves it unread.
 */
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fencedLineNumbers } from '../src/index'

/** The directory the notes live in, which their relative links start from. */
const NOTES_DIR = 'docs/releases'

/**
 * `text` with each relative link `](path)` turned into
 * `](https://github.com/<repository>/blob/<tag>/<resolved path>)`. A link
 * with a scheme (`https:`, `mailto:`) or one that is only an anchor is kept.
 */
export function absoluteReleaseLinks(text: string, repository: string, tag: string): string {
  const lines = text.split('\n')
  const fenced = fencedLineNumbers(lines)
  const base = 'https://github.com/' + repository + '/blob/' + tag + '/'
  return lines
    .map((line, i) =>
      fenced.has(i)
        ? line
        : line.replace(/\]\((?![a-z][a-z0-9+.-]*:)([^)#\s]+)((?:#[^)]*)?)\)/gi, (_, path: string, anchor: string) => {
            const resolved = posix.normalize(posix.join(NOTES_DIR, path))
            // A path that climbs out of the repository is not one this can name.
            return resolved.startsWith('../') ? '](' + path + anchor + ')' : '](' + base + resolved + anchor + ')'
          }),
    )
    .join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, file = NOTES_DIR + '/' + tag + '.md'] = process.argv.slice(2)
  const repository = process.env.GITHUB_REPOSITORY
  if (!tag || !repository) {
    process.stderr.write('usage: GITHUB_REPOSITORY=<owner>/<repo> tsx scripts/release-notes.ts <tag> [file]\n')
    process.exit(2)
  }
  process.stdout.write(absoluteReleaseLinks(readFileSync(file, 'utf8'), repository, tag))
}
