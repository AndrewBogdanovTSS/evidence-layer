/**
 * `pnpm check:deps` - is every dependency this package declares actually used?
 *
 * A repository-specific check, not a portable one: "is this import used"
 * depends on how a project imports things, which is exactly the kind of fact
 * README.md says does not belong in `src/core/`.
 *
 * A dependency counts as referenced when its name turns up as text anywhere
 * in this repository's own tracked files - an import, a `require`, a script
 * in `package.json` invoking its binary, a mention in a config file - other
 * than `package.json`'s own `dependencies`/`devDependencies` block (which
 * trivially names every dependency it declares), the lockfile (which names
 * every transitive one too) and this script's own source (whose comments
 * name the two exemptions below, which would otherwise "find" themselves).
 *
 * Two categories are exempted rather than searched for, because no textual
 * search would find them honestly:
 *
 *   - `@types/*` packages, which TypeScript resolves ambiently and which are
 *     never imported by name;
 *   - `typescript` itself, invoked as the `tsc` binary rather than imported,
 *     treated as used whenever a `tsconfig.json` exists - about as close to a
 *     universal convention as this gets.
 *
 * Everything else that still finds no textual reference is a `warning`,
 * never an `error`: this is a heuristic over free text, and "found nothing"
 * is weaker evidence than a command that actually failed. See
 * `KNOWN_INDIRECT` for the one dependency this package itself needs that
 * exemption for, and why.
 *
 * Exit codes: 0 always (pass/warning only - see above), 2 bad usage.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture, exitCodeFor, help, parseArgs, report } from '../src/index'
import type { Finding } from '../src/index'

const HELP = `
pnpm check:deps [--repo <path>]

Checks that every dependency this package declares in package.json is
referenced somewhere in its own source, or explicitly exempted with a reason.

  --repo   repository root (default: the one this script lives in)

exit 0 = pass/warning only, this check never fails the build - 2 = bad usage
`

interface Pkg {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * Dependencies referenced only as a config flag to another tool, never by
 * name - `tsdown.config.ts` turns `arethetypeswrong` on as `attw: true`, an
 * abbreviation that never contains the package's actual name, so no text
 * search would find it. Checked against the flag actually being present in
 * the named file, not an unconditional pass, so removing the flag makes the
 * dependency reportable again rather than silently exempt forever.
 */
const KNOWN_INDIRECT: Record<string, { file: string; flag: string }> = {
  '@arethetypeswrong/core': { file: 'tsdown.config.ts', flag: 'attw: true' },
}

function checkDependency(name: string, repo: string, corpus: string): Finding {
  const claim = '`' + name + '` is referenced somewhere in this repository'

  if (name.startsWith('@types/')) {
    return { level: 'pass', claim, detail: 'ambient types - TypeScript resolves these by convention, never by import' }
  }

  const known = KNOWN_INDIRECT[name]
  if (known) {
    let flagFile = ''
    try {
      flagFile = readFileSync(join(repo, known.file), 'utf8')
    } catch {
      // fall through - reported as not found below, same as any other miss
    }
    return flagFile.includes(known.flag)
      ? { level: 'pass', claim, detail: 'set via `' + known.flag + '` in ' + known.file + ', not imported by name' }
      : { level: 'warning', claim, detail: 'expected `' + known.flag + '` in ' + known.file + ' - the exemption no longer applies' }
  }

  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(escaped).test(corpus)) {
    return { level: 'pass', claim, detail: "found in the repository's own tracked text" }
  }
  return {
    level: 'warning',
    claim,
    detail:
      'no reference found outside package.json - could be a real miss, or a binary invoked under a ' +
      'different name, or a config-only flag this check does not know about; confirm before removing it',
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) help(HELP)

  const here = fileURLToPath(new URL('.', import.meta.url))
  const repo = typeof args.repo === 'string' ? args.repo : join(here, '..')
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as Pkg
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }

  // `scripts` and everything else in package.json (name, bin, exports...) is
  // fair corpus - that is where `tsx`, `vitest` and `tsdown` show up as
  // invoked binaries. Only the dependency declarations themselves are
  // stripped, since those trivially "mention" every dependency they declare.
  const pkgRaw = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as Record<string, unknown>
  delete pkgRaw.dependencies
  delete pkgRaw.devDependencies
  const selfPath = relative(repo, fileURLToPath(import.meta.url)).replace(/\\/g, '/')

  const tracked = (capture('git ls-files', repo) ?? '')
    .split('\n')
    .filter((f) => f && f !== 'package.json' && f !== 'pnpm-lock.yaml' && f !== selfPath)
  const corpus = [JSON.stringify(pkgRaw)]
    .concat(
      tracked.map((f) => {
        try {
          return readFileSync(join(repo, f), 'utf8')
        } catch {
          return ''
        }
      }),
    )
    .join('\n')

  const hasTsconfig = tracked.includes('tsconfig.json')
  const findings: Finding[] = Object.keys(deps).map((name): Finding => {
    if (name === 'typescript' && hasTsconfig) {
      return {
        level: 'pass',
        claim: '`typescript` is referenced somewhere in this repository',
        detail: 'tsconfig.json exists - typescript is used via the `tsc` binary, not imported by name',
      }
    }
    return checkDependency(name, repo, corpus)
  })

  report("package.json dependencies, checked against this repository's own text", findings)
  process.exit(exitCodeFor(findings))
}

main()
