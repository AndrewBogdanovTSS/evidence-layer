/**
 * `pnpm release` - bump, tag, push, and let the workflow publish.
 *
 * The claim it makes falsifiable: **"this version is safe to publish."**
 *
 * The tag is the trigger. Pushing one starts a workflow that puts a tarball on
 * a public registry under a version number that can never be reused, so every
 * check below is one that costs seconds here and costs a yanked release or a
 * dead `0.1.1` if it runs afterwards instead. Each of them exists because it
 * actually went wrong during the first release of this package: a tag pushed
 * from a commit CI had never seen, a version that was already taken, a token
 * that was not there.
 *
 * What this deliberately does not do is publish. `pnpm publish` from a laptop
 * cannot produce a provenance attestation - npm only generates one inside a
 * supported CI provider - so a local publish would quietly ship a version that
 * is weaker than every other version, and nothing downstream would say so.
 * The tag is the handoff.
 *
 * Exit codes: 0 pushed - 1 a check failed or a step failed - 2 bad usage.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, capture, help, parseArgs, report, run, usage } from '../src/index'
import type { Finding } from '../src/index'

const HELP = `
pnpm release [<bump>] [--dry-run] [--preid <id>] [--skip-checks]

Bumps the version, commits it, tags it, and pushes - which is what starts the
release workflow. Nothing is published from here; the tag does that.

  <bump>         patch (default), minor, major, prepatch, preminor, premajor,
                 prerelease, or an exact version like 1.2.3
  --preid        prerelease identifier, e.g. --preid rc with prerelease
  --dry-run      run every check and print the plan, change nothing
  --skip-checks  skip the repository checks - for a release you already verified

exit 0 = pushed, 1 = a check or a step failed, 2 = bad usage
`

const BUMPS = ['patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'prerelease']
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
/**
 * Asked of the remote rather than written down here. A constant would be one
 * more fact about this repository that can quietly stop being true.
 */
