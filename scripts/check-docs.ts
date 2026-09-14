/**
 * `pnpm check:docs` - does this repository's README still tell the truth?
 *
 * The consumer-side half of the layer, and the worked example of where the
 * line falls: every claim below is a fact about *this* package - its engine
 * range, its dependency count, its command list, its test count - which is
 * exactly why none of it can live in `src/core/`. A README is a pile of
 * assertions written once and trusted forever; this gives them a clock.
 *
 * Three outcomes, never two. A claim this script cannot evaluate (because the
 * build it would read is not on disk) is reported `unverifiable`, which is not
 * a pass.
 *
 * Exit codes: 0 clean - 1 at least one error - 3 flaky - 2 bad usage.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exitCodeFor, help, parseArgs, report, run } from '../src/index'
import type { Finding } from '../src/index'
import { parseTestCount } from '../src/adapters/node-default'

const HELP = `
pnpm check:docs [--repo <path>] [--fast]

Checks every claim README.md makes about this package against the package.

  --repo   repository root (default: the one this script lives in)
  --fast   skip the test-count claim, which has to run the suite to check it
`

const TEST_COUNT_CLAIM = 'the test count on the page is the size of the suite'

interface Pkg {
  name: string
  version: string
  engines?: { node?: string }
  dependencies?: Record<string, string>
  exports?: Record<string, unknown>
  bin?: Record<string, string>
}

/** A claim the README states in prose, against the fact it is supposed to match. */
function compare(claim: string, expected: unknown, observed: unknown): Finding {
  const same = String(expected) === String(observed)
  return {
    level: same ? 'pass' : 'error',
    claim,
    detail: same
      ? String(observed)
      : 'README says ' + String(expected) + ', the package says ' + String(observed),
    file: 'README.md',
    expected,
    observed,
  }
}

function checkInstallName(readme: string, pkg: Pkg): Finding {
  const stated = /npm install --save-dev ([\w@/-]+)/.exec(readme)?.[1]
  return compare('the install line names this package', stated, pkg.name)
}

function checkEngine(readme: string, pkg: Pkg): Finding {
  const stated = /Requires Node ([\d.]+) or newer/.exec(readme)?.[1]
  if (!stated) {
    return {
      level: 'error',
      claim: 'the README states a minimum Node version',
      detail: 'no "Requires Node X or newer" sentence found to check',
      file: 'README.md',
    }
  }
  return compare('the minimum Node version on the page', stated, pkg.engines?.node?.replace(/^>=\s*/, ''))
}

function checkNoRuntimeDeps(readme: string, pkg: Pkg): Finding {
  const names = Object.keys(pkg.dependencies ?? {})
  if (!/Zero runtime dependencies/.test(readme)) {
    return {
      level: 'warning',
      claim: 'the README states a dependency count',
      detail: 'no "Zero runtime dependencies" claim found to check',
      file: 'README.md',
    }
  }
  return {
    level: names.length === 0 ? 'pass' : 'error',
    claim: 'zero runtime dependencies',
    detail: names.length === 0 ? 'package.json declares none' : 'package.json declares ' + names.join(', '),
    file: 'README.md',
    expected: 0,
    observed: names.length,
  }
}

function checkExports(readme: string, pkg: Pkg): Finding[] {
  const shown = [...readme.matchAll(/from '(evidence-layer(?:\/[\w/-]+)?)'/g)].map((m) => m[1]!)
  if (shown.length === 0) {
    return [
      {
        level: 'warning',
        claim: 'the README shows how to import the package',
        detail: 'no import example found to check',
        file: 'README.md',
      },
    ]
  }
  const declared = new Set(
    Object.keys(pkg.exports ?? {}).map((key) => (key === '.' ? pkg.name : pkg.name + key.slice(1))),
  )
  return [...new Set(shown)].map((path): Finding => ({
    level: declared.has(path) ? 'pass' : 'error',
    claim: 'the import path `' + path + '` on the page resolves',
    detail: declared.has(path) ? 'declared in exports' : 'package.json exports has no entry for it',
    file: 'README.md',
  }))
}

/**
 * The command list on the page against the command list in the executable.
 * Read from the built CLI rather than from the source it was built from: the
 * README documents what someone installs, and what someone installs is `dist`.
 */
