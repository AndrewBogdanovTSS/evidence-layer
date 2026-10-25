/**
 * `pnpm check:docs` - does this repository's README (with its reason-code table, and the action release the example's workflow pins) still tell the truth?
 *
 * The consumer-side half of the layer, and the worked example of where the
 * line falls: every claim below is a fact about *this* package - its engine
 * range, its dependency count, its command list, its test count - which is
 * exactly why none of it can live in `src/core/`. A README is a pile of
 * assertions written once and trusted forever; this gives them a clock.
 *
 * Three outcomes, never two. A claim this script cannot evaluate (because the
 * build it would read is not on disk, or the suite run it reads printed no
 * summary) is reported `unverifiable`, which is not a pass.
 *
 * Exit codes: 0 clean - 1 at least one error - 3 flaky - 2 bad usage.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CODES, exitCodeFor, help, parseArgs, report, run, usage } from '../src/index'
import type { Finding } from '../src/index'
import { parseTestCount } from '../src/adapters/node-default'
import { ACTION_REF_FILES, findActionRefs } from './action-refs'

const HELP = `
pnpm check:docs [--repo <path>] [--fast] [--suite-output <file>]

Checks every claim README.md makes about this package against the package.

  --repo           repository root (default: the one this script lives in)
  --fast           skip the test-count claim, which has to run the suite to check it
  --suite-output   read the test count from what a suite run already printed,
                   saved to <file>, instead of running the suite again
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

/**
 * What a suite run printed, and how it ended, for the detail line when no
 * summary can be read from it.
 *
 * `check:all` runs the whole suite anyway, as a check of its own, and hands
 * what it printed over through `--suite-output`: the same vitest at the same
 * commit prints the same summary line, so running it again here only doubled
 * the slowest step of the pre-push sequence. Run alone, this script still runs
 * the suite itself - a count read from a file nobody refreshed would be a
 * claim about some earlier commit.
 */
function suiteOutput(repo: string, file: string | undefined): { output: string; ended: string } {
  if (file === undefined) {
    const result = run('pnpm test:unit', { cwd: repo, timeoutMs: 600_000 })
    return { output: result.output, ended: 'it exited ' + result.exitCode }
  }
  try {
    return { output: readFileSync(file, 'utf8'), ended: 'its output was read from ' + file }
  } catch (error) {
    // A file that is not there is not a suite that printed nothing worth
    // counting: empty output, no summary in it, `unverifiable` like any other.
    return { output: '', ended: 'could not read ' + file + ': ' + (error instanceof Error ? error.message : String(error)) }
  }
}

