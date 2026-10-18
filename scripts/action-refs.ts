/**
 * Which release of the action this repository tells a reader to write today:
 * the `uses: <owner>/evidence-layer@v<version>` lines in the README and in the
 * example project's workflow, and the version each one names.
 *
 * Shared by the two scripts that need the same answer. `check:docs` fails when
 * one names anything but package.json's version, and `pnpm release` rewrites
 * them in the release commit, so the commit the tag points at passes that
 * check and a bump by hand that forgets them does not.
 *
 * Kept to these files on purpose. A decision record or a release note names
 * the version it was written about, and rewriting it would not keep it
 * current, only make it wrong about its own past.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ACTION_REF_FILES = ['README.md', 'examples/plain-node-project/.github/workflows/ci.yml']

export interface ActionRef {
  file: string
  line: number
  version: string
}

/** `uses: owner/<name>@v` as group 1, the version after it as group 2. */
function refPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(^[ \\t]*(?:- )?uses:[ \\t]*[\\w.-]+/' + escaped + '@v)([^\\s#]+)', 'gm')
}

export function findActionRefs(repo: string, name: string): ActionRef[] {
  return ACTION_REF_FILES.flatMap((file) => {
    const text = readFileSync(join(repo, file), 'utf8')
    return [...text.matchAll(refPattern(name))].map((m) => ({
      file,
      line: text.slice(0, m.index).split('\n').length,
      version: m[2]!,
    }))
  })
}

/** Points every ref at `version`; returns the files it changed. */
export function pinActionRefs(repo: string, name: string, version: string): string[] {
  return ACTION_REF_FILES.filter((file) => {
    const path = join(repo, file)
    const text = readFileSync(path, 'utf8')
    const pinned = text.replace(refPattern(name), (_, uses: string) => uses + version)
    if (pinned === text) return false
    writeFileSync(path, pinned)
    return true
  })
}