function checkCommands(readme: string, repo: string, pkg: Pkg): Finding {
  const claim = 'every command the README documents exists in the CLI'
  const relative = pkg.bin?.['evidence-layer']
  const documented = [...new Set([...readme.matchAll(/npx evidence-layer ([\w:-]+)/g)].map((m) => m[1]!))].sort()

  if (!relative || !existsSync(join(repo, relative))) {
    return {
      level: 'unverifiable',
      claim,
      detail: 'no built CLI at ' + (relative ?? '(no bin declared)') + ' - run `pnpm build` first',
      file: 'README.md',
    }
  }

  const usage = run('node "' + join(repo, relative) + '" --help', { cwd: repo })
  const missing = documented.filter((command) => !new RegExp('^\\s+' + command + '\\b', 'm').test(usage.output))
  return {
    level: missing.length === 0 ? 'pass' : 'error',
    claim,
    detail: missing.length === 0 ? documented.join(', ') : 'not in `--help`: ' + missing.join(', '),
    file: 'README.md',
    expected: documented,
    observed: missing.length === 0 ? documented : missing,
  }
}

/** The flagship: the number in the prose against the number the runner reports. */
function checkTestCount(readme: string, repo: string): Finding[] {
  const statedTests = /\*\*(\d+) tests\*\*/.exec(readme)?.[1]
  const statedFiles = /across \*\*(\d+) files\*\*/.exec(readme)?.[1]
  if (!statedTests) {
    return [
      {
        level: 'warning',
        claim: 'the README states a test count',
        detail: 'no "**N tests**" claim found to check',
        file: 'README.md',
      },
    ]
  }

  const result = run('pnpm test:unit', { cwd: repo, timeoutMs: 600_000 })
  const count = parseTestCount(result.output)
  if (count === null) {
    return [
      {
        level: 'unverifiable',
        claim: TEST_COUNT_CLAIM,
        detail: 'the runner printed no summary line this script recognises - it exited ' + result.exitCode,
        file: 'README.md',
      },
    ]
  }

  const findings = [compare(TEST_COUNT_CLAIM, statedTests, String(count))]
  const files = /Test Files\s+\d+ passed \((\d+)\)/.exec(result.output)?.[1]
  if (statedFiles && files) {
    findings.push(compare('the test-file count on the page is the shape of the suite', statedFiles, files))
  }
  return findings
}

/** Every repository-relative link on the page points at something that exists. */
function checkLinks(readme: string, repo: string): Finding {
  const links = [...readme.matchAll(/\]\((?!https?:)([^)#]+)\)/g)].map((m) => m[1]!)
  if (links.length === 0) {
    return {
      level: 'warning',
      claim: 'the README links to things in this repository',
      detail: 'no repository-relative links found to check',
      file: 'README.md',
    }
  }
  const broken = links.filter((link) => !existsSync(join(repo, link)))
  return {
    level: broken.length === 0 ? 'pass' : 'error',
    claim: 'every file the README links to exists',
    detail: broken.length === 0 ? links.length + ' links checked' : 'missing: ' + broken.join(', '),
    file: 'README.md',
    expected: links.length,
    observed: links.length - broken.length,
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) help(HELP)

  const here = fileURLToPath(new URL('.', import.meta.url))
  const repo = typeof args.repo === 'string' ? args.repo : join(here, '..')
  const readme = readFileSync(join(repo, 'README.md'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as Pkg

  const findings: Finding[] = [
    checkInstallName(readme, pkg),
    checkEngine(readme, pkg),
    checkNoRuntimeDeps(readme, pkg),
    ...checkExports(readme, pkg),
    checkCommands(readme, repo, pkg),
    checkLinks(readme, repo),
  ]

  findings.push(
    ...(args.fast === true
      ? [
          {
            level: 'unverifiable' as const,
            claim: TEST_COUNT_CLAIM,
            detail: 'skipped by --fast',
            file: 'README.md',
          },
        ]
      : checkTestCount(readme, repo)),
  )

  report('README claims, checked against the package', findings)
  process.exit(exitCodeFor(findings))
}

main()