/** The flagship: the number in the prose against the number the runner reports. */
function checkTestCount(readme: string, repo: string, suiteOutputFile: string | undefined): Finding[] {
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

  const suite = suiteOutput(repo, suiteOutputFile)
  const count = parseTestCount(suite.output)
  if (count === null) {
    return [
      {
        level: 'unverifiable',
        claim: TEST_COUNT_CLAIM,
        detail: 'the runner printed no summary line this script recognises - ' + suite.ended,
        file: 'README.md',
      },
    ]
  }

  const findings = [compare(TEST_COUNT_CLAIM, statedTests, String(count))]
  const files = /Test Files\s+\d+ passed \((\d+)\)/.exec(suite.output)?.[1]
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

/**
 * "Supports Claude Code" is a claim about a protocol this repository does not
 * control, so the README may make it only for a host that has an adapter in
 * `src/hosts/` *and* recorded inputs in `test/fixtures/hosts/<name>/` - the
 * fixtures are what the adapter's tests run against. A host named in the
 * README's support table without both is an error; an adapter without
 * fixtures is one too, because nothing pins what it reads.
 */
function checkHostSupport(readme: string, repo: string): Finding[] {
  const hostsDir = join(repo, 'src', 'hosts')
  const adapters = existsSync(hostsDir)
    ? readdirSync(hostsDir).filter((f) => f.endsWith('.ts') && f !== 'contract.ts').map((f) => f.slice(0, -3))
    : []
  const findings: Finding[] = adapters.map((name): Finding => {
    const dir = join(repo, 'test', 'fixtures', 'hosts', name)
    const fixtures = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
    return {
      level: fixtures.length > 0 ? 'pass' : 'error',
      claim: 'the ' + name + ' adapter is pinned by recorded inputs',
      detail: fixtures.length > 0 ? fixtures.length + ' fixtures in test/fixtures/hosts/' + name : 'no fixtures in test/fixtures/hosts/' + name,
      file: 'src/hosts/' + name + '.ts',
    }
  })
  // The support table: `| <Host> | <adapter file> | ...` rows under "Supported hosts".
  const section = /## Supported hosts\n([\s\S]*?)(?:\n## |$)/.exec(readme)?.[1] ?? ''
  for (const [, host, adapter] of section.matchAll(/^\|\s*([^|]+?)\s*\|\s*`src\/hosts\/([\w-]+)\.ts`/gm)) {
    findings.push({
      level: adapters.includes(adapter!) ? 'pass' : 'error',
      claim: 'the README\'s support for ' + host + ' has an adapter behind it',
      detail: adapters.includes(adapter!) ? 'src/hosts/' + adapter + '.ts' : 'no src/hosts/' + adapter + '.ts',
      file: 'README.md',
    })
  }
  return findings
}

/**
 * The action release the README and the example's workflow tell a reader to
 * write is this package's version. A pinned ref is the right thing to show,
 * and the wrong thing to leave behind: written once, it keeps recommending the
 * release it was written in. `pnpm release` rewrites them, so on the release
 * commit and between releases they match; a bump by hand that forgets them
 * fails here, by file and line.
 */
function checkActionRefs(repo: string, pkg: Pkg): Finding[] {
  const refs = findActionRefs(repo, pkg.name)
  if (refs.length === 0) {
    return [
      {
        level: 'warning',
        claim: 'the README shows which release of the action to use',
        detail: 'no `uses: ...' + pkg.name + '@v...` line found in ' + ACTION_REF_FILES.join(' or '),
        file: 'README.md',
      },
    ]
  }
  return refs.map((ref): Finding => ({
    level: ref.version === pkg.version ? 'pass' : 'error',
    claim: 'the action ref on the page names this release',
    detail:
      ref.version === pkg.version
        ? '@v' + ref.version
        : 'names @v' + ref.version + ', package.json is ' + pkg.version + ' - `pnpm release` rewrites these, a bump by hand has to as well',
    file: ref.file,
    line: ref.line,
    expected: pkg.version,
    observed: ref.version,
  }))
}

/**
 * The reason-code table in `docs/evidence-layer.md` lists every code in
 * `src/core/codes.ts`, and nothing else. A code a consumer cannot look up is a
 * code nobody can rely on; a documented code no check produces is a promise
 * about a rule that is not there. Both directions are errors, one finding each
 * way, naming the codes.
 */
function checkCodeTable(repo: string): Finding[] {
  const file = 'docs/evidence-layer.md'
  const doc = readFileSync(join(repo, file), 'utf8')
  const section = /## Machine-readable output\n([\s\S]*?)(?:\n## |$)/.exec(doc)?.[1] ?? ''
  const documented = new Set([...section.matchAll(/^\|\s*`([a-z]+\/[a-z-]+)`\s*\|/gm)].map((m) => m[1]!))
  const registered = Object.keys(CODES)
  const undocumented = registered.filter((c) => !documented.has(c))
  const unknown = [...documented].filter((c) => !(c in CODES))
  return [
    {
      level: undocumented.length === 0 ? 'pass' : 'error',
      claim: 'every reason code is documented',
      detail: undocumented.length === 0 ? registered.length + ' codes in the table' : 'not in the table: ' + undocumented.join(', '),
      file,
    },
    {
      level: unknown.length === 0 ? 'pass' : 'error',
      claim: 'the reason-code table names only codes the checks produce',
      detail: unknown.length === 0 ? 'every row is in src/core/codes.ts' : 'not in src/core/codes.ts: ' + unknown.join(', '),
      file,
    },
  ]
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) help(HELP)
  // A bare `--suite-output` names no file; quietly running the suite instead
  // would hide that whoever passed it is not getting what they asked for.
  if (args['suite-output'] === true) usage(HELP)

  const here = fileURLToPath(new URL('.', import.meta.url))
  const repo = typeof args.repo === 'string' ? args.repo : join(here, '..')
  const suiteOutputFile = typeof args['suite-output'] === 'string' ? args['suite-output'] : undefined
  const readme = readFileSync(join(repo, 'README.md'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as Pkg

  const findings: Finding[] = [
    checkInstallName(readme, pkg),
    checkEngine(readme, pkg),
    checkNoRuntimeDeps(readme, pkg),
    ...checkExports(readme, pkg),
    checkCommands(readme, repo, pkg),
    checkLinks(readme, repo),
    ...checkHostSupport(readme, repo),
    ...checkActionRefs(repo, pkg),
    ...checkCodeTable(repo),
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
      : checkTestCount(readme, repo, suiteOutputFile)),
  )

  report('README claims, checked against the package', findings)
  process.exit(exitCodeFor(findings))
}

main()