function defaultBranch(repo: string): string {
  const head = capture('git symbolic-ref --short refs/remotes/origin/HEAD', repo)
  return head ? head.replace(/^origin\//, '') : 'master'
}

interface Pkg {
  name: string
  version: string
  repository?: { url?: string }
}

/** A finding whose level is decided by a boolean, with both outcomes spelled out. */
function verdict(ok: boolean, claim: string, passed: string, failed: string): Finding {
  return { level: ok ? 'pass' : 'error', claim, detail: ok ? passed : failed }
}

/**
 * Asks pnpm what the next version would be rather than doing semver arithmetic
 * here. A second implementation of version bumping is a second thing that can
 * disagree with the one that actually runs.
 */
function resolveTargetVersion(spec: string, preid: string | undefined, repo: string): string {
  const command =
    'pnpm version ' + spec + (preid ? ' --preid ' + preid : '') + ' --dry-run --no-git-checks'
  const result = run(command, { cwd: repo, timeoutMs: 60_000 })
  const target = /→\s*(\S+)\s*$/m.exec(result.output)?.[1]
  if (result.exitCode !== 0 || !target) {
    console.error('could not work out the target version.\n')
    console.error(result.output.trim())
    process.exit(EXIT.failed)
  }
  return target
}

/** 404 from the registry is the answer we want: nobody has taken this version. */
async function versionIsFree(name: string, version: string): Promise<Finding> {
  const claim = version + ' is not already on the registry'
  const url = 'https://registry.npmjs.org/' + name + '/' + version
  try {
    const response = await fetch(url, { method: 'GET' })
    if (response.status === 404) {
      return { level: 'pass', claim, detail: 'the registry has never seen it' }
    }
    if (response.ok) {
      return {
        level: 'error',
        claim,
        detail: 'already published - npm never lets a version number be reused, so pick another',
      }
    }
    return {
      level: 'unverifiable',
      claim,
      detail: 'the registry answered ' + response.status + ', so this could not be checked',
    }
  } catch (err) {
    // Not an error: being offline is a reason the check could not run, which is
    // not the same as the version being free, and must not be reported as one.
    return {
      level: 'unverifiable',
      claim,
      detail: 'could not reach the registry: ' + (err as Error).message,
    }
  }
}

/** Every check that has to hold before a tag is allowed to leave this machine. */
async function preflight(repo: string, pkg: Pkg, target: string, skipChecks: boolean): Promise<Finding[]> {
  const findings: Finding[] = []
  const main = defaultBranch(repo)

  const branch = capture('git rev-parse --abbrev-ref HEAD', repo)
  findings.push(
    verdict(
      branch === main,
      'the release is cut from ' + main,
      'on ' + main,
      'on ' + (branch ?? '(unknown)') + ' - the workflow builds what the tag points at, not what you meant',
    ),
  )

  const dirty = capture('git status --porcelain', repo)
  findings.push(
    verdict(
      dirty === '',
      'the working tree is clean',
      'nothing uncommitted',
      'uncommitted changes would not be in the tag, and `pnpm version` refuses to run anyway',
    ),
  )

  // Fetched rather than assumed: a stale remote ref makes the next check pass
  // by looking at yesterday's answer.
  run('git fetch origin --quiet', { cwd: repo, timeoutMs: 120_000 })
  const local = capture('git rev-parse HEAD', repo)
  const remote = capture('git rev-parse origin/' + main, repo)
  if (local && remote && local !== remote) {
    const behind = capture('git rev-list --count HEAD..origin/' + main, repo)
    const ahead = capture('git rev-list --count origin/' + main + '..HEAD', repo)
    findings.push({
      level: behind !== '0' ? 'error' : 'warning',
      claim: 'this commit is the one origin/' + main + ' has',
      detail:
        behind !== '0'
          ? behind + ' commit(s) behind origin - pull before releasing, or the tag skips them'
          : ahead + ' commit(s) ahead of origin, and they will be pushed with this release',
    })
  } else {
    findings.push({
      level: 'pass',
      claim: 'this commit is the one origin/' + main + ' has',
      detail: 'in sync',
    })
  }

  const tagged = capture('git tag -l v' + target, repo)
  findings.push(
    verdict(
      tagged === '',
      'the tag v' + target + ' does not exist yet',
      'free',
      'v' + target + ' is already a tag here - delete it deliberately or choose another version',
    ),
  )

  findings.push(await versionIsFree(pkg.name, target))

  if (skipChecks) {
    findings.push({
      level: 'unverifiable',
      claim: 'the repository checks pass',
      detail: 'skipped by --skip-checks, so nothing here knows whether they do',
    })
  } else {
    const checks = run('pnpm check:all --enforce', { cwd: repo, timeoutMs: 900_000 })
    console.log(checks.raw)
    findings.push(
      verdict(
        checks.exitCode === EXIT.ok,
        'the repository checks pass',
        '`pnpm check:all --enforce` exited 0',
        '`pnpm check:all --enforce` exited ' + checks.exitCode,
      ),
    )
  }

  return findings
}

/** Turns the repository field into the Actions URL, or says nothing rather than guessing one. */
function actionsUrl(pkg: Pkg): string | null {
  const slug = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? '')?.[1]
  return slug ? 'https://github.com/' + slug + '/actions' : null
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) help(HELP)

  const positional = args._ as string[]
  if (positional.length > 1) usage(HELP)
  const spec = positional[0] ?? 'patch'
  if (!BUMPS.includes(spec) && !EXACT_VERSION.test(spec)) usage(HELP)

  const preid = typeof args.preid === 'string' ? args.preid : undefined
  const dryRun = args['dry-run'] === true
  const skipChecks = args['skip-checks'] === true

  const here = fileURLToPath(new URL('.', import.meta.url))
  const repo = join(here, '..')
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as Pkg
  const target = resolveTargetVersion(spec, preid, repo)

  console.log('\n' + pkg.name + ' ' + pkg.version + ' → ' + target + (dryRun ? '  (dry run)' : ''))

  const findings = await preflight(repo, pkg, target, skipChecks)
  report('Before releasing ' + pkg.name + '@' + target, findings)

  if (findings.some((f) => f.level === 'error')) {
    console.log('Nothing was changed. Fix the above and run it again.\n')
    process.exit(EXIT.failed)
  }

  if (dryRun) {
    console.log('Would then run:')
    console.log('  pnpm version ' + spec + (preid ? ' --preid ' + preid : ''))
    console.log('  git push --follow-tags')
    console.log('\nNothing was changed.\n')
    process.exit(EXIT.ok)
  }

  const bump = run(
    'pnpm version ' + spec + (preid ? ' --preid ' + preid : '') + ' --message "chore(release): v%s"',
    { cwd: repo, timeoutMs: 120_000 },
  )
  console.log(bump.output)
  if (bump.exitCode !== 0) process.exit(EXIT.failed)

  // `--follow-tags` pushes the commit and the annotated tag together. Two
  // separate pushes can leave a tag behind on a failure, and a tag that never
  // arrived is a release that silently did not happen.
  const push = run('git push --follow-tags', { cwd: repo, timeoutMs: 300_000 })
  console.log(push.output)
  if (push.exitCode !== 0) {
    console.error(
      'The version is committed and tagged locally but the push failed.\n' +
        'Fix the remote and run:  git push --follow-tags\n',
    )
    process.exit(EXIT.failed)
  }

  const url = actionsUrl(pkg)
  console.log('Pushed v' + target + '. The release workflow publishes it from here.')
  if (url) console.log('Watch it: ' + url)
  console.log('')
  process.exit(EXIT.ok)
}

await main()
