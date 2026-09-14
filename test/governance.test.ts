import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkReachability, readInvariants, reachableCommands } from '../src/core/governance'

let repo: string

/** A throwaway repository shaped like a consumer of this package, with only what the check reads. */
function makeRepo(opts: {
  scripts?: Record<string, string>
  hook?: string
  workflow?: string
  invariants?: string[]
  scriptFiles?: Record<string, string>
}): void {
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: opts.scripts ?? {} }))

  if (opts.hook) {
    mkdirSync(join(repo, '.githooks'), { recursive: true })
    writeFileSync(join(repo, '.githooks', 'pre-push'), opts.hook)
  }
  if (opts.workflow) {
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), opts.workflow)
  }
  for (const [path, body] of Object.entries(opts.scriptFiles ?? {})) {
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    writeFileSync(join(repo, path), body)
  }
  if (opts.invariants) {
    mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true })
    writeFileSync(
      join(repo, 'docs', 'decisions', '0001-x.md'),
      ['---', 'invariants:', ...opts.invariants.map((i) => '  - ' + i), '---', '', '# X'].join('\n'),
    )
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gov-'))
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('readInvariants', () => {
  it('reads the command out of an "enforced by" clause', () => {
    makeRepo({ invariants: ['Claims are backed; enforced by `pnpm check:claims`.'] })
    expect(readInvariants(join(repo, 'docs', 'decisions'))[0]!.command).toBe('pnpm check:claims')
  })

  it('keeps an invariant that names no command, rather than dropping it', () => {
    makeRepo({ invariants: ['Reviewers think carefully; enforced by a reviewer.'] })
    const [inv] = readInvariants(join(repo, 'docs', 'decisions'))
    expect(inv?.command).toBeUndefined()
  })

  it('ignores an invariant making no enforcement claim', () => {
    makeRepo({ invariants: ['The engine is deterministic.'] })
    expect(readInvariants(join(repo, 'docs', 'decisions'))).toHaveLength(0)
  })

  it('flags an invariant that self-discloses a runtime-composed trigger', () => {
    makeRepo({ invariants: ['Something is checked; enforced by `pnpm check:x` (runtime-composed trigger).'] })
    expect(readInvariants(join(repo, 'docs', 'decisions'))[0]!.runtimeComposed).toBe(true)
  })
})

describe('reachableCommands', () => {
  it('finds a script a git hook runs', () => {
    makeRepo({ scripts: { 'check:all': 'tsx scripts/governance.ts' }, hook: 'pnpm check:all\n' })
    expect(reachableCommands(repo).has('check:all')).toBe(true)
  })

  it('finds a script a workflow runs', () => {
    makeRepo({ scripts: { test: 'vitest run' }, workflow: 'jobs:\n  a:\n    steps:\n      - run: pnpm test\n' })
    expect(reachableCommands(repo).has('test')).toBe(true)
  })

  it('follows a script file to the commands it runs in turn', () => {
    makeRepo({
      scripts: { 'check:all': 'tsx scripts/gov.ts', 'check:docs': 'tsx scripts/docs.ts' },
      scriptFiles: { 'scripts/gov.ts': 'run("pnpm check:docs")' },
      hook: 'pnpm check:all',
    })
    expect(reachableCommands(repo).has('check:docs')).toBe(true)
  })

  it('reaches nothing when no trigger exists', () => {
    makeRepo({ scripts: { 'check:docs': 'tsx scripts/docs.ts' } })
    expect(reachableCommands(repo).size).toBe(0)
  })

  it('recognises npm\'s special-cased shorthand (`npm test`, not only `npm run test`)', () => {
    // npm special-cases test/start/stop/restart to run without the word
    // "run". A project using the shorthand is not a rare case - it is most
    // plain npm projects, which is exactly who "zero-config" has to work for.
    makeRepo({ scripts: { test: 'vitest run' }, workflow: 'jobs:\n  a:\n    steps:\n      - run: npm test\n' })
    expect(reachableCommands(repo).has('test')).toBe(true)
  })

  it('does not apply the npm shorthand to an ordinary script name', () => {
    // "npm docs" is not valid npm syntax for a script named "docs" - only the
    // four special-cased names get the bare form.
    makeRepo({ scripts: { docs: 'typedoc' }, workflow: 'jobs:\n  a:\n    steps:\n      - run: npm docs\n' })
    expect(reachableCommands(repo).has('docs')).toBe(false)
  })
})

describe('checkReachability', () => {
  it('fails an invariant naming a command no trigger reaches', () => {
    makeRepo({
      scripts: { 'check:docs': 'tsx scripts/docs.ts' },
      invariants: ['README claims hold; enforced by `pnpm check:docs`.'],
    })
    const [finding] = checkReachability(repo)
    expect(finding?.level).toBe('error')
    expect(finding?.detail).toContain('documented, not enforced')
  })

  it('fails an invariant naming a command that does not exist', () => {
    makeRepo({ invariants: ['Spelling is checked; enforced by `pnpm check:spelling`.'] })
    expect(checkReachability(repo)[0]!.detail).toContain('not a script in package.json')
  })

  it('warns, rather than fails, when enforcement is a person', () => {
    makeRepo({ invariants: ['Accessibility is considered; enforced by a reviewer.'] })
    expect(checkReachability(repo)[0]!.level).toBe('warning')
  })

  it('passes once a trigger reaches the command', () => {
    makeRepo({
      scripts: { 'check:docs': 'tsx scripts/docs.ts' },
      hook: 'pnpm check:docs',
      invariants: ['README claims hold; enforced by `pnpm check:docs`.'],
    })
    expect(checkReachability(repo)[0]!.level).toBe('pass')
  })

  it('downgrades an unreached, self-disclosed runtime-composed trigger to unverifiable, not a silent pass', () => {
    makeRepo({
      scripts: { 'check:docs': 'tsx scripts/docs.ts' },
      invariants: ['README claims hold; enforced by `pnpm check:docs` (runtime-composed trigger).'],
    })
    const [finding] = checkReachability(repo)
    expect(finding?.level).toBe('unverifiable')
    expect(finding?.level).not.toBe('pass')
  })
})
