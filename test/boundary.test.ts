/**
 * The boundary this package's README claims, checked instead of asserted.
 *
 * While this code lived inside another repository, an ESLint rule at that
 * workspace's root banned `@tetris/*`, `vue`, `three` and friends from
 * `src/core/`. That rule did not survive the extraction, and the claim it
 * enforced - "core knows nothing about any particular project" - is the whole
 * reason anyone would install this package rather than copy five scripts.
 *
 * So the rule is re-stated here as a test rather than as lint configuration:
 * one fewer tool to install, and it fails in the same run as everything else.
 * The ban is now structural rather than a list of one project's dependencies -
 * `core/` may import Node builtins and its own siblings, and nothing else.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = fileURLToPath(new URL('.', import.meta.url))
const CORE = join(here, '..', 'src', 'core')

const IMPORT = /^\s*import\s+(?:type\s+)?(?:[\s\S]*?)\s*from\s*'([^']+)'/gm

function importsOf(file: string): string[] {
  const source = readFileSync(join(CORE, file), 'utf8')
  return [...source.matchAll(IMPORT)].map((m) => m[1]!)
}

const files = readdirSync(CORE).filter((f) => f.endsWith('.ts'))

describe('src/core imports nothing that knows what project it is running in', () => {
  it('has files to check at all - a boundary test over an empty list proves nothing', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  for (const file of files) {
    it(file + ' imports only node builtins and its own siblings', () => {
      for (const specifier of importsOf(file)) {
        const builtin = specifier.startsWith('node:')
        const sibling = specifier.startsWith('./')
        expect(
          builtin || sibling,
          specifier + ' in core/' + file + ' is neither a node builtin nor a core sibling',
        ).toBe(true)
      }
    })
  }

  it('never reaches up into adapters, commands or the package index', () => {
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        expect(specifier.startsWith('../'), specifier + ' in core/' + file).toBe(false)
      }
    }
  })
})
